#!/bin/sh
set -u
. "$(dirname -- "$0")/common.sh"

failures=0
echo "Compose project: $project"
echo "Containers (HTTP readiness is checked separately below):"
compose ps --all

check_health() {
  service=$1
  label=$2
  id=$(service_container_id "$service")
  if [ -z "$id" ]; then
    echo "$label: MISSING"
    failures=$((failures + 1))
    return
  fi
  state=$(podman inspect --format '{{.State.Status}}' "$id")
  health=$(podman inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}' "$id")
  echo "$label: container=$state healthcheck=$health"
  if [ "$state" != running ]; then
    failures=$((failures + 1))
  elif [ "$health" != healthy ] && [ "$health" != not-configured ]; then
    failures=$((failures + 1))
  fi
}

check_health kafka Kafka
check_health postgres PostgreSQL
check_health jobmanager "Flink JobManager"
check_health taskmanager "Flink TaskManager"
check_health fraud-router "Python router"
check_health outbox-publisher "Python outbox publisher"
check_health lightgbm-scorer "LightGBM scorer"
check_health fraud-assessment-correlator "Go assessment correlator"
check_health fraud-decision-engine "Go shadow decision engine"

if compose exec -T kafka kafka-broker-api-versions --bootstrap-server kafka:29092 >/dev/null 2>&1; then
  echo "Kafka protocol readiness: ready"
else
  echo "Kafka protocol readiness: unavailable"
  failures=$((failures + 1))
fi

if compose exec -T postgres pg_isready -U "$(env_value POSTGRES_USER)" -d "$(env_value POSTGRES_DB)" >/dev/null 2>&1; then
  echo "PostgreSQL protocol readiness: ready"
else
  echo "PostgreSQL protocol readiness: unavailable"
  failures=$((failures + 1))
fi

if compose run --rm --no-deps platform-cli \
  python /flink-scripts/flink_jobs.py check --url http://jobmanager:8081
then
  echo "Flink required jobs: RUNNING (historical failed jobs ignored)"
else
  echo "Flink required jobs: not ready"
  failures=$((failures + 1))
fi

if [ -f "$repo_dir/.runtime/flink-start-status" ]; then
  echo "Last Flink start evidence:"
  sed 's/^/  /' "$repo_dir/.runtime/flink-start-status"
fi

correlator_port=$(env_value CORRELATOR_HOST_PORT)
engine_port=$(env_value SHADOW_ENGINE_HOST_PORT)
if curl -fsS "http://127.0.0.1:$correlator_port/readyz" >/dev/null 2>&1; then
  echo "Go assessment correlator HTTP readiness: ready"
else
  echo "Go assessment correlator HTTP readiness: unavailable"
  failures=$((failures + 1))
fi
if curl -fsS "http://127.0.0.1:$engine_port/readyz" >/dev/null 2>&1; then
  echo "Go shadow decision engine HTTP readiness: ready"
else
  echo "Go shadow decision engine HTTP readiness: unavailable"
  failures=$((failures + 1))
fi

echo "Consumer group offsets and lag (a group can be ready before its first committed record):"
for group in \
  fraud-platform-dev-router-v1 \
  fraud-platform-dev-lightgbm-v1 \
  fraud-platform-dev-correlator-v1 \
  fraud-platform-dev-decision-engine-v1 \
  flink-transaction-enrichment-v1 \
  flink-fraud-analytics-v1
do
  compose exec -T kafka kafka-consumer-groups \
    --bootstrap-server kafka:29092 --describe --group "$group" 2>/dev/null || true
done

if [ "$failures" -ne 0 ]; then
  echo "Platform has $failures failed readiness check(s)" >&2
  exit 1
fi
echo "All required development deployment components are ready"

