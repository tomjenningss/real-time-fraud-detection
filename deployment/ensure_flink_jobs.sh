#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"

manifest="$repo_dir/.runtime/flink-savepoints.env"
java_savepoint=
sql_savepoint=
if [ -f "$manifest" ]; then
  java_savepoint=$(awk -F= '$1 == "JAVA_SAVEPOINT" {print substr($0, index($0, "=") + 1)}' "$manifest")
  sql_savepoint=$(awk -F= '$1 == "SQL_SAVEPOINT" {print substr($0, index($0, "=") + 1)}' "$manifest")
fi

attempt=0
plan_output="$repo_dir/.runtime/flink-plan.stdout"
plan_error="$repo_dir/.runtime/flink-plan.stderr"
plan_status=0
while [ "$attempt" -lt 30 ]; do
  if compose run --rm --no-deps platform-cli \
    python /flink-scripts/flink_jobs.py plan --url http://jobmanager:8081 \
      >"$plan_output" 2>"$plan_error"
  then
    # podman-compose can allocate a TTY for `run`, producing CRLF, and Podman's
    # external-provider notice can share stdout with the container. Accept only
    # the planner's exact identifiers after removing carriage returns.
    missing=$(tr -d '\r' <"$plan_output" | awk '$0 == "java" || $0 == "sql"')
    rm -f "$plan_output" "$plan_error"
    break
  else
    plan_status=$?
  fi
  attempt=$((attempt + 1))
  sleep 2
done
if [ "$attempt" -ge 30 ]; then
  echo "Flink planning failed with status $plan_status after the cluster readiness window. Last error:" >&2
  sed 's/^/  /' "$plan_error" >&2
  rm -f "$plan_output" "$plan_error"
  exit 1
fi

java_mode=already-running
sql_mode=already-running
case "
$missing
" in
  *"
java
"*)
    if [ -n "$java_savepoint" ]; then
      if compose exec -T -e ENRICHMENT_STARTUP_MODE=latest jobmanager \
        /opt/flink/bin/flink run -d -s "$java_savepoint" \
        /opt/flink/usrlib/transaction-enrichment.jar
      then :
      else
        result=$?
        echo "Java Flink job submission failed with status $result" >&2
        exit "$result"
      fi
      java_mode="restored:$java_savepoint"
    else
      if compose exec -T -e ENRICHMENT_STARTUP_MODE=latest jobmanager \
        /opt/flink/bin/flink run -d /opt/flink/usrlib/transaction-enrichment.jar
      then :
      else
        result=$?
        echo "Java Flink job submission failed with status $result" >&2
        exit "$result"
      fi
      java_mode=fresh
    fi
    ;;
esac

case "
$missing
" in
  *"
sql
"*)
    if [ -n "$sql_savepoint" ]; then
      if compose run --rm --entrypoint /opt/flink/bin/sql-client.sh sql-client \
        embedded -Drest.address=jobmanager -Drest.port=8081 \
        -Dexecution.savepoint.path="$sql_savepoint" -f /workspace/sql/fraud_signals.sql
      then :
      else
        result=$?
        echo "SQL Flink job submission failed with status $result" >&2
        exit "$result"
      fi
      sql_mode="restored:$sql_savepoint"
    else
      if compose run --rm --entrypoint /opt/flink/bin/sql-client.sh sql-client \
        embedded -Drest.address=jobmanager -Drest.port=8081 \
        -f /workspace/sql/fraud_signals.sql
      then :
      else
        result=$?
        echo "SQL Flink job submission failed with status $result" >&2
        exit "$result"
      fi
      sql_mode=fresh
    fi
    ;;
esac

attempt=0
while [ "$attempt" -lt 30 ]; do
  if compose run --rm --no-deps platform-cli \
    python /flink-scripts/flink_jobs.py check --url http://jobmanager:8081
  then
    {
      echo "java=$java_mode"
      echo "sql=$sql_mode"
      date -u '+verified_at=%Y-%m-%dT%H:%M:%SZ'
    } >"$repo_dir/.runtime/flink-start-status"
    if [ -f "$manifest" ]; then
      mv "$manifest" "$repo_dir/.runtime/flink-savepoints.applied.env"
    fi
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done
echo "Required Flink jobs did not both become RUNNING" >&2
exit 1

