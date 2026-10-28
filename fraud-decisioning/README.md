# Part 3: deterministic decisioning and asynchronous investigation

Part 3 adds a low-latency deterministic router and a separate Claude investigation worker. PostgreSQL
is capped at 1 CPU and 256 MB to fit alongside the existing local streaming services. It does
not alter the existing Kafka/Flink Compose project. PostgreSQL runs from this directory as a separate
project and uses its own persistent named volume.

## Authority boundary

`payment_decisions.payment_verdict` is the immutable authorisation result from
`fast-path-policy/1.0.0`. An investigation stores `recommended_action` separately. No worker query
updates `payment_verdict`; any future change to payment action requires a new, versioned review event.

Transaction identity is globally scoped by `transaction_id` within this demonstration deployment.
Producers must never reuse it for different evidence or customers. PostgreSQL enforces one decision
per transaction ID and the router compares the canonical evidence SHA-256 on replay. Reuse with a
different digest is an identity conflict, not a new decision.

The thresholds are configurable demonstration logic and are not industry, regulatory, or production
risk thresholds. Normal-payment sampling defaults to zero.

## Database and delivery model

Alembic migrations through `0005_shadow_decision_engine` create the original decisioning tables plus
the correlator and shadow-engine state:

- `consumed_events`: physical Kafka positions plus stable logical event IDs.
- `payment_decisions`: immutable initial decisions.
- `investigations`: request lifecycle and separate recommendation.
- `investigation_attempts`: paid/dry-run attempt state.
- `audit_records`: authoritative structured investigation audit.
- `outbox_events`: durable Kafka publications.
- `live_experiments`: immutable cumulative budget configuration and prior-spend baseline.
- `live_investigation_allocations`: durable paid-investigation count and cost envelopes.
- `model_call_usage`: per-request reservations, tokens, latency, tools, provenance and cost.
- `investigation_context`: optional immutable, provenance-labelled context for selected cases.
- `fraud_assessment_*`: correlator source, latest/history, rejected-event and outbox state.
- `fraud_shadow_*`: assessment-revision ordering, policy history, rejected-event and outbox state.

The router commits its inbox row, decision and all required outbox rows in one PostgreSQL transaction.
Kafka offsets are committed only after that durable commit. Publishers claim rows in short
transactions with `FOR UPDATE SKIP LOCKED`, commit the claim, publish outside a database transaction,
and then mark an acknowledged message published in another short transaction.

This is at-least-once Kafka publication with logical idempotency, not end-to-end exactly once. A crash
after broker acknowledgement but before `PUBLISHED` is recorded causes replay of the same stable
`event_id` and key. Consumers must deduplicate logical event IDs. A broker timeout is ambiguous and is
also replayed. No transaction is held while waiting on Kafka or Anthropic.

A live Claude attempt is marked `RUNNING` immediately before the API call. If the process disappears,
restart changes the attempt and investigation to `AMBIGUOUS` and does not automatically make another
paid request. An operator must reconcile or explicitly release it in a future review workflow. This
avoids repeat charges but can leave an investigation without a completion event. Provider acceptance
cannot be atomically coordinated with PostgreSQL.

## Configuration

Copy `.env.example` to `.env`, generate a strong local password, and keep `.env` untracked. The
application also requires `DATABASE_URL`; do not put secrets in command history or committed files.

Important application variables:

| Variable | Default | Purpose |
|---|---:|---|
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | Existing broker |
| `ROUTER_GROUP_ID` | `fraud-decision-router-v1` | Router offsets |
| `ROUTER_AUTO_OFFSET_RESET` | `latest` | Used only when the stable group has no committed offsets |
| `ROUTER_EXPECTED_START_OFFSETS` | required initially | Captured `partition:offset` boundary |
| `INVESTIGATION_GROUP_ID` | `fraud-investigation-worker-v1` | Worker offsets |
| `NORMAL_INVESTIGATION_SAMPLE_RATE` | `0` | Deterministic normal sampling |
| `MAX_INVESTIGATION_ATTEMPTS` | `3` | Bounded worker attempts |
| `MAX_INVESTIGATIONS_PER_RUN` | `1` | Smoke-test guard |
| `INVESTIGATION_AUTO_OFFSET_RESET` | `latest` | Initial worker-group bootstrap only |
| `INVESTIGATION_EXPECTED_START_OFFSETS` | required initially | Captured request-topic boundary |
| `OUTBOX_CREATED_AFTER` | unset | Optional bounded-test isolation timestamp |
| `LIVE_INVESTIGATIONS_ENABLED` | `false` | First live safety switch |
| `LIVE_INVESTIGATIONS_APPROVED` | `false` | Separate live acknowledgement |
| `LIVE_EXPERIMENT_BUDGET_GBP` | `1.00` | Cumulative experiment budget |
| `LIVE_USD_PER_GBP` | `1.30` | Explicit GBP-to-USD assumption |
| `LIVE_BASELINE_COST_USD` | `0.0274` | Previously incurred smoke-test estimate |
| `LIVE_MAX_INVESTIGATIONS` | `5` | Durable cumulative paid-case limit |
| `LIVE_INVESTIGATION_RESERVE_USD` | `0.20` | Per-investigation budget envelope |
| `LIVE_MAX_MODEL_CALLS` | `12` | Hard per-investigation request count |
| `LIVE_REMAINING_CALL_RESERVE_USD` | `0.005` | Reserve for each possible remaining call |
| `LIVE_INPUT_TOKEN_SAFETY_MULTIPLIER` | `1.5` | Pre-call input estimate safety factor |

Both live switches must be true. Dry-run is otherwise mandatory and makes zero Anthropic requests.

## Controlled live evaluation budget

The configured assumption is GBP 1.00 = USD 1.30, so the GBP 1 budget is represented as USD 1.30.
The durable ledger starts with USD 0.0274 of prior estimated spend. At most five investigations can
obtain allocations; each reserves USD 0.20, leaving the configured experiment within USD 1.30.
Changing these values under the same experiment ID is rejected rather than resetting the ledger.

Before every Anthropic request, PostgreSQL locks the investigation allocation, checks the cumulative
call count and accounted/reserved cost, applies a 1.5x input-token estimate, reserves maximum output
tokens, and retains USD 0.005 for every possible remaining request. Provider-reported input/output
tokens settle each successful call immediately. An exception, missing usage metadata or crash leaves
the request conservatively ambiguous/reserved. These are pricing estimates, not a guaranteed billing
cap: provider billing, caching tiers, pricing changes and an accepted request followed by network loss
cannot be made atomic with PostgreSQL.

Inspect the ledger without making a model call:

```sh
cd agents
.venv/bin/python scripts/live_budget_status.py
```

Five fixed synthetic scenarios are defined in `fraud_agents.evaluation_scenarios`: local velocity,
far combined risk, local combined risk, normal behaviour with far card-present geography, and
velocity with unavailable geography. Their expected deterministic recommendations are tested
offline. Optional context is stored separately with provenance; it never changes the immutable
payment verdict.

Do not execute the following sequence without separate explicit approval. With both live switches
still false, seed the five immutable synthetic decisions, requests and contexts (zero API calls):

```sh
cd agents
.venv/bin/python scripts/seed_live_evaluation.py --approve-seed
```

Record that seed time and use it as `OUTBOX_CREATED_AFTER` so older recoverable rows are not mixed
into the bounded run. Then, only for the approved live window, set both live switches true,
`MAX_INVESTIGATIONS_PER_RUN=5`, and start the stable-group worker plus outbox publisher. Wait for
`worker_ready`, monitor `scripts/live_budget_status.py` after every completed case, and stop both
processes immediately after five terminal outcomes or any ambiguity/failure. Restore both switches
to false before any restart. Never retry an ambiguous paid attempt automatically.

The router group ID is stable. On its first start, the router must join the group, receive partition
assignments, initialize positions with `latest`, and match `ROUTER_EXPECTED_START_OFFSETS` before it
emits `router_ready`. Do not publish a controlled fixture before that event. Once offsets have been
committed, restarts resume those committed positions and do not create a new group or reapply the
initial boundary.

The investigation worker applies the same assignment, high-watermark and explicit-seek validation
for a new stable group and emits `worker_ready`. `OUTBOX_CREATED_AFTER` is normally unset so normal
outbox recovery remains complete; bounded integration tests may set it to exclude older recoverable
rows without mutating their state.

## Setup and operations

Starting PostgreSQL and creating topics change runtime state and require explicit approval. Once
approved:

```sh
cd fraud-decisioning
podman compose --env-file .env up -d postgres
cd ../agents
DATABASE_URL=... .venv/bin/alembic upgrade head
cd ../part3
sh scripts/create_topics.sh
```

Install the Python package after dependency installation:

```sh
cd agents
.venv/bin/python -m pip install -e '.[dev]'
```

Run each process in its own terminal:

```sh
fraud-router
fraud-outbox-publisher
fraud-investigation-worker
```

The worker is dry-run by default. Stop any process with `Ctrl-C`; this does not stop Kafka, Flink, or
PostgreSQL. To stop only the new database without deleting its volume:

```sh
cd fraud-decisioning
podman compose stop postgres
```

Inspect a bounded number of events:

```sh
cd fraud-decisioning
sh scripts/inspect_topic.sh fraud.decisions.demo
sh scripts/inspect_topic.sh fraud.investigations.requested
sh scripts/inspect_topic.sh fraud.investigations.completed
sh scripts/inspect_topic.sh fraud.decisions.dlq
sh scripts/inspect_topic.sh fraud.investigations.dlq
```

The existing synthetic generator remains the controlled scenario:

```sh
cd confluent-flink
python3 scripts/generate_payments.py
```

## Fraud assessment correlator

The additive Go correlator consumes decisions, shadow ML scores, and investigation lifecycle events;
it does not participate in payment authorisation. Apply the latest Alembic migration and create the
new topics with `scripts/create_topics.sh`, then either run it directly or use the optional Compose
profile:

```sh
podman compose --env-file .env --profile correlator up -d --build fraud-assessment-correlator
```

This joins the existing `part3_default` network and leaves Kafka, Flink, PostgreSQL volumes, and
consumer offsets intact. See [`fraud-assessment-correlator/README.md`](../fraud-assessment-correlator/README.md)
for contracts, durability semantics, health endpoints, inspection queries, and tests.

## Shadow Fraud Decision Engine

The additive Go engine consumes correlated assessment revisions and publishes only to
`fraud.decisions.shadow.demo`. It does not update `payment_decisions`, publish authorisation events, or
trigger Claude. Apply migration `0005_shadow_decision_engine`, create the additive topics, and start the
optional profile without restarting stateful services:

```sh
podman compose --env-file .env --profile shadow-engine up -d --build fraud-decision-engine
curl -fsS http://localhost:8083/readyz
curl -fsS http://localhost:8083/evaluation-report
```

See [`fraud-decision-engine/README.md`](../fraud-decision-engine/README.md) for the policy matrix,
experimental threshold rationale, event contract, metrics and recovery semantics.

## Latency and observability

Decision events distinguish transaction event time, router ingestion time, decision time, pure policy
processing latency and ingestion-to-decision delay. Historical event time is never reported as
processing latency. PostgreSQL/outbox age, Kafka consumer lag, and measured P50/P95/P99 should be
observed together. Full-path latency includes Flink's event-time buffering and has not yet been shown
to meet a banking authorisation SLA.

Stable transaction, decision, investigation, correlation and event IDs are propagated into the
implemented OpenTelemetry/OpenInference tracing for the Claude investigation workflow. Arize Phoenix
provides execution visibility across workers, agents, model calls and deterministic tools. PostgreSQL
remains authoritative for immutable payment decisions, investigation records, durable budget
accounting and audit data; Phoenix has no payment-decision authority. See the
[observability guide](../observability/README.md) for deployment, redaction and operational details.
Payload validation errors expose only error classes and sanitised reasons.

## Remaining limitations

- PostgreSQL is a single local container; backups, HA, TLS, credential rotation and managed-service
  controls are outside this phase.
- The current Flink enriched schema omits GPS, device ID and payment channel. Fast-path decisions do
  not require them; investigation context defaults to unknown.
- A malformed raw event rejected inside Flink never reaches the router DLQ.
- Kafka may contain physical duplicate events after acknowledgement ambiguity.
- Live calls have an unavoidable external side-effect ambiguity window.
- The service launchers currently run one consumer loop per process; PostgreSQL claiming supports
  concurrent outbox processes, while investigation concurrency is achieved with multiple workers.
- Metrics are currently event fields and database/Kafka operational queries; a dedicated HTTP metrics
  exporter remains future work. OpenTelemetry/Phoenix tracing is implemented for the asynchronous
  Claude investigation path and remains separate from PostgreSQL decision authority.
