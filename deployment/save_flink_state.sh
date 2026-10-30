#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"

ids=$(compose run --rm --no-deps platform-cli \
  python /flink-scripts/flink_jobs.py ids --url http://jobmanager:8081)
java_id=$(printf '%s\n' "$ids" | awk -F= '$1 == "java" {print $2}')
sql_id=$(printf '%s\n' "$ids" | awk -F= '$1 == "sql" {print $2}')
case "$java_id$sql_id" in *[!0-9a-f]*) echo "Invalid Flink job ID" >&2; exit 1 ;; esac

savepoint() {
  job_id=$1
  output=$(compose exec -T jobmanager /opt/flink/bin/flink savepoint \
    "$job_id" file:///checkpoints/savepoints)
  printf '%s\n' "$output" >&2
  path=$(printf '%s\n' "$output" | sed -n 's/^Savepoint completed\. Path: //p' | tail -n 1)
  if [ -z "$path" ]; then
    echo "Flink did not return a completed savepoint path for $job_id" >&2
    return 1
  fi
  printf '%s\n' "$path"
}

java_path=
sql_path=
[ -z "$java_id" ] || java_path=$(savepoint "$java_id")
[ -z "$sql_id" ] || sql_path=$(savepoint "$sql_id")
if [ -z "$java_path$sql_path" ]; then
  echo "No RUNNING Flink jobs required a savepoint"
  exit 0
fi
umask 077
tmp="$repo_dir/.runtime/flink-savepoints.env.tmp.$$"
{
  [ -z "$java_path" ] || echo "JAVA_SAVEPOINT=$java_path"
  [ -z "$sql_path" ] || echo "SQL_SAVEPOINT=$sql_path"
  date -u '+SAVED_AT=%Y-%m-%dT%H:%M:%SZ'
} >"$tmp"
mv "$tmp" "$repo_dir/.runtime/flink-savepoints.env"
echo "Recorded recoverable Flink savepoints"

