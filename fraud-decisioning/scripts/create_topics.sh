#!/bin/sh
set -eu

compose_file=${FLINK_COMPOSE_FILE:-../confluent-flink/compose.yaml}
for topic in \
  fraud.decisions.demo \
  fraud.investigations.requested \
  fraud.investigations.completed \
  fraud.assessments.correlated.demo \
  fraud.assessments.dlq \
  fraud.decisions.shadow.demo \
  fraud.decisions.shadow.dlq \
  fraud.decisions.dlq \
  fraud.investigations.dlq
do
  podman compose -f "$compose_file" exec -T kafka kafka-topics \
    --bootstrap-server kafka:29092 --create --if-not-exists \
    --topic "$topic" --partitions 1 --replication-factor 1
done
