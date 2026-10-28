#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 TOPIC" >&2
  exit 2
fi
case "$1" in
  fraud.decisions.demo|fraud.investigations.requested|fraud.investigations.completed|fraud.assessments.correlated.demo|fraud.assessments.dlq|fraud.decisions.shadow.demo|fraud.decisions.shadow.dlq|fraud.decisions.dlq|fraud.investigations.dlq) ;;
  *) echo "unsupported Part 3 topic" >&2; exit 2 ;;
esac
compose_file=${FLINK_COMPOSE_FILE:-../confluent-flink/compose.yaml}
podman compose -f "$compose_file" exec -T kafka kafka-console-consumer \
  --bootstrap-server kafka:29092 --topic "$1" --from-beginning \
  --timeout-ms 5000 --max-messages "${MAX_MESSAGES:-20}"
