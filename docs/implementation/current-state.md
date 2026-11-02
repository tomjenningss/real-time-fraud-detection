# Current implementation state

Handoff as of 2 November 2026. Start milestone work here; follow links for detail. Planned statements are not
claims about deployed behaviour.

## Completed milestones

### Phase 0: protected baseline

Phase 0 captured a read-only baseline before banking work. It did not publish, migrate, restart, reset state
or access IBM TechZone. Python, Flink support, deployment, Go and Java build checks passed with documented
skips/toolchain limitations. It fixed the prototype identity and protected runtime inventory. See
[`glaramara-phase-0-baseline.md`](glaramara-phase-0-baseline.md) and
[`../golden-reference.md`](../golden-reference.md).

### Phase A: persistent fictional banking and UI

Phase A added Alembic `0006_glaramara_banking` and `glaramara-bank/`. The responsive app reads fictional
customers, accounts, transactions and beneficiaries from PostgreSQL through a signed demo session.
Beneficiary creation persists safely. Payment review stops before submission: there is no payment mutation
API, Kafka publication, fraud call, verdict or balance change. The approved prototype was unchanged. See
[`glaramara-phase-a-summary.md`](glaramara-phase-a-summary.md) and
[`glaramara-bank/README.md`](../../glaramara-bank/README.md).

Recorded Phase A verification:

- agents: 81 passed, 5 skipped; Ruff passed;
- disposable PostgreSQL 17 migration/schema checks: 3 passed;
- Glaramara contracts: 9 passed; TypeScript and production build passed;
- Playwright desktop/mobile: 10 passed, 2 opt-in database cases skipped;
- opt-in real PostgreSQL browser/API case: 1 passed;
- `npm audit`: zero known vulnerabilities at capture time.

The disposable database was removed; existing runtimes, offsets, Flink state and volumes were untouched.
These are recorded results, not a fresh rerun for this handoff.

### Phase B: asynchronous payment-to-fraud integration

Phase B adds Alembic `0007_glaramara_phase_b`, `0008_raw_event_time_clock` and
`0009_release_banking_watermarks`, payment submission/status APIs, the transactional raw-payment outbox
contract and customer UI states. The submission route validates
signed-session customer, primary account, beneficiary and demo-location ownership in PostgreSQL. Canonical
request hashing, an advisory
transaction lock and `(customer_id,idempotency_key)` uniqueness make replay deterministic; conflicting reuse
returns `409`.

Each accepted request reserves monotonic producer time and atomically writes one immutable simulated
`banking_payment_attempts` row plus raw-payment and delayed-watermark rows to the existing `outbox_events`.
The 16-payment probe uses the same PostgreSQL advisory lock and clock, preventing its future SQL-window marker
from making an immediately following UI payment late. Marker event time and publication scheduling are
separate: the payload advances Flink's event clock, while outbox availability is three processing-time seconds
after insertion. Revision `0009` releases pending markers written by the earlier conflated-clock implementation.
The existing Python publisher owns retry, lease and
acknowledgement behaviour. It will not claim a banking watermark until the corresponding raw event is
`PUBLISHED`, so recovery cannot advance the Flink watermark ahead of a retried payment. Stable payment and
transaction IDs are identical UUIDs through Flink, Python, LightGBM, Go correlation and shadow evaluation.

`banking_payment_status` joins the attempt only to immutable `payment_decisions`; absence is `PENDING` and the
three terminal states come solely from `fast-path-policy/1.0.0`. The owned status API separately returns outbox
progress, correlated revision and experimental Go shadow evidence. The UI polls it, exposes honest delay/retry
messaging and labels shadow output non-authoritative. No booked transaction, balance or ledger row is created.
Authoritative `PENDING` status continues polling at a slower cadence after the initial fast window, so a
recovered outbox cannot leave an already-open page stale; terminal shadow polling remains bounded.

See [`glaramara-phase-b-summary.md`](glaramara-phase-b-summary.md) for the implementation boundary, contracts
and reproducible verification commands.

Observed Phase B verification on 1 November 2026:

- application contracts: 10 passed; TypeScript and production build passed;
- Playwright mocked desktop/mobile: 10 passed, 2 opt-in PostgreSQL cases skipped;
- agents: 88 passed, 8 skipped; Ruff passed;
- deployment: 22 passed; Compose rendered successfully;
- Flink support: 15 passed, 6 opt-in Kafka cases skipped; Maven build passed;
- Go correlator and decision-engine tests plus `go vet ./...` passed in Go 1.24 containers;
- live payment `7b5f7cca-6406-4c9f-9ec1-e960e5fc80df` traversed the isolated root stack immediately after the
  controlled fixture's future window marker: deterministic
  `APPROVED` at `fast-path-policy/1.0.0`, correlated revision 2, LightGBM model
  `lgbm-baseline-20261028T115824Z-abfd893e`, Go shadow `APPROVED` at `fraud-action-policy-v1`, both banking
  outbox rows `PUBLISHED` on their first attempts, balance unchanged;
- manual payment `052817e4-389a-4eaa-a380-b566ac40fb78` exposed the future-clock scheduling defect: raw offset
  242 published once, marker offset 243 was delayed until its event time, then the original payment completed
  `APPROVED` under `fast-path-policy/1.0.0` with complete ML/correlation/shadow evidence; revision `0009` and
  the corrected processing-time schedule prevent recurrence without resubmission;
- post-acceptance `make status`: every required service healthy, both Flink jobs still `RUNNING`, all consumer
  lags zero;
- fresh controlled run `07d96a1bfc1a`: all 16 IDs reached enriched, deterministic, ML, correlated and shadow
  topics with the preserved 11 approved / 2 challenged / 3 blocked deterministic distribution and both SQL
  rules observed.

### Phase C: Glaramara Fraud Intelligence

Phase C adds Alembic `0010_glaramara_phase_c`, an adaptive and recoverable Glaramara security check, the
single TechZone `fraud_intelligence` agent, strict evidence validation and deterministic reassessment policy
`customer-evidence-reassessment/1.0.0`. A questionnaire begins with three core questions and selects contact
or scam follow-ups only from versioned definitions when payment context or prior answers require them. One
bounded agent clarification is permitted; it is not a free-form chatbot.

The Glaramara server constructs a minimal pseudonymous context and owns the authenticated Orchestrate adapter.
Validated evidence, request hash, provider/model, schema version, latency, questionnaire answers, append-only
history and simulated reassessment are persisted independently. `CLEARED`, `REQUIRES_FURTHER_REVIEW` and
`DECLINED` are investigation resolutions only: the original `payment_decisions` row and customer payment
status remain immutable. Invalid schema, model errors, timeouts, missing evidence and contradictions cannot
clear a payment. Root Compose uses the deterministic mock extractor so the shared runtime contains no
TechZone credentials. Deployments select native TypeScript REST with
`FRAUD_INTELLIGENCE_PROVIDER=orchestrate`; Glaramara no longer spawns the existing standalone Python ADK
runner, and live failures conservatively require further review without mock fallback.

Observed Phase C verification on 2 November 2026:

- TechZone connectivity and model inventory were read through ADK 2.19.1; the tenant contains only the
  pre-existing AskOrchestrate and the new `fraud_intelligence` agent. AskOrchestrate was not modified;
- `groq/openai/gpt-oss-120b` passed all 3 live semantic/provenance scenarios at 5,026 / 6,949 / 6,594 ms
  (mean 6,190 ms, median 6,594 ms, max 6,949 ms). The lower-capacity
  `watsonx/mistralai/mistral-small-3-1-24b-instruct-2503` candidate failed the strict evidence contract and was
  rejected;
- Glaramara unit/contracts: 21 passed, including IAM caching, concurrent refresh and bounded 401 retry;
  TypeScript and production build passed; default Playwright
  desktop/mobile: 12 passed and 4 opt-in PostgreSQL/live cases skipped, including adaptive follow-up, refresh
  recovery and WCAG A/AA checks;
- agents: 90 passed, 8 opt-in skips; Ruff passed; deployment: 25 passed; Compose rendered successfully;
- genuine challenged payment `76608ed5-27de-4441-b459-ec2b68f4aa8f` completed four contextual questions and
  one deterministic-fixture extraction, producing separate simulated `CLEARED` resolution with policy
  `customer-evidence-reassessment/1.0.0`. Its original verdict remained `CHALLENGED` under
  `fast-path-policy/1.0.0`, its balance remained £24,862.80, and the audit retained four answers, eight events,
  schema/model provenance and `ledger_effect=NONE`;
- fresh velocity challenge `1a658cb8-65b2-4444-8ae3-cdabf05148a5` completed the real browser journey against
  a loopback-only host backend. It invoked provider `watsonx-orchestrate` and model
  `groq/openai/gpt-oss-120b` once, persisted valid schema and two answer-provenance claims at 4,545 ms, and
  independently reassessed to simulated `CLEARED`. Its authoritative verdict remained `CHALLENGED`, the
  ledger effect remained `NONE`, and the balance remained £24,862.80. The opt-in live Playwright case passed
  in 11.6 seconds;
- native REST challenge `44439d6c-e864-416d-a833-3ab56d7b05ee` resolved the existing agent ID through the
  configured Toronto instance, then passed the live browser journey in 7.2 seconds. PostgreSQL recorded
  provider `watsonx-orchestrate-rest`, model `groq/openai/gpt-oss-120b`, one schema-valid invocation at
  3,952 ms, two question-provenance claims and simulated `CLEARED`; the original verdict remained
  `CHALLENGED` and ledger effect remained `NONE`;
- additive migration and rebuild preserved Flink job IDs `17cab785ccbc4c6cae52481386114fb8` and
  `09573924d3fdb1d265641300ab0fe6b3`; required services were healthy and consumer lag was zero.

See [`glaramara-phase-c-summary.md`](glaramara-phase-c-summary.md) for contracts, model selection and evidence.

## Existing 16-payment baseline and shadow reference

The controlled fixture contains 16 payments. Its deterministic reference is **11 approved, 2 challenged,
3 blocked**, with five investigation requests. Phase 0 cross-checked the generator, smoke assertions and
checked-in evaluation; it did not rerun the live fixture.

The checked-in shadow-v1 run retained immutable 11/2/3 decisions. Latest shadow actions were **9 approved,
4 challenged, 3 blocked**: two approvals (`velocity-3`, `hopping-3`) became experimental ML-driven
challenges. It published 24 revision-driven shadow messages for 16 transactions. See
[`shadowv1-20261028T1605Z.md`](../../fraud-decision-engine/evaluation/shadowv1-20261028T1605Z.md) and
[`MILESTONE_REPORT.md`](../../fraud-decision-engine/MILESTONE_REPORT.md). These synthetic, unlabelled
results are not production accuracy evidence.

## Phase B/C operating mode

Required and implemented mode is **fictional, simulated, shadow-only, no ledger effect**. The immutable
deterministic verdict remains payment authority; LightGBM and the Go action remain experimental shadow
evidence. Existing offsets, restored Flink state,
PostgreSQL volumes, the approved prototype and AskOrchestrate were preserved.

Do not begin ML-active selection under this milestone. That work is Phase B.1 and requires separate approval.

## Orchestrate boundary

Only repository source under `watsonx-orchestrate/fraud-intelligence/` may manage the single Phase C agent.
Do not edit AskOrchestrate or add collaborators, tools or agents without a later milestone. Model changes must
be measured against the strict evaluation before importing only `fraud_intelligence` into development.

## Limitations and outstanding work

- Repository Python targets 3.11; Phase 0's existing `agents/.venv` was 3.14.3. Retain pinned 3.11 CI.
- LightGBM and thresholds are synthetic/uncalibrated. There is no production feature store, synchronous
  fraud API, HA/TLS/backup design or operational SLO.
- Delivery is at least once. Physical Kafka duplicates remain possible; stable IDs and uniqueness matter.
- Java enrichment still logs genuinely late events rather than publishing a durable late-event contract.
  Phase B closes each sporadic UI event with a delayed marker ordered after raw publication; it does not change
  the general late-event policy.
- `fraud.signals.demo` is not a router input; canonical signals are in `payments.enriched.demo`.
- Root Compose enables the scorer and Glaramara but does not run the investigation worker.
- Root Compose deliberately uses the deterministic Fraud Intelligence fixture. Native REST has completed a
  localhost browser journey against TechZone using only server-side `.env.local` values. The containerised
  Glaramara service deliberately carries no TechZone credentials; a non-local deployment needs managed secret
  injection. The Python ADK adapter remains standalone diagnostic tooling, not an application fallback.
- Orchestrate ADK 2.19.1 warns that planner style is deprecated. Planner is retained because this ADK version
  requires it for structured output; migrate only after validating equivalent strict output support.
- Outbox delivery retries indefinitely; there is no terminal publication-failure state or operator retry API.
- Trusted customer/account/beneficiary/location context is retained in the immutable banking snapshot but is
  not added to the strict enriched/correlator contracts because existing policies do not consume it.
- The Go policy is transport-independent, but the current engine is asynchronous shadow evaluation. A
  synchronous authorisation service is a separate future design.
- Full IBM-laptop portability is not evidenced. Golden and development stacks are isolated and may exceed
  Podman capacity when concurrent.

## Files future sessions should inspect first

- Architecture/trust: [`system-overview.md`](../architecture/system-overview.md),
  [`architecture.md`](../architecture.md)
- Runtime safety: [`DEPLOYMENT.md`](../../DEPLOYMENT.md), [`golden-reference.md`](../golden-reference.md),
  root `compose.yaml`
- Evidence: `confluent-flink/src/main/java/demo/fraud/`, `confluent-flink/sql/fraud_signals.sql`
- Deterministic path: `agents/src/fraud_agents/{fast_path_policy,router_service,events,database,outbox_service}.py`
- ML: `agents/src/fraud_agents/ml/`, `agents/artifacts/baseline/metadata.json`
- Correlation: `fraud-assessment-correlator/internal/{assessment/model,store/store}.go`
- Shadow: `fraud-decision-engine/internal/{policy/policy,store/store}.go`
- Banking/Phase C: `agents/migrations/versions/{0006_glaramara_banking,0007_glaramara_phase_b,0008_raw_event_time_clock,0009_release_banking_watermarks,0010_glaramara_phase_c}.py`,
  `glaramara-bank/lib/{server,fraud-intelligence}/`, `glaramara-bank/app/api/v1/payments/`,
  `watsonx-orchestrate/fraud-intelligence/`

At later milestones, update this handoff with observed commands/results, the system overview for
flow changes, and the nearest component README. Link evidence instead of duplicating logs.
