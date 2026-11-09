#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"

for topic in \
  payments.raw.demo \
  payments.enriched.demo \
  payments.raw.slow-building-replay \
  payments.enriched.slow-building-replay \
  fraud.decisions.slow-building-replay \
  fraud.investigations.slow-building-replay \
  fraud.decisions.slow-building-replay.dlq \
  fraud.signals.demo \
  fraud.decisions.demo \
  fraud.investigations.requested \
  fraud.investigations.completed \
  fraud.risk.baseline.demo \
  fraud.assessments.correlated.demo \
  fraud.assessments.dlq \
  fraud.decisions.shadow.demo \
  fraud.decisions.shadow.dlq \
  fraud.decisions.dlq \
  fraud.investigations.dlq
do
  compose exec -T kafka kafka-topics \
    --bootstrap-server kafka:29092 \
    --create --if-not-exists \
    --topic "$topic" --partitions 1 --replication-factor 1 >/dev/null
done

# Accelerated replay carries its weeks-apart event time inside the canonical JSON
# payload. Kafka broker timestamps remain wall-clock append time so future event-time
# records are accepted without relaxing timestamp validation for ordinary topics.
compose exec -T kafka kafka-configs \
  --bootstrap-server kafka:29092 \
  --alter --entity-type topics --entity-name payments.enriched.slow-building-replay \
  --add-config message.timestamp.type=LogAppendTime >/dev/null
echo "Kafka topics are present"

