#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"

ids_output="$repo_dir/.runtime/flink-ids.stdout"
ids_error="$repo_dir/.runtime/flink-ids.stderr"
if compose run --rm --no-deps platform-cli \
  python /flink-scripts/flink_jobs.py ids --url http://jobmanager:8081 \
    >"$ids_output" 2>"$ids_error"
then :
else
  result=$?
  echo "Could not resolve both required RUNNING Flink jobs (status $result)." >&2
  sed 's/^/  /' "$ids_error" >&2
  rm -f "$ids_output" "$ids_error"
  exit "$result"
fi

ids=$(tr -d '\r' <"$ids_output" | awk -F= '
  NF == 2 && ($1 == "java" || $1 == "sql") { print }
')
rm -f "$ids_output" "$ids_error"
java_id=$(printf '%s\n' "$ids" | awk -F= '$1 == "java" {print $2}')
sql_id=$(printf '%s\n' "$ids" | awk -F= '$1 == "sql" {print $2}')

valid_job_id() {
  job_id=$1
  [ "${#job_id}" -eq 32 ] || return 1
  case "$job_id" in *[!0-9a-f]*) return 1 ;; esac
}

if ! valid_job_id "$java_id"; then
  echo "Per-transaction behavioural enrichment: missing or invalid RUNNING job ID" >&2
  exit 1
fi
if ! valid_job_id "$sql_id"; then
  echo "Fraud SQL signals analytics: missing or invalid RUNNING job ID" >&2
  exit 1
fi
if [ "$java_id" = "$sql_id" ]; then
  echo "Required Flink jobs unexpectedly resolved to the same job ID: $java_id" >&2
  exit 1
fi
echo "Resolved RUNNING Flink job: Per-transaction behavioural enrichment ($java_id)"
echo "Resolved RUNNING Flink job: Fraud SQL signals analytics ($sql_id)"

savepoint() {
  job_key=$1
  job_name=$2
  job_id=$3
  output_file="$repo_dir/.runtime/flink-savepoint-$job_key.stdout"
  error_file="$repo_dir/.runtime/flink-savepoint-$job_key.stderr"
  echo "Creating savepoint: $job_name ($job_id)" >&2
  if compose exec -T jobmanager /opt/flink/bin/flink savepoint \
    "$job_id" file:///checkpoints/savepoints >"$output_file" 2>"$error_file"
  then :
  else
    result=$?
    echo "Savepoint failed: $job_name ($job_id), status $result" >&2
    sed 's/^/  /' "$output_file" >&2
    sed 's/^/  /' "$error_file" >&2
    rm -f "$output_file" "$error_file"
    return "$result"
  fi
  output=$(tr -d '\r' <"$output_file")
  rm -f "$output_file" "$error_file"
  printf '%s\n' "$output" >&2
  path=$(printf '%s\n' "$output" | sed -n 's/^Savepoint completed\. Path: //p' | tail -n 1)
  if [ -z "$path" ]; then
    echo "Flink did not return a completed savepoint path for $job_name ($job_id)" >&2
    return 1
  fi
  case "$path" in
    file:/checkpoints/savepoints/*|file:///checkpoints/savepoints/*) ;;
    *)
      echo "Flink returned an unexpected savepoint location for $job_name: $path" >&2
      return 1
      ;;
  esac
  local_path=${path#file:}
  if ! compose exec -T jobmanager test -d "$local_path"; then
    echo "Savepoint path was not found in checkpoint storage for $job_name: $path" >&2
    return 1
  fi
  echo "Verified savepoint: $job_name -> $path" >&2
  printf '%s\n' "$path"
}

java_path=$(savepoint java "Per-transaction behavioural enrichment" "$java_id")
sql_path=$(savepoint sql "Fraud SQL signals analytics" "$sql_id")
umask 077
tmp="$repo_dir/.runtime/flink-savepoints.env.tmp.$$"
{
  echo "JAVA_SAVEPOINT=$java_path"
  echo "SQL_SAVEPOINT=$sql_path"
  date -u '+SAVED_AT=%Y-%m-%dT%H:%M:%SZ'
} >"$tmp"
mv "$tmp" "$repo_dir/.runtime/flink-savepoints.env"
echo "Recorded recoverable Flink savepoints"

