# Fraud Assessment Correlator

This standalone Go service asynchronously combines existing deterministic decisions, experimental
LightGBM scores, and Claude investigation lifecycle events. It is deliberately outside payment
authorisation: assessments describe what the components reported and never update the immutable
payment verdict.

## Contracts and behaviour

The service consumes `fraud.decisions.demo`, `fraud.risk.baseline.demo`,
`fraud.investigations.requested`, and `fraud.investigations.completed`, correlating their actual
version `1.0.0` contracts by `transaction_id`. It publishes every meaningful revision, keyed by
`transaction_id`, to `fraud.assessments.correlated.demo`.

An assessment can start with any component. `PARTIAL` means one of the deterministic or ML branches
has not arrived. `PENDING_INVESTIGATION` is used only when the deterministic event explicitly says an
investigation is required and no completion is present. `COMPLETE` means both deterministic and ML
components are present and any explicitly required investigation completed. Absence of a request is
never represented as “not requested.”

The current Kafka lifecycle has no investigation failure or timeout event. Consequently, the model
does not infer either state from elapsed time or PostgreSQL. The smallest contract extension is a new
`fraud.investigations.status` v1 event containing `event_id`, `transaction_id`, `investigation_id`,
`status`, `occurred_at`, and a sanitized `failure_type`; the existing investigation store should emit
it transactionally when an attempt becomes terminal.

## Durable processing

Migration `0004_assessment_correlator` adds:

- `fraud_assessment_source_events`: source-event deduplication and provenance;
- `fraud_assessments_latest`: latest snapshot per transaction;
- `fraud_assessment_history`: append-only meaningful revisions;
- `fraud_assessment_outbox`: retryable Kafka publications;
- `fraud_assessment_rejected_events`: sanitized poison-record audit.

Assessment outbox revisions start at one. Revision zero is reserved for DLQ publications, which do
not represent an assessment revision.

Each input is handled in one PostgreSQL transaction. A transaction-scoped advisory lock prevents lost
updates. Kafka offsets advance only after the database commit. The outbox marks a row published only
after Kafka acknowledges it. A crash in that final window can create a physical duplicate, so consumers
must deduplicate with `assessment_id` plus `revision` (or the stable `event_id` header). This is
at-least-once publication, not cross-system exactly-once delivery.

## Run locally

Prerequisites are Go 1.24+, the existing Kafka/PostgreSQL services, and the Alembic environment in
`agents/`. Do not reset offsets or volumes.

```sh
cd agents
DATABASE_URL=... .venv/bin/alembic upgrade head
cd ../fraud-decisioning
sh scripts/create_topics.sh
cd ../fraud-assessment-correlator
DATABASE_URL=... KAFKA_BOOTSTRAP_SERVERS=localhost:9092 go run ./cmd/correlator
```

Or start only the additive Compose profile after Kafka is running in the shared `part3` project:

```sh
cd fraud-decisioning
podman compose --env-file .env --profile correlator up -d --build fraud-assessment-correlator
```

The Compose service joins both `part3_default` for PostgreSQL and the existing external
`confluent-flink_default` network for Kafka. It uses the broker's internal `kafka:29092` listener;
native processes should use `127.0.0.1:9092`. Do not change listeners or recreate either stateful
service to start the correlator.

Liveness is `http://localhost:8082/healthz`; `/readyz` checks PostgreSQL and Kafka. Configuration is
through the following variables:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | Comma-separated Kafka bootstrap servers |
| `CORRELATOR_GROUP_ID` | `fraud-assessment-correlator-v1` | Stable consumer group |
| `CORRELATOR_AUTO_OFFSET_RESET` | `earliest` | Initial position only when the group has no committed offset |
| `HTTP_PORT` | `8080` | Container/native HTTP listen port |

`earliest` is deliberate: a new group reconstructs assessments from every retained component event,
including valid ML-only partial assessments. Restarts use committed offsets and do not replay the
log. Changing the reset policy does not move an established group; never reset the group merely to
obtain a test result. Check the retained boundaries before the first start:

```sh
podman compose -f ../confluent-flink/compose.yaml exec -T kafka kafka-get-offsets \
  --bootstrap-server kafka:29092 \
  --topic fraud.decisions.demo,fraud.risk.baseline.demo,fraud.investigations.requested,fraud.investigations.completed \
  --time earliest
podman compose -f ../confluent-flink/compose.yaml exec -T kafka kafka-get-offsets \
  --bootstrap-server kafka:29092 \
  --topic fraud.decisions.demo,fraud.risk.baseline.demo,fraud.investigations.requested,fraud.investigations.completed \
  --time latest
```

## Inspect assessments

```sql
SELECT transaction_id, revision, assessment->>'completeness', updated_at
FROM fraud_assessments_latest ORDER BY updated_at DESC;
SELECT transaction_id, revision, source_event_id,
       assessment->>'completeness' AS completeness, created_at
FROM fraud_assessment_history
WHERE transaction_id = '<transaction-id>' ORDER BY revision;
SELECT event_kind, event_id, source_topic, source_partition, source_offset, valid
FROM fraud_assessment_source_events
WHERE transaction_id = '<transaction-id>' ORDER BY consumed_at;
SELECT transaction_id, revision, status, attempts, published_at
FROM fraud_assessment_outbox ORDER BY created_at DESC;
SELECT source_topic, source_partition, source_offset, rejection_reason
FROM fraud_assessment_rejected_events ORDER BY rejected_at DESC;
```

Inspect Kafka with:

```sh
cd fraud-decisioning
MAX_MESSAGES=100 sh scripts/inspect_topic.sh fraud.assessments.correlated.demo
MAX_MESSAGES=20 sh scripts/inspect_topic.sh fraud.assessments.dlq
```

## Controlled end-to-end scenario

Ensure both Flink jobs are `RUNNING`, the stable router and investigation-worker groups are ready at
their documented boundaries, the LightGBM shadow scorer is enabled, and the Python outbox publisher
is running. Keep the investigation worker in dry-run mode unless paid live execution has been
separately approved. Then publish a unique real fixture:

```sh
cd confluent-flink
python3 scripts/generate_controlled_scenario.py --run-id "$(date -u +%Y%m%dT%H%M%SZ)"
```

The fixture produces 16 logical transactions: 11 approved, two challenged, three blocked, and five
investigation requests. Follow its `controlled-<run-id>-...` transaction IDs through
`payments.enriched.demo`, the component topics, the PostgreSQL queries above, and
`fraud.assessments.correlated.demo`. Transactions selected for investigation should normally have
four revisions; ordinary transactions should have two. A missing completion leaves a useful
`PENDING_INVESTIGATION` assessment and does not invent a timeout or failure.

## Recovery and troubleshooting

- The consumer commits each Kafka record only after its database transaction. A database or offset
  commit failure terminates the process so `restart: unless-stopped` resumes at the last committed
  offset instead of advancing an in-memory fetch position past an unprocessed record.
- Outbox claims expire after 30 seconds. An interrupted publisher is reclaimed and retried with the
  same stable outbox/event identity; a crash after Kafka acknowledgement can still create a physical
  duplicate.
- Malformed records are recorded in `fraud_assessment_rejected_events`, published to
  `fraud.assessments.dlq`, and then committed so subsequent valid records are not blocked.
- A source-position uniqueness error usually means an integration fixture used a live topic/offset.
  Integration tests use `integration.*` source topics and must clean up their rows before closing the
  database pool.
- If `/healthz` succeeds but `/readyz` fails, inspect `podman compose logs fraud-assessment-correlator`,
  confirm membership in both Compose networks, and test PostgreSQL/Kafka independently. Do not reset
  offsets or recreate volumes.
- Native librdkafka clients may briefly log a failed `localhost:9092` metadata connection before
  recovering. Use `127.0.0.1:9092`; the containerized correlator must use `kafka:29092`.

## Tests

```sh
go test ./...
go vet ./...
CORRELATOR_POSTGRES_INTEGRATION=1 DATABASE_URL=... go test ./internal/store
```

Unit coverage includes all four repository contracts, ML-first partial correlation, incremental and
out-of-order updates, duplicates, revisions, malformed input, and immutable deterministic verdicts.
The PostgreSQL suite also covers durable deduplication, DLQ outbox creation, and expired-claim
recovery. Infrastructure acceptance is intentionally opt-in and must not recreate volumes or reset
offsets. Run it against an isolated migrated database, or stop the correlator publisher for the
bounded test so it cannot race the temporary rows.
