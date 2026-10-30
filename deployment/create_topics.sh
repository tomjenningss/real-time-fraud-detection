#!/bin/sh
set -eu
. "$(dirname -- "$0")/common.sh"

for topic in \
  payments.raw.demo \
  payments.enriched.demo \
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
echo "Kafka topics are present"

