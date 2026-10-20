#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

jar=target/transaction-enrichment-1.0.0-all.jar
missing=$(python3 scripts/flink_jobs.py plan)
[ -n "$missing" ] || exec python3 scripts/flink_jobs.py check

case "
$missing
" in
  *"
java
"*)
    if [ ! -f "$jar" ]; then
      echo "Missing $jar; run scripts/build_enrichment.sh first." >&2
      exit 2
    fi
    jobmanager_id=$(podman compose ps -q jobmanager)
    podman cp "$jar" "$jobmanager_id:/tmp/transaction-enrichment.jar"
    podman compose exec -T -e ENRICHMENT_STARTUP_MODE=latest jobmanager \
      /opt/flink/bin/flink run -d /tmp/transaction-enrichment.jar
    ;;
esac

case "
$missing
" in
  *"
sql
"*)
    podman compose run --rm --entrypoint /opt/flink/bin/sql-client.sh sql-client \
      embedded -Drest.address=jobmanager -Drest.port=8081 -f /workspace/sql/fraud_signals.sql
    ;;
esac

attempt=0
while [ "$attempt" -lt 30 ]; do
  if python3 scripts/flink_jobs.py check; then
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done
echo "Expected Flink jobs did not both become RUNNING within 60 seconds." >&2
exit 1
