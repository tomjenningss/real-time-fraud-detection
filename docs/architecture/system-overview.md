# Verified system overview

Verified from repository code and deployment wiring on 2 November 2026. Runtime observations are identified
separately; future intentions are not presented as implemented behaviour.

## Authority and end-to-end flow

```text
Glaramara submission -> PostgreSQL banking attempt + shared outbox -> payments.raw.demo
controlled generators ---------------------------------------------> payments.raw.demo
  |-> Java Flink enrichment -> payments.enriched.demo
  |      |-> deterministic Python router -> fraud.decisions.demo -> PostgreSQL
  |      |                                  |-> fraud.investigations.requested (legacy audit event)
  |      |-> CPU LightGBM scorer -> fraud.risk.baseline.demo
  |-> Flink SQL -> fraud.signals.demo (context only; not a router input)

decisions + ML risk + legacy investigation events
  -> Go correlator -> fraud.assessments.correlated.demo
  -> Go shadow decision engine -> fraud.decisions.shadow.demo

CHALLENGED Glaramara payment -> adaptive versioned questionnaire -> backend Fraud Intelligence adapter
  -> one primary Orchestrate extraction (optional one bounded clarification)
  -> validated semantic evidence -> deterministic reassessment -> separate simulated resolution
```

Only deterministic policy `fast-path-policy/1.0.0` produces the initial `APPROVED`, `CHALLENGED` or
`BLOCKED` verdict.
The Glaramara reassessment and the Go engine's experimental shadow action cannot change it. Publication
is at least once.

## Kafka contracts and ownership

The root deployment creates one-partition, replication-one topics. Application contracts are schema
`1.0.0`; stable identities and database constraints supply logical deduplication.

| Topic | Producer | Consumer / contract |
|---|---|---|
| `payments.raw.demo` | Glaramara banking outbox and Python controlled generators | Both Flink jobs. Transaction/user/merchant, amount, device/channel and event time. |
| `payments.enriched.demo` | Java Flink | Router and scorer. Canonical rolling counts, amount/diversity, transaction signals/IDs and risk. |
| `fraud.signals.demo` | Flink SQL | No checked-in decision consumer. Repeating two-minute aggregate velocity/hopping context. |
| `fraud.decisions.demo` | Python outbox publisher | Correlator. Immutable verdict, policy/rules and evidence provenance. |
| `fraud.investigations.requested` | Python outbox publisher | Legacy audit event with original verdict, evidence and routing provenance; no worker is deployed by root Compose. |
| `fraud.investigations.completed` | Legacy worker when separately run | Correlator compatibility input; root Compose does not produce it. |
| `fraud.risk.baseline.demo` | Python LightGBM scorer | Correlator. Probability, model/feature versions, latency and feature provenance. |
| `fraud.assessments.correlated.demo` | Go correlator outbox | Shadow engine. Revisioned union of available evidence branches. |
| `fraud.decisions.shadow.demo` | Go engine outbox | Evaluation only. Proposed/original actions, disagreement, policy inputs and provenance. |
| assessment, shadow-decision, decision and investigation DLQs | Owning services | Sanitised rejection envelopes so poison inputs do not block later records. |

Correlated/shadow messages are keyed by `transaction_id`. Shadow consumers must deduplicate by
`shadow_evaluation_id`: a crash after Kafka acknowledgement can physically republish an outbox message.

## Flink evidence

The Java `TransactionEnrichmentJob` consumes raw payments with two-second bounded out-of-orderness and
15-second idleness, keyed by user. `EnrichmentFunction` maintains event-time rolling evidence over one,
two and ten minutes and emits one canonical assessment per accepted transaction. Deterministic signals are
`HIGH_VELOCITY` (at least five transactions in two minutes) and `MERCHANT_HOPPING` (that velocity across
at least four merchants), with transaction-scoped IDs. Late records go to a logged side output.

The separate SQL job reads raw payments into two-minute hopping windows every ten seconds. It emits aggregate
alerts when count is at least five. Alerts can repeat across overlapping windows and are explicitly not
decisions. The router does not consume this topic; it uses signals embedded by Java in each enriched record.

Both jobs checkpoint every ten seconds and use at-least-once sinks. Checked-in fresh startup is `latest`;
root lifecycle scripts preserve established checkpoints/savepoints and never reset consumer groups.

## Deterministic decision and investigation

The Python router consumes enriched evidence, validates the strict `FlinkEvidence` contract, and applies:

- both velocity and merchant hopping: `BLOCKED`, investigation requested;
- either signal: `CHALLENGED`, investigation requested;
- neither: `APPROVED`, with optional normal sampling (deployed rate zero).

One PostgreSQL transaction records the consumed event, immutable decision, optional investigation and
publication outbox rows; Kafka commits afterward. A separate publisher emits decisions/requests. Event,
decision, correlation and investigation identities are deterministic UUIDv5 values.

The router can emit an investigation-request audit event for challenged payments. Root Compose does not start
any legacy investigation worker; customer evidence is handled only through Glaramara's bounded Phase C flow.
PostgreSQL rejects payment-decision mutation.

## LightGBM shadow scorer

The opt-in scorer is enabled as a shadow service in root Compose. It independently consumes enriched records
and derives eight clipped features: amount; transaction counts over one, two and ten minutes; two-minute
distinct merchants and total amount; mean amount; and merchant-diversity ratio. It loads the checked-in CPU
model `lgbm-baseline-20261028T115824Z-abfd893e`, schema `fraud-features-1.0.0`.

The artifact was trained/evaluated on synthetic data. Its validation-selected threshold is `0.24`; its
score is not a calibrated production probability. The scorer only publishes evidence. It commits after
Kafka acknowledges output; invalid records are logged and committed because scoring is non-authoritative.

## Correlation and shadow policy

The Go correlator consumes deterministic decisions, ML risk, investigation requests and completions. For
each valid event it transactionally stores source position/payload, deduplicates, updates latest assessment,
appends history and creates an outbox row. Assessments may be partial and gain revisions as branches arrive;
a missing completion stays `PENDING_INVESTIGATION`. Invalid records use a durable DLQ outbox.

The Go engine consumes assessment revisions. Pure `fraud-action-policy-v1` requires valid deterministic
and supported ML branches:

| Original | ML probability | Shadow action |
|---|---:|---|
| `APPROVED` | `< 0.24` / `>= 0.24` | `APPROVED` / `CHALLENGED` |
| `CHALLENGED` | `< 0.70` / `>= 0.70` | `CHALLENGED` / `BLOCKED` |
| `BLOCKED` | any valid supported score | `BLOCKED` |

ML alone cannot hard-block, cannot relax a challenge, and nothing can relax a hard block. Missing branches
are `AWAITING_INPUTS`; invalid/unsupported inputs are `INVALID_INPUTS`; neither publishes an action.
Investigation content is audit context, never policy input. Duplicate/obsolete revisions do not re-evaluate.

## PostgreSQL schemas and transaction boundaries

Alembic currently ends at `0010_glaramara_phase_c`:

- Python: consumed events, immutable payment decisions, investigations/attempts/audit, durable outbox,
  budget and investigation context.
- Correlator: source events, append-only history, latest assessment, rejected events and outbox.
- Shadow engine: consumed revisions, latest policy state, append-only evaluation history, rejected events
  and outbox.
- Glaramara: customers, accounts, beneficiaries, locations, booked transactions, immutable payment attempts
  and the authoritative `banking_payment_status` projection; a singleton raw-event clock coordinates producer
  event time without storing a verdict.
- Phase C: durable customer investigations, append-only events and answers, immutable Fraud Intelligence
  extractions and independent simulated reassessments with schema/model/policy provenance.

Consumers finish their database transaction before Kafka commit. Publishers lease outbox rows and mark them
published after Kafka acknowledgement. PostgreSQL is authoritative; Kafka stays at least once.
`payment_decisions`, booked transactions and payment attempts reject update/delete; demo balances cannot
change. Composite foreign keys prevent cross-customer account/beneficiary/location use.

## Glaramara application and payment boundary

`glaramara-bank/` is Next.js App Router with PostgreSQL and an eight-hour HMAC-signed, HttpOnly, SameSite
demo-session cookie. It implements dashboard, activity, cards, beneficiaries and responsive payment review.
Session/beneficiary mutations require exact same-origin requests. Implemented APIs are
`GET|POST /api/v1/demo/session`, `GET /api/v1/dashboard`, `GET /api/v1/activity`, and
`GET|POST /api/v1/beneficiaries` plus the owned Phase C investigation endpoints described below.

`POST /api/v1/payments` requires an exact same-origin request, a signed demo session and a visible-ASCII
`Idempotency-Key`. The browser supplies only beneficiary, GBP amount and reference. PostgreSQL resolves the
fictional customer, primary account and allowlisted demo location from trusted server state, validates
beneficiary ownership, and serializes concurrent replays with a transaction advisory lock. Reusing a key with
the same canonical request returns the original payment; different details return `409`.

The same PostgreSQL transaction reserves monotonically increasing time in `raw_event_time_clock`, inserts the
immutable `banking_payment_attempts` row and writes two rows in the existing shared `outbox_events`: the
canonical raw payment and a delayed event-time marker. The marker payload carries the reserved future event
time, while its outbox `available_at` is independently set to three seconds of processing time after insertion.
Revision `0009_release_banking_watermarks` repairs any pending marker created before those two clocks were
separated. The root 16-payment probe takes the same advisory lock when it reserves its later SQL-window marker,
so an immediately following UI payment remains ahead of Flink's watermark. The existing Python publisher
provides leases, retries and Kafka acknowledgement. A banking marker is not claimable until its raw-payment row
is `PUBLISHED`, preventing recovery from advancing the Flink watermark ahead of a retried payment. This closes
sporadic UI events after the existing two-second bounded-out-of-order interval without changing Flink state or
job contracts.

`GET /api/v1/payments/{paymentId}` enforces session ownership and reads `PENDING`, `APPROVED`, `CHALLENGED` or
`BLOCKED` from the banking status projection. Only `payment_decisions.payment_verdict` can create a terminal
customer status. The response also reports outbox recovery, correlated revision/completeness and the latest Go
shadow evaluation as explicitly experimental audit evidence. The responsive status page polls this contract,
shows honest delayed/retry states and never derives a verdict from amount, ML or Go output. No booked
transaction, ledger entry or balance mutation occurs.

## Phase C customer evidence and reassessment

Only a genuine immutable `CHALLENGED` decision can start
`GET|POST /api/v1/payments/{paymentId}/investigation`. Versioned definitions select three core questions,
with `contact_influence` selected for a new beneficiary or velocity context. Answers can add bounded
`other_purpose`, `pressure_or_secrecy` and `remote_access` follow-ups. Each answer requires same-origin,
signed-session ownership and an idempotency key; selected questions and their definitions are snapshotted for
recovery. The responsive UI restores the next unanswered question after refresh.

`POST .../answers` persists customer provenance and `POST .../extract` atomically claims one invocation before
calling the backend adapter. The adapter sends only a pseudonymous transaction reference, amount/currency,
prior-beneficiary flag, deterministic signal names, required evidence keys and completed question/answer
pairs. The SaaS tenant never calls localhost. The canonical `fraud_intelligence` agent has no tools,
collaborators, memory or knowledge base and returns only `fraud-intelligence-evidence/1.0.0`. Local Zod
validation additionally enforces non-empty indicators, exclusive `NONE`, bounded clarification and semantic
question provenance. An optional clarification can cause one second and final invocation; the database caps
the total at two.

Policy `customer-evidence-reassessment/1.0.0` consumes only validated evidence. It clears only complete,
recognised, low-uncertainty evidence with no scam indicator; defined unrecognised/scam conditions decline;
missing, contradictory, uncertain, invalid or unavailable evidence requires further review. Results are
simulated and append-only. They do not update `payment_decisions`, `banking_accounts` or booked transactions.
Root Compose selects a deterministic fixture for reproducible local validation. Provider `orchestrate` is the
backend-only live mode and invokes the existing agent through native TypeScript IAM/REST; Glaramara does not
spawn the Python ADK runner or fall back to mock after a live failure.

## Configuration and deployment

Root `compose.yaml` owns isolated Kafka, PostgreSQL, Flink, migrations, router, Python outbox/scorer, both
Go services and Glaramara. Traffic uses Compose DNS; default host ports are `19092`, `55433`, `18081`, `18082`,
`18083` and `3000`. `make up` migrates through `0010_glaramara_phase_c`, creates topics, ensures one of each
Flink job, captures Python start boundaries once, then starts applications. `make down` saves both Flink jobs
and does not remove volumes.
See `DEPLOYMENT.md`.

Protected golden `confluent-flink`, `part3` and `fraud-observability` projects are separate. Never
reuse, reset or implicitly stop their networks, offsets, state or volumes; see `docs/golden-reference.md`.

## Remaining boundaries

Phase B is asynchronous by design. There is no synchronous authorisation API, balance mutation, production
feature store, calibrated model, terminal outbox failure state or automatic challenge resolution. Pending UI
status can identify retries and delay but the publisher retries indefinitely. Trusted banking context remains
an immutable banking snapshot; the unchanged Flink enriched contract intentionally carries only fields used by
the existing deterministic and ML paths.

ML-active mode selection is deferred to Phase B.1. LightGBM and the Go action remain shadow-only.

The live adapter is validated end to end against the TechZone development tenant through a second Glaramara
server bound only to `127.0.0.1`. Native server-side TypeScript exchanges the ignored `.env.local` API key for
an IBM IAM bearer token, caches it until five minutes before expiry, deduplicates refreshes and retries a 401
exactly once after invalidation. It then calls the fixed existing agent ID through
`/v1/orchestrate/{agent_id}/chat/completions` with `stream: false`. Neither bearer token nor API key reaches the
browser, Compose or PostgreSQL. The standalone Python ADK runner remains repository diagnostic tooling but is
not part of the Glaramara runtime path.
Planner style is deprecated by ADK 2.19.1 but retained for its structured-output support. AskOrchestrate
remains outside this architecture and untouched.
