#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

jar=target/transaction-enrichment-1.0.0-all.jar
if [ ! -f "$jar" ]; then
  echo "Missing $jar; run scripts/build_enrichment.sh first." >&2
  exit 1
fi

echo "Active Flink jobs (none will be stopped or replaced):"
podman compose exec -T jobmanager /opt/flink/bin/flink list || true

podman compose exec -T kafka kafka-topics --bootstrap-server kafka:29092 \
  --create --if-not-exists --topic payments.enriched.demo --partitions 1 --replication-factor 1

jobmanager_id=$(podman compose ps -q jobmanager)
podman cp "$jar" "$jobmanager_id:/tmp/transaction-enrichment.jar"
podman compose exec -T jobmanager /opt/flink/bin/flink run -d \
  /tmp/transaction-enrichment.jar
