# Architecture and trust boundaries

## Authority model

`fast_path_policy.decide` is the sole initial payment authority. The router stores that deterministic result
in immutable PostgreSQL `payment_decisions` before it publishes the corresponding Kafka event. No downstream
component can update or relax it.

| Evidence or output | Owner | Can change the payment verdict? |
| --- | --- | --- |
| Behavioural enrichment and signals | Flink | No |
| Initial payment verdict | Deterministic Python fast path | Writes once only |
| LightGBM probability | Python shadow scorer | No |
| Correlated assessment | Go correlator | No |
| Proposed action | Go shadow decision engine | No |
| Glaramara customer-evidence reassessment | Deterministic reassessment policy | No |

The data model enforces these boundaries: payment decisions, booked transactions, banking payment attempts,
customer answers, evidence extractions, and reassessments use immutable or append-only records as appropriate.
All Glaramara payment attempts have `ledger_effect='NONE'` and `is_simulated=true`.

## Payment path

```text
payment source ─► payments.raw.demo ─► Flink evidence ─► payments.enriched.demo
                                                           │
                                                           ▼
                                             deterministic Python router
                                                           │
                                                           ▼
                                      PostgreSQL decision + transactional outbox
                                                           │
                                      ┌────────────────────┴────────────────────┐
                                      ▼                                         ▼
                           fraud.decisions.demo                    investigation-request audit event
                                      │
                         ┌────────────┴─────────────┐
                         ▼                          ▼
                Go correlator              LightGBM shadow scorer
                         │                          │
                         └─────────► correlated assessment ─► Go shadow policy
                                                               │
                                                               ▼
                                                   fraud.decisions.shadow.demo

CHALLENGED Glaramara payment ─► versioned questionnaire ─► mock or Orchestrate adapter
                                                                │
                                                                ▼
                                              separate simulated reassessment record
```

The Java Flink job produces per-transaction rolling evidence over one, two, and ten minutes. It emits
`HIGH_VELOCITY` when there are at least five transactions in two minutes, and `MERCHANT_HOPPING` when that
velocity spans at least four merchants. The SQL job independently emits two-minute aggregate alerts for
operational visibility; it does not make payment decisions.

The fast path blocks when both signals are present, challenges when either is present, and otherwise approves
(with normal-case sampling disabled in the root deployment). The router completes its PostgreSQL transaction
before committing Kafka offsets. Stable UUIDv5 identities, consumed-event records, and unique constraints make
at-least-once delivery logically idempotent.

## Shadow evidence

The checked-in CPU LightGBM model consumes eight documented Flink-derived features and emits a synthetic,
non-calibrated probability. The Go action policy combines supported deterministic and ML branches to propose
an experimental action. Neither service is payment authority, and neither can hard-block based on ML alone,
relax a challenge, or relax a block.

The correlator stores source payloads, correlation history, and latest state in PostgreSQL. It publishes
revisioned correlated assessments through its outbox. The Go shadow engine deduplicates revisions and records
its proposed action separately from the original verdict.

## Glaramara boundary

Glaramara is a Next.js application backed by the same PostgreSQL database. A signed HttpOnly demo session
selects a fictional customer; browser requests never supply account or location identity. A payment submission
validates same-origin and idempotency headers, then atomically creates an immutable simulated payment attempt,
a raw Kafka-outbox event, and a delayed watermark marker. It never creates a booked transaction or changes a
balance.

Customer payment status is derived only from the immutable deterministic decision. Correlation and shadow
results are displayed as clearly labelled audit evidence. The application uses Compose service DNS for
PostgreSQL and reaches Kafka indirectly through the shared outbox publisher.

Only genuinely `CHALLENGED` attempts can start a Phase C security check. The questionnaire is versioned and
durable. The server sends a minimal pseudonymous context to the selected Fraud Intelligence provider; mock mode
is deterministic and offline, while `orchestrate` uses the existing IBM watsonx Orchestrate agent through IAM
and its non-streaming REST endpoint. API credentials remain server-only. Under v1.1, provider errors, invalid
responses, timeouts, and unavailable evidence produce an append-only `REFER_TO_ANALYST` result; they never fall
back to mock or affect the original verdict.

The subsequent `fraud-prevention-guidance/1.0.0` layer is deterministic rather than generative. It selects
approved, versioned protective steps using only persisted provenance-backed findings and the reassessment
outcome. The selected category, evidence references, template versions and rendered customer message are
stored with the reassessment. Historical rows may have no guidance and remain readable; replay never
regenerates it or calls Orchestrate. Guidance has no payment, ledger or callback authority.

## Deployment and recovery

The root Compose deployment owns Kafka, PostgreSQL, Flink, migrations, router/outbox/scorer, both Go services,
and Glaramara. It uses project-scoped named volumes and Compose DNS. `make up` applies Alembic migrations,
creates topics idempotently, ensures one instance of each Flink job, captures consumer boundaries, and starts
application services. `make down` creates verified savepoints and retains volumes; it never resets offsets or
recreates state.

See [the verified system overview](architecture/system-overview.md) for contracts and component detail, and
[DEPLOYMENT.md](../DEPLOYMENT.md) for the operational procedure.
