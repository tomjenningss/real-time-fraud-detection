# Kafka/Flink fraud evidence pipelines

This project runs two independent streaming evidence jobs. Neither job makes a payment decision.

```text
payments.raw.demo ──┬── Flink SQL hopping windows ──> fraud.signals.demo
                   └── DataStream keyed state ─────> payments.enriched.demo
```

The existing SQL job produces window-level alerts and remains unchanged. The DataStream job produces one append-only behavioural assessment for each accepted transaction, suitable for a future Claude Behaviour Agent. A later Action Agent must apply policy before producing `APPROVED`, `BLOCKED`, or `CHALLENGED` decisions.

## Topics and schemas

- `payments.raw.demo`: input JSON with `transaction_id`, `user_id`, `merchant_id`, `amount`, `device_id`, `payment_channel`, and UTC `event_time` (`yyyy-MM-dd HH:mm:ss.SSS`).
- `fraud.signals.demo`: existing, potentially repeated window-level alerts from overlapping two-minute windows.
- `payments.enriched.demo`: transaction-level assessments from the new job.

An enriched record contains the original transaction identity and amount, UTC transaction and assessment timestamps, exact rolling `transactions_1m`, `transactions_2m`, `transactions_10m`, `distinct_merchants_2m`, `total_amount_2m`, all qualifying `signals`, stable `signal_ids`, `risk_level`, and `evidence_source: flink`.

`HIGH_VELOCITY` means at least five transactions in the inclusive two-minute interval ending at the current transaction. `MERCHANT_HOPPING` requires the same five-transaction minimum and at least four distinct merchants. Both signals are retained. Amount alone is never a signal. `HIGH` means one or more prototype signals are present and `LOW` means none are present; these labels are evidence severity, not payment verdicts. Under this evidence contract, merchant hopping necessarily co-occurs with high velocity.

## Why DataStream

Flink SQL hopping windows correctly serve the existing window analytics, but Flink SQL 1.20 does not provide a simple append-only solution for per-input rolling distinct counts plus transaction-ID deduplication and multi-signal arrays. SQL interval/over-window approaches also tend to produce updates or completed-window results. The small DataStream job uses event-time timers and keyed managed state directly, which provides one normal-operation output per accepted event.

## Event-time, duplicates, and bounded state

- Events are keyed by `user_id`. The source watermark allows two seconds of out-of-order arrival. Accepted records are buffered until the watermark passes their event time, then evaluated in event-time order. Equal timestamps are ordered by `transaction_id` for reproducibility.
- An event arriving at or behind the current watermark is too late. It produces no assessment and is written to the TaskManager log under `late-transaction`; the append-only history is not revised.
- A repeated `transaction_id` for the same user is ignored and does not affect counts. IDs are retained for 10 minutes plus the two-second lateness allowance. Producers must treat `(transaction_id, user_id)` as immutable. Reuse outside the retention horizon is treated as a new event.
- Rolling history is pruned after 10 minutes as event time advances. State can remain until the stream watermark advances; the watermark-marker fixture is only needed for finite tests.
- The Kafka sink is deliberately configured for at-least-once delivery. Checkpoints run every 10 seconds with one concurrent checkpoint and JobManager checkpoint storage suitable for local development. A failure around a checkpoint can replay output, so consumers must deduplicate by `transaction_id`; no end-to-end exactly-once claim is made.

## Signal consolidation contract

`payments.enriched.demo` has `assessment_type: transaction`. Its durable investigation key is `transaction_id`; individual evidence keys are `signal_ids` such as `txn:tx-006:HIGH_VELOCITY`. Future orchestration should start at most one investigation per transaction ID and merge all signal IDs from that assessment.

`fraud.signals.demo` contains `window_start`, `window_end`, and `signal_type` and represents window-level analytics. Because overlapping windows intentionally repeat evidence, consumers should use `(user_id, signal_type, window_start, window_end)` as an alert identity and coalesce alerts for the same user/rule over a configurable incident interval. Window alerts must not be mistaken for transaction assessments.

## Build and deploy

The image build includes the Kafka SQL connector and the enrichment job:

```sh
podman compose build
```

Recreating existing containers to adopt that image can affect running jobs, so inspect them first and
only do so during an approved restart. Build the Java artifact with an ephemeral Maven container:

```sh
scripts/build_enrichment.sh
```

Deploy both jobs idempotently and check their health:

```sh
scripts/ensure_jobs.sh
scripts/check_jobs.sh
```

`ensure_jobs.sh` leaves an exact `RUNNING` job untouched and refuses duplicate-name or non-running
name collisions. It never cancels jobs, restarts containers, creates topics, or changes Kafka offsets.

Both sources deliberately use a stateless demo start at Kafka's end: Java receives
`ENRICHMENT_STARTUP_MODE=latest`, and SQL uses `latest-offset`. Existing group offsets and historical
records are ignored. This is not state restoration: rolling counts, deduplication maps, watermarks,
timers and SQL windows begin empty, and payments produced while jobs are absent are skipped.

## Safe Part 3 bootstrap boundary

Keep the router, outbox publisher and investigation worker stopped while ensuring Flink jobs. Once
both jobs are `RUNNING`, capture the enriched-topic boundary:

```sh
scripts/capture_topic_boundary.sh payments.enriched.demo
```

Configure the stable router group with that value:

```text
ROUTER_GROUP_ID=fraud-decision-router-v1
ROUTER_AUTO_OFFSET_RESET=latest
ROUTER_EXPECTED_START_OFFSETS=0:<captured-offset>
```

On first start, the router waits for assignment and initialized positions and refuses to run unless
they match the boundary. Publish the fixture only after its `router_ready` event. Once this group has
committed offsets, later restarts resume them; the initial boundary is not reapplied.

Generate a unique near-real-time fixture after router readiness:

```sh
python3 scripts/generate_controlled_scenario.py --run-id "$(date -u +%Y%m%dT%H%M%SZ)"
```

## Generate and inspect data

```sh
python3 scripts/generate_payments.py
podman compose exec -T kafka kafka-console-consumer \
  --bootstrap-server kafka:29092 --topic payments.enriched.demo \
  --partition 0 --offset 0
```

Example fields for the sixth same-merchant payment are:

```json
{"assessment_type":"transaction","transaction_id":"velocity-5","transactions_1m":6,"transactions_2m":6,"transactions_10m":6,"distinct_merchants_2m":1,"signals":["HIGH_VELOCITY"],"signal_ids":["txn:velocity-5:HIGH_VELOCITY"],"risk_level":"HIGH","evidence_source":"flink"}
```

## Browse Kafka with Control Center

The Compose stack includes Confluent Control Center 2.6.0 in reduced-infrastructure (`management`)
mode. It connects to Kafka at `kafka:29092`; Prometheus monitoring and alerting are disabled.
Schema Registry integration is also disabled because this stack does not run Schema Registry. This
mode provides Kafka management and topic message inspection without Schema Registry, Prometheus,
Alertmanager, or ZooKeeper.

Start only Control Center, without starting or recreating its dependencies:

```sh
podman compose up -d --no-deps control-center
```

Open [http://localhost:9021](http://localhost:9021), select the Kafka cluster, then open
**Topics**, select a topic, and use its **Messages** view. Useful project topics include
`payments.raw.demo`, `payments.enriched.demo`, `fraud.signals.demo`,
`fraud.investigations.requested`, and `fraud.investigations.completed`.

Inspect status and startup logs:

```sh
podman compose ps control-center
podman compose logs --tail=200 control-center
```

Stop only Control Center (its container is retained):

```sh
podman compose stop control-center
```

Control Center requires a Confluent Enterprise license after its 30-day trial. Do not use
`podman compose down -v`; the existing `kafka-data` volume contains retained Kafka data.

## Tests

Run fast generator/unit tests and the Maven build:

```sh
python3 -m unittest discover -s tests -v
scripts/build_enrichment.sh
```

With the enrichment job running, execute Kafka-to-Kafka acceptance tests. Every run uses a random transaction/user prefix, so retained topic history does not alter assertions:

```sh
RUN_ENRICHMENT_INTEGRATION=1 python3 -m unittest tests.test_enrichment_integration -v
```

The integration tests publish real Kafka records and consume actual enriched messages. They cover normal £100–£150 payments, velocity, merchant hopping, simultaneous signals, duplicate IDs, user isolation, and bounded out-of-order arrival.

## Known limitations

- The two-second lateness allowance is a prototype policy. Later data is logged, not corrected or routed to a durable dead-letter topic.
- Transaction-ID deduplication is scoped to the immutable user ID and bounded retention horizon. Cross-user reuse violates the producer contract.
- At-least-once recovery can duplicate Kafka output; downstream consumers must use the stable transaction ID.
- Checkpoints remain JobManager-local and are not restored after a full cluster restart.
- A missing job starts at Kafka's current end and deliberately skips downtime/history. Rolling state,
  timers, deduplication state, windows and watermarks are not restored.
- Never generate a new Part 3 router group automatically. Bootstrap its stable group once at an
  explicitly captured enriched-topic boundary.
