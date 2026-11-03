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
three terminal states come solely from `fast-path-policy/1.1.0`. The owned status API separately returns outbox
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

### Phase D: extensible AI-assisted fraud rule discovery

Phase D adds Alembic `0011_glaramara_phase_d` and append-only repair provenance in `0012`, a fixed-seed
8,000-row synthetic fraud laboratory, immutable discovery snapshots, standalone
`fraud_rule_discovery`, strict `fraud-rule-proposal/1.0.0` validation, chronological held-out backtesting and
the role-protected `/fraud-operations` analyst UI. The 50,000-row LightGBM training corpus remains unchanged
and was rejected for discovery because it lacks raw beneficiary history and group-safe partitions.

The server exposes discovery aggregates and selected pseudonymous examples only. Evaluation rows are first
queried after a validated candidate is stored. Candidate fingerprints detect repeats; every run remains bound
to its wave manifest. Approval is terminal `APPROVED_FOR_IMPLEMENTATION` audit state only—no live controls,
transactions, balances, Kafka topics, Flink jobs, router policy, scorer or Go service are changed.

Observed Phase D verification on 2 November 2026:

- active initial wave: 8,000 rows (5,600 discovery / 2,400 evaluation), fixed seed `20261102`, dataset
  `fraud-lab-dataset/1.0.0`; an append-only supersession record preserves an earlier local draft while the
  corrected active snapshot uses `fraud-lab-wave-2026q4-v2`;
- live run `1dec13bd-18cb-40a9-ab59-e6d4166cf0c6` captured only that 8,000-row snapshot
  (`ea1fa51479254b370d29f7999a7947ac9bdae29c3e0a5b513c866c2b8ef20719`), invoked standalone agent
  `d67de40f-7ff4-4906-8e21-83425e7f2840` on `groq/openai/gpt-oss-120b` in 6,082 ms and produced a locally
  valid two-condition velocity/value proposal;
- the deterministic 2,400-row holdout measured baseline TP/FP/TN/FN 25/7/2245/123 and combined
  30/9/2243/118: five additional fraud-labelled payments and two additional genuine challenges, recall
  16.89% to 20.27%, precision 78.13% to 76.92%, with overlap 13. The UI displayed this trade-off honestly;
- Alex Morgan approved candidate `d3bfc928-05d4-43f8-b54b-3fb55b4cc2b6` for future implementation. The
  immutable review and backtest remain present and no deployment followed. A customer session received `403`;
- `make fraud-lab-next-wave` appended corrected calendar-Q1 wave `fraud-lab-wave-2027q1-v2`, 6,000 rows
  (4,200/1,800), seed `20270115`, digest
  `968bc228058ce65b86af09fc1eaec7325195b3175bef0658cf0d35774db617a3`; immediate replay returned
  `replayed=true`. Active lab history is now 14,000 rows and all earlier candidates, backtests and reviews
  remain. The period-mismatched local draft is retained but inactive through audited supersession.
- final regressions: agents 96 passed / 8 opt-in skipped with Ruff clean; Glaramara 26 contracts, typecheck and
  production build passed; Playwright 16 passed / 4 opt-in skipped across desktop and mobile; Java enrichment
  8 tests plus 15 Python Flink/deployment-unit tests passed (6 Kafka integration skips); both Go modules passed
  test and vet; deployment 27 passed; Compose rendered; all required runtime components were ready, both
  established Flink job IDs remained running and every reported consumer lag was zero.

See [`glaramara-phase-d-summary.md`](glaramara-phase-d-summary.md) for contracts, commands, limitations and
the future Flink engineering path.

Incremental-wave validation then completed live run `810ae2fe-7a9f-4f83-a188-23dee7fa7d1c` against both
active waves: 14,000 snapshot rows, 9,800 discovery-only rows and 4,200 independently loaded holdout rows.
Orchestrate proposed a novel five-new-beneficiary/£2,500-total `PT24H` challenge at 4,838 ms. Combined recall
rose from 17.46% to 23.41%, with 15 additional fraud labels and 17 additional genuine challenges; the new
candidate remains unreviewed `BACKTESTED`. Reports now separate the three active deterministic signals from
all prior `NOT_DEPLOYED` candidates, and the UI distinguishes the current dataset from historical 8,000-row
snapshots. Two earlier failed live runs were confirmed as non-extractable agent response shapes rejected before
candidate persistence or evaluation; parser tolerance, prompt precision and diagnostic error categories were
improved without weakening the strict proposal schema. Existing waves, reviews and runtime state were kept.

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

## Phase B/C/D operating mode

Required and implemented mode is **fictional, simulated, shadow-only, no ledger effect**. The immutable
deterministic verdict remains payment authority; LightGBM and the Go action remain experimental shadow
evidence. Existing offsets, restored Flink state,
PostgreSQL volumes, the approved prototype and AskOrchestrate were preserved.

Do not begin ML-active selection under this milestone. That work is Phase B.1 and requires separate approval.

## New-beneficiary high-value rule

Glaramara derives beneficiary history in PostgreSQL from immutable booked transactions keyed by customer and
beneficiary UUID and adds the count to its raw payment event. Flink emits `NEW_BENEFICIARY_HIGH_VALUE` only
when that count is zero and the amount is at least the configurable threshold (default £5,000). Generic raw
producers without beneficiary history cannot trigger it. Deterministic policy `fast-path-policy/1.1.0`
challenges the signal under `FP-CHALLENGE-NEW-BENEFICIARY-HIGH-VALUE/1.0.0`; the pre-existing combined
velocity and merchant-hopping block retains precedence. The Fraud Intelligence provider boundary is
unchanged.

Observed verification on 2 November 2026:

- focused Java rule/schema tests: 8 passed; agents: 92 passed, 8 opt-in skipped, Ruff passed; Glaramara:
  21 passed, TypeScript and production build passed; deployment: 27 passed; Compose rendered successfully;
- both Flink jobs restored from verified savepoints, retaining Kafka/PostgreSQL volumes and offsets;
- genuine new-beneficiary payment `002913e0-3d19-4294-9c72-a285d6de3d4a` for exactly £5,000 produced only
  `NEW_BENEFICIARY_HIGH_VALUE`, was authoritatively `CHALLENGED` at `fast-path-policy/1.1.0`, and recorded
  `FP-CHALLENGE-NEW-BENEFICIARY-HIGH-VALUE/1.0.0`; its booked-history count was zero, ledger effect remained
  `NONE`, and no booked transaction was created;
- the then-current `1.0.0` questionnaire started with four existing questions including
  `contact_influence`; no live Orchestrate call was made in that rule-only verification;
- the fresh 16-payment regression `cafed8e578a2` retained 11 approved / 2 challenged / 3 blocked, and a normal
  known-beneficiary Glaramara payment remained `APPROVED` with unchanged balance and shadow provenance.

## Glaramara recipient and questionnaire follow-up

Beneficiary-list `Pay` links now open payment review with the server-returned owned beneficiary selected.
Recipient selection reappears only through `Change recipient`; the signed session, same-origin controls and
database ownership validation remain authoritative.

Questionnaire `glaramara-fraud-questionnaire/1.1.0` selects a required bounded `payment_circumstances`
explanation for first-time beneficiaries. The earlier free-text `other_purpose` appeared only after choosing
`Something else`, which is why the demonstrated `Friends or family` path had no place for the Thailand
context. Stored `1.0.0` investigations retain their snapshotted definitions and compatibility. The minimal
pseudonymous extraction request includes the explanation as a question/answer pair with question ID and
`CUSTOMER` provenance; the controlled questionnaire and existing agent are otherwise unchanged.

Observed verification on 2 November 2026:

- Glaramara contracts: 21 passed; focused desktop/mobile Playwright: 14 passed; TypeScript and production
  build passed;
- only `glaramara-bank` was rebuilt and recreated; Kafka, Flink, PostgreSQL and their volumes were untouched;
- payment `7b45533d-8df9-41b1-b1af-53a77de48620`, a genuine first-time-beneficiary payment for exactly £5,000,
  remained authoritatively `CHALLENGED` with `FP-CHALLENGE-NEW-BENEFICIARY-HIGH-VALUE/1.0.0`;
- the running provider was `orchestrate`; the REST extraction persisted
  `provider=watsonx-orchestrate-rest`, model `groq/openai/gpt-oss-120b`, valid schema and 6,733 ms latency;
- deterministic reassessment was `DECLINED` for `SCAM_INDICATOR_PRESSURE_OR_SECRECY`; the original verdict
  remained `CHALLENGED`, and both payment and reassessment ledger effects remained `NONE`.

## Orchestrate boundary

Repository source under `watsonx-orchestrate/fraud-intelligence/` manages the Phase C agent; source under
`watsonx-orchestrate/fraud-rule-discovery/` manages the separate Phase D agent. AskOrchestrate and the Phase C
agent were not modified. Neither agent has deployment authority. Model changes must be measured against the
appropriate strict local schema before importing only the intended agent into development.

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
- Phase D backtesting is ordered batch simulation, not exact Flink operational replay: it omits watermarks,
  late-event handling, checkpoint recovery and physical duplicate behaviour.
- Outbox delivery retries indefinitely; there is no terminal publication-failure state or operator retry API.
- Trusted customer/account/location context and beneficiary names remain only in the immutable banking
  snapshot. The strict raw/enriched contract exposes the minimal server-derived beneficiary payment count;
  LightGBM does not consume it.
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
- Banking/Phase C/D: `agents/migrations/versions/{0006_glaramara_banking,0007_glaramara_phase_b,0008_raw_event_time_clock,0009_release_banking_watermarks,0010_glaramara_phase_c,0011_glaramara_phase_d,0012_fraud_lab_wave_supersession}.py`,
  `glaramara-bank/lib/{server,fraud-intelligence}/`, `glaramara-bank/app/api/v1/payments/`,
  `glaramara-bank/app/api/v1/fraud-operations/`, `glaramara-bank/lib/fraud-rule-discovery/`,
  `agents/src/fraud_agents/fraud_lab/`, `watsonx-orchestrate/{fraud-intelligence,fraud-rule-discovery}/`

At later milestones, update this handoff with observed commands/results, the system overview for
flow changes, and the nearest component README. Link evidence instead of duplicating logs.
