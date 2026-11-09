# Current implementation state

Handoff as of 8 November 2026. Start milestone work here; follow links for detail. Planned statements are not
claims about deployed behaviour.

## End-to-end load-test framework and initial smoke

The additive standard-library runner in `deployment/glaramara_load_test.py` submits only through the real
signed-session Glaramara payment API, creates clearly labelled run-scoped fictional beneficiaries through the
existing API, rate-limits with bounded concurrency and same-key retries, and uses immutable PostgreSQL
`payment_decisions` as completion. It samples Kafka lag, Flink REST state/checkpoints/operator metrics,
PostgreSQL counters and Podman resources, then writes JSON and Markdown reconciliation reports. Counts/rates
are allowlisted, the target must be an explicitly configured loopback isolated environment, and 50,000
payments require a separate approval flag. The live API's server-owned event time means the increasing
investment pattern cannot compress 30 elapsed days; this limitation is reported rather than bypassed.

The separate `deployment/glaramara_orchestrate_load_test.py` mode selects only genuinely challenged payments
from an existing run and exercises the questionnaire/evidence application path. It is disabled by default,
bounded to 10–50 cases and concurrency one or two, and requires an explicit entitlement/cost acknowledgement.
It never makes a direct model call or changes the immutable original verdict.

Observed isolated smoke `smoke-20261107-codex01` used seed `20261107`, mixed traffic, 100 payments at target
10/s and concurrency eight. All 100 requests were accepted without retry or HTTP failure at achieved 10.103
submissions/s. All 100 raw and watermark outbox rows published on the first attempt, all 100 persisted Flink
evidence and authoritative decisions completed in 13.508 s (7.403/s), with 12 approved, 40 challenged and 48
blocked. API p50/p95/p99/max was 8.503/13.238/19.111/24.945 ms; persisted decision latency was
611.546/875.185/981.445/3612.126 ms. PostgreSQL peaked at 15 connections, two active, with no waiting lock or
deadlock. Nineteen Flink checkpoints completed with no failure or exception; all three jobs remained running.

The first smoke did not fully reconcile. All 100 valid LightGBM scores existed,
but the current Go correlator strict contract rejected all 100 deterministic events because the modified
producer includes unknown field `baseline_payment_verdict`. It durably published 100 DLQ records, leaving
100 ML-only partial assessments and no Go shadow action. Separately, Kafka was OOM-killed and restarted during
submission; post-run inspect showed `oom_killed=true`, cumulative restart count four, and a new start at
21:31:01 UTC. Lag later drained to zero and every service was healthy.

Both blockers are now resolved narrowly. Podman kernel diagnostics showed repeated `CONSTRAINT_MEMCG` kills
inside Kafka's 768 MiB cgroup, whose peak was exactly 805,306,368 bytes; the 12 GiB VM simultaneously had
7,660 MiB available and zero current PSI pressure. Kafka's heap remains 256/512 MiB and only the configurable
container limit changed to 1 GiB. The correlator now recognises optional baseline verdict/policy audit fields,
validates a present baseline verdict and otherwise preserves strict unknown-field rejection and existing
correlation semantics. The original 100 rejects remain committed and archived; offsets and DLQ were not
replayed.

Recovery run `smoke-20261108-recovery01` used the same seed/profile/rate with a unique identity. It accepted
100/100 without retry or error at 10.100 submissions/s, persisted 100 authoritative decisions in 13.166 s
(7.595/s), and reconciled in 4.948 s with 12 approved, 40 challenged and 48 blocked. Decision
p50/p95/p99/max was 648.556/857.533/972.861/3265.336 ms. All 100 LightGBM and deterministic branches were
correlated and all 100 transactions gained a latest Go shadow decision; seven differed from authority but
none changed it. Twelve assessments were `COMPLETE` and 88 correctly remained `PENDING_INVESTIGATION` while
still containing both policy inputs. There were zero new rejects, duplicate authoritative rows, duplicate
shadow evaluation IDs or ledger effects.

Kafka sampled at most 585.7 MB during the run; its cgroup peak including startup was 811,696,128 bytes of
1,073,741,824, with zero `memory.events` max/OOM counters, zero restart and no new kernel OOM. Transient sampled
lag peaked at 169 for Flink SQL and 94 for enrichment, then every required group drained to zero. All three
Flink jobs stayed `RUNNING` with zero failed checkpoint, exception or sampled backpressure. PostgreSQL peaked
at 14 connections/two active with no waits or deadlock. The original blockers are cleared for a separately
approved 1,000-payment test; 50 tx/s remains unproven and requires the same progressive health gates.

After explicit approval, 10 genuinely challenged smoke payments traversed the real Orchestrate application
path serially. Ten persisted `watsonx-orchestrate-rest` / `bedrock-mantle/google.gemma-4-31b` invocations all
validated and produced simulated reassessments plus personalised guidance, with zero retry, timeout or failure.
Persisted model latency p50/p95/p99/max was 5,111/7,258.55/8,079.71/8,285 ms. All 10 original decisions remain
`CHALLENGED`; all 100 load attempts remain simulated with `ledger_effect=NONE` and primary account balances
unchanged. Reports and operating detail are in `reports/load-tests/` and
[`glaramara-load-testing.md`](glaramara-load-testing.md).

Focused verification: six load-runner tests, Ruff, `make config`, both Go modules' unit tests and `go vet`
passed. Regression coverage includes current/legacy baseline fields, invalid and unknown fields, complete
deterministic+ML correlation, duplicate input suppression and shadow-decision construction. The final live
`make status` reported all required services healthy, three Flink jobs running and every reported consumer
lag zero.

## TechZone and agentic investigation foundation

On 4 November 2026, a read-only TechZone Gate 0 check found `oc` client 4.22.18 but could not resolve the
configured API endpoint. No cluster resources were applied or changed. The exact blocker and required
read-only verification are recorded in [`techzone-gate-0.md`](techzone-gate-0.md).

Repository work added Alembic `0016_agentic_lab`, an isolated deterministic three-partition Fraud
Investigation laboratory, and an idempotent `fraud-agentic-lab-seed` entry point. Its immutable future
waves distinguish `DISCOVERY`, `VALIDATION`, and `FINAL_HOLDOUT`; complete scenario groups stay within one
partition. This is a local data-boundary foundation only: no Orchestrate tools, browser endpoints, payment
path, customer Fraud Intelligence flow, or existing Phase D records changed. Focused generator/migration
tests and Ruff passed. OpenShift artifacts remain unapplied templates pending Gate 0.

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
single TechZone `fraud_intelligence` agent, strict evidence validation and a versioned deterministic
reassessment policy. The initial implementation used `customer-evidence-reassessment/1.0.0`; the current
evidence-driven path is described below. A questionnaire begins with three core questions and selects contact
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

### Live Fraud Intelligence visualiser

Alembic `0013_fraud_intel_view` and the Glaramara `System view` expose persisted transaction evidence through
a read-only, collapsible breakdown below the existing customer response. The toggle is scoped to the browser
session and persists across payment status and security-check navigation. When disabled, the retail journey
remains unchanged. When enabled, the same customer guidance remains in place and the breakdown groups observed
Flink signals/features, authoritative Python policy evidence, shadow-only LightGBM and Go evidence, watsonx
Orchestrate findings when present, and the original/reassessed payment outcome. A second collapsed
`Architecture flow` restores the live stage diagram, animated evidence paths and read-only evidence drawers
beside the customer journey on wide screens and below it on smaller screens.

New router decisions retain the already validated Flink payload in the existing immutable decision insert.
The inbox, decision, optional investigation and outbox still commit in one transaction before Kafka offset
commit; duplicate and conflicting evidence handling are unchanged. Historical rows are not rewritten. The
owner-scoped projection endpoint reports those rows as downstream-inferred or not observed instead of
inventing timestamps or features.

The UI reads only the existing owner-scoped projection. It omits unobserved components and does not synthesize
scores, features or statuses. Provider details use persisted provider/model/schema/latency values. Expanding
the breakdown cannot invoke Orchestrate, resubmit a payment or mutate the immutable decision.

Observed verification on 3 November 2026:

- Glaramara contracts: 32 passed; TypeScript and production build passed;
- mocked Playwright desktop/mobile: 26 passed and 6 explicitly opt-in cases skipped after mobile overflow
  regression verification;
- agents: 98 passed, 8 opt-in skips; Ruff passed; migration and router evidence-capture tests passed;
- Go correlator and shadow-engine tests plus `go vet ./...` passed in Go 1.24 containers;
- live payment `29827c14-399b-4856-8b77-9ec07815fa18` traversed the isolated development stack as
  authoritative `APPROVED` at `fast-path-policy/1.1.0`, correlation revision 2 and Go shadow `APPROVED` with
  model `lgbm-baseline-20261028T115824Z-abfd893e`; its validated Flink payload and assessment timestamp were
  retained and its fictional balance was unchanged;
- the live browser replay case passed against that payment with visible connector particles and no non-GET
  request during replay. Post-update status showed every required service healthy, both existing Flink job IDs
  still running and all consumer lags zero.

### Phase D: extensible AI-assisted fraud rule discovery

Phase D adds Alembic `0011_glaramara_phase_d`, append-only repair provenance in `0012`, and configurable
dataset identity/activation in `0017`, legacy-run association in `0018` and active-selection hardening in
`0019`. The fixed-seed synthetic fraud
laboratory retains immutable waves and snapshots; analysts can independently generate and select exact
8,000-, 10,000- or 20,000-row datasets. The standalone
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

Configurable-dataset verification on 4 November 2026 preserved the active 8,000-row legacy dataset and both
existing 8,000-row investigation snapshots, candidates and backtests. The migration associated matching
legacy runs by exact wave ID and row count without changing their manifests, hashes or results. The dedicated
Python worker generated all supported sizes through the authenticated API; API-request-to-`READY` timings
were 1.546 s / 1.945 s / 2.979 s for 8,000 / 10,000 / 20,000 rows. Pure generator timings were 0.226 s /
0.281 s / 0.565 s. Repeating an idempotency key returned the same dataset, a concurrent request returned
`409`, a stale generation transitioned to terminal `FAILED`, and a subsequent request succeeded. Temporary
10,000-row activation exposed exactly one 10,000-row wave while historical run JSON remained unchanged; the
8,000-row selection was then restored. No analysis endpoint or live Orchestrate call was made.

Current focused verification: agents 111 passed / 8 opt-in skipped with Ruff clean; Glaramara 43 contracts,
TypeScript and production build passed; four Phase D desktop/mobile browser cases passed; deployment 28
passed; Compose rendered and migrations applied through `0019`.

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

### Adaptive investment evidence refinement

Questionnaire `glaramara-fraud-questionnaire/1.2.0` separates personal familiarity from persisted beneficiary
history, asks neutrally who recommended, encouraged or instructed the payment, and always adds bounded origin
plus short reason questions for an investment. The former investment gap was questionnaire routing: only a
first-time beneficiary or velocity rule selected contact context, while investment purpose selected no
follow-up. Valid low-uncertainty investment evidence then reached no approved guidance category and fell
through to the generic safe template; neither behaviour originated in Gemma.

Evidence and reassessment contracts are `fraud-intelligence-evidence/1.2.0` and
`customer-evidence-reassessment/1.2.0`. The evidence enum now represents familiarity without treating it as
payment history, while the request continues to carry database-derived `beneficiaryPreviouslyPaid`
separately. The approved investment guidance recommends independent, proportionate checks without treating an
investment, social-media relationship, prior payment or customer-initiated conversation as proof of fraud or
legitimacy. Stored questionnaire `1.0.0`/`1.1.0` snapshots and policy handling of valid `1.1.0` evidence remain
compatible. The frozen `1.1.0` model benchmark was not rewritten and remains contract-incompatible with the
new enum.

Observed live correction on 6 November 2026:

- payment `952f2aa2-3bd9-42d2-8f57-399e28bc41c4` was immutably `CHALLENGED` by
  `FP-CHALLENGE-VELOCITY`; Flink evidence recorded five transactions in the one/two-minute windows;
- all eight questionnaire answers, including `investment_origin`, `investment_reason` and
  `pressure_or_secrecy=NO`, persisted before extraction;
- the first extraction received HTTP 200 from Gemma 4 but the deployed agent still emitted evidence `1.1.0`;
  strict backend validation correctly rejected it while the original verdict and `ledger_effect=NONE` held;
- after exporting the rollback definition, validating/importing agent `1.2.0`, live investment acceptance
  passed for both pressure `NO` and `YES`; the latter included `PRESSURE_OR_SECRECY` and both returned grounded
  evidence `1.2.0` from `bedrock-mantle/google.gemma-4-31b`;
- retrying the saved assessment completed on invocation two; repeating the extraction endpoint retained two
  invocations, eight answers, zero booked transactions and the original `CHALLENGED` verdict.

## Orchestrate boundary

Repository source under `watsonx-orchestrate/fraud-intelligence/` manages the Phase C agent; source under
`watsonx-orchestrate/fraud-rule-discovery/` manages the separate Phase D agent. AskOrchestrate was not
modified. Neither agent has deployment authority. Model changes must be measured against the
appropriate strict local schema before importing only the intended agent into development.

## Automatic customer reassessment journey

Submitting the final selected questionnaire answer now starts the existing server-side Fraud Intelligence
extraction and controlled reassessment automatically. The customer moves directly to a Glaramara review
screen; lightweight polling follows the durable investigation state and displays the existing result when the
controlled policy has finished. Refreshes recover pending or processing work, answer and extraction replays
are idempotent, and stale processing can be reclaimed within the existing two-invocation budget. A slow review
keeps an explicit in-progress message, while a failed review states that the payment was not approved and
offers a bounded retry when one remains.

The customer result no longer exposes policy versions, internal verdict names, reason codes or API language.
Those fields remain in the persisted evidence/reassessment records and owned server response for developer and
analyst inspection. The initial deterministic verdict, append-only reassessment, simulated ledger boundary,
LightGBM shadow score, Go shadow action, Fraud Intelligence contract and AskOrchestrate are unchanged.

Observed verification on 3 November 2026:

- Glaramara unit/contracts: 28 passed; TypeScript and production build passed;
- focused desktop/mobile Playwright: 10 passed, covering completed/cleared, declined, Orchestrate failure,
  duplicate answer submission and refresh recovery, with the existing adaptive and accessibility assertions
  retained.

## Evidence-driven reassessment v1.1

Alembic `0014_evidence_reassessment` preserves historical Phase C rows and adds compatible
`ADDITIONAL_VERIFICATION` and `REFER_TO_ANALYST` outcomes plus an immutable JSON policy trace.
`fraud-intelligence-evidence/1.1.0` records purpose, third-party influence, explicitly customer-stated
verification claims, scam indicators, uncertainty and exact answer excerpts. The backend rejects an excerpt
that is not present in its cited persisted answer. Agent `fraud_intelligence/1.1.2` remains extraction-only;
`customer-evidence-reassessment/1.1.0` owns the simulated outcome.

The narrow service-payment demonstration rule never treats self-report as proof of safety: it requires a
recognised payment, new beneficiary, goods/services purpose, all three stated verification claims, acceptable
influence, low uncertainty and no indicator, then requires independent beneficiary verification. High-risk
rules run first. All incomplete, unreliable, unmatched or malformed evidence refers to an analyst.

The System view's Orchestrate drawer joins only persisted data: the exact customer explanation, extracted
findings, indicators and source excerpts, matched deterministic conditions, and simulated action. AI findings
and deterministic policy are explicitly labelled. Replay remains a read-only animation of the fetched
timeline and performs no provider invocation or investigation mutation.

Observed verification on 3 November 2026:

- the development `fraud_intelligence` agent alone was updated; AskOrchestrate was untouched;
- live REST builder: 5,097 ms, `NONE`, rule
  `CER-ADDITIONAL-VERIFY-NARROW-SERVICE-PAYMENT`, outcome `ADDITIONAL_VERIFICATION`;
- live REST safe-account scam: 5,302 ms, `BANK_IMPERSONATION`, `SAFE_ACCOUNT`, `URGENCY`,
  `PRESSURE_OR_SECRECY`, `UNEXPECTED_CONTACT`, rule `CER-DECLINE-SAFE-ACCOUNT`, outcome `DECLINED`;
- live REST ambiguous evidence: 4,135 ms, beneficiary `UNCERTAIN`, uncertainty `MEDIUM`, rule
  `CER-REFER-UNRELIABLE-EVIDENCE`, outcome `REFER_TO_ANALYST`;
- production REST chat-completions evaluation passed 3/3 (mean 4,845 ms, median 5,097 ms, max 5,302 ms);
- a real family-help journey initially failed closed because REST returned `UNEXPECTED_CONTACT` in the
  influence field. The agent mapping and acceptance harness were corrected, the saved retry persisted valid
  `UNEXPECTED` influence plus `UNEXPECTED_CONTACT` and `PRESSURE_OR_SECRECY` indicators, and the policy
  selected `REFER_TO_ANALYST` for medium uncertainty. The original verdict remained `CHALLENGED`;
- Glaramara unit/contracts 33 passed, production build and TypeScript passed; desktop/mobile Playwright
  26 passed with 6 opt-in tests skipped; agents 99 passed with 8 opt-in tests skipped and Ruff passed;
- Migration `0014_evidence_reassessment` remains the evidence-policy boundary; the later guidance-only
  migration moves the current Alembic head to `0015_fraud_guidance`. All reassessments remain simulated with
  original `CHALLENGED` provenance and `ledger_effect=NONE`.

## Personalised fraud-prevention guidance v1.0

On 9 November 2026, persisted investigation `b16a81a8-435c-4faf-8a08-8e800c8580ed` exposed a family travel
emergency extraction gap. The single Gemma call succeeded in 7,768 ms and returned schema-valid evidence with
verbatim provenance, but emitted only `THIRD_PARTY_BENEFICIARY`. It preserved the bounded
`beneficiary_relationship=UNSURE` as `UNCERTAIN` and therefore set uncertainty to `MEDIUM`; policy correctly
matched `CER-REFER-UNRELIABLE-EVIDENCE`. Because no urgency finding reached guidance, the renderer selected
`UNCERTAIN_OR_INCOMPLETE` and displayed its safe generic fallback. This was not a provider, retry, schema or
excerpt-validation failure.

Agent `1.2.1` now explicitly treats described travel emergencies, loss of access to phone or money and urgent
financial or travel assistance as customer-reported urgency, and retains explicit friend/intermediary
withdrawal arrangements as third-party-beneficiary evidence. The deterministic fixture mirrors those reusable
semantics. Family guidance remains cautious about identity, uses a previously trusted contact method and adds
a third-party-account warning when that source-linked finding is present. The evidence schema, reassessment
policy, questionnaire, authoritative payment rules and ledger boundary are unchanged. Glaramara's 59 unit and
contract tests and TypeScript check passed, including the exact family case, reported independent family
verification, both investment paths, bank impersonation, legitimate payment and malformed/unsupported
evidence fallbacks. No live provider call was made for this correction.

Alembic `0015_fraud_guidance` adds nullable version and JSON payload fields to the immutable reassessment
record. New reassessments persist `fraud-prevention-guidance/1.0.0`: selected category, source finding IDs and
provenance, approved template identifiers/versions, exact customer statement (when one was saved), rendered
heading/context/steps/status and the simulated outcome. Historical rows remain readable with no fabricated
backfill. Replay reads the stored payload and performs no extraction or message generation.

Guidance composition is deterministic and downstream of policy. High-risk bank/safe-account and
family/trusted-person impersonation patterns take precedence. Unavailable, contradictory or insufficient
evidence falls back safely before purpose-specific selection; supported investment purpose then takes
precedence over category-neutral unexpected-pressure copy. The narrow service-payment path and high-value
first-beneficiary check remain distinct. Urgency and pressure can qualify investment wording but cannot
independently select impersonation guidance. Free text is displayed only as escaped, explicitly customer-reported
content and cannot change an approved template. Customer copy exposes no internal enums, confidence, rule IDs
or callback promise; every message states that no payment was sent and the journey is simulated.

The retail result now shows the actual saved statement, contextual concern, three protective steps, payment
status and review route. The System view adds a persisted `Prevention guidance` node after the simulated
outcome and exposes the complete evidence → policy → template trace to technical viewers.

Observed verification on 3 November 2026:

- no Orchestrate instructions or deployment changed; the existing evidence contract was sufficient and
  AskOrchestrate remained untouched;
- a real REST-path family-help extraction returned schema-valid v1.1 evidence in 4,721 ms with
  `UNEXPECTED_CONTACT` and `PRESSURE_OR_SECRECY`; policy matched
  `CER-DECLINE-PRESSURE-SECRECY` and guidance selected
  `FAMILY_OR_TRUSTED_PERSON_IMPERSONATION` from the persisted purpose and indicator findings;
- the live record retained authoritative `CHALLENGED`, `ledger_effect=NONE` and `is_simulated=true`;
- Glaramara unit/contracts: 40 passed; TypeScript and production build passed; focused desktop/mobile
  customer and System-view Playwright: 12 passed, including accessibility and mutation-free replay. The full
  Playwright suite passed 26 with 6 explicitly opt-in live tests skipped;
- migration tests: 4 passed with Ruff clean; the development database is at `0015_fraud_guidance` and a
  database audit found zero altered original verdicts, ledger effects or non-simulated reassessments. Fourteen
  historical rows remain readable with null guidance; the one new live row has exactly one extraction and one
  reassessment after repeated read-only projection calls.

## Fraud Intelligence evaluation Phase A baseline

The 5 November 2026 tenant-model comparison used isolated evaluation agents and the production-equivalent
REST chat-completions path without changing the deployed `fraud_intelligence` agent. A hidden callable
`watsonx-orchestrate/frontier` alias resolved to Claude Sonnet 4.6 and did not outperform the Groq baseline.
Gemma 4 31B led the measured campaign at 28/30 original and 16/18 held-out exact scenario accuracy with 6/6
semantic repeat consistency, but no production model change is recommended without an independent rerun and
operational entitlement/SLO confirmation. Detailed metrics and raw-response locations are in
`watsonx-orchestrate/fraud-intelligence/evaluation/MODEL-BENCHMARK-2026-11-05.md`.

Verified on 5 November 2026 without changing the agent, evidence contract, policy, guidance or payment
boundaries. `watsonx-orchestrate/fraud-intelligence/evaluation/` now contains a reproducible 30-scenario suite
covering investment, bank impersonation, family emergency, romance/purchase, legitimate, ambiguous,
contradictory and adversarial cases. Every case declares structured expectations, required/forbidden
indicators, uncertainty, provenance, deterministic policy and grounded-guidance assertions.

The 6 November 2026 follow-up traced the declared 29/30 guidance failure to deterministic template priority,
not Gemma extraction or deployment drift. The live row used questionnaire, agent, evidence and reassessment
version `1.2.0`; Gemma persisted source-linked `INVESTMENT` and `URGENCY` without bank impersonation, while
guidance `1.0.0` selected the earlier generic-pressure branch. Investment now takes precedence over that branch,
supported urgency is rendered as an investment risk qualifier, and generic pressure copy no longer asserts
impersonation. Six regression scenarios cover urgent and non-urgent investments, bank impersonation, a
legitimate expected-contact investment, unknown-purpose pressure and insufficient investment evidence.

A bounded live comparison used the standalone ADK path and Glaramara's REST chat-completions path for that
same case. Both produced schema-valid v1.1 evidence in 5,829 ms / 5,922 ms, agreed on investment purpose,
unexpected influence, urgency and pressure, and invented no bank impersonation. Both omitted the separately
required `INVESTMENT` scam indicator and its provenance, so both extraction runs failed while demonstrating
semantic transport parity. The other 29 extraction scenarios are explicitly not run.

Native Orchestrate evaluation-framework 1.5.2 was installed and exercised against the real agent. Its exact
payload smoke case produced zero agent steps and failed journey success because the framework treats the
literal `END` inside the valid `FRIENDS_FAMILY` option as a conversation terminator. This is reported as an
unsupported evaluator path, not an agent pass or extraction result. See
[`evaluation/BASELINE.md`](../../watsonx-orchestrate/fraud-intelligence/evaluation/BASELINE.md).

### Phase A.1 reliability follow-up

Phase A.1 traced the investment omission end to end. Both transports received the bounded investment answer
and returned investment purpose, proving that serialization and transport were intact; the model omitted a
cross-field invariant that JSON Schema cannot encode. Only the development `fraud_intelligence` definition
was updated to 1.1.1, making investment indicator/provenance consistency explicit and prohibiting unsupported
bank impersonation. AskOrchestrate, the evidence schema, policy, guidance, payment authority and ledger were
unchanged.

Post-update, the mandatory influencer case passed direct ADK and Glaramara-compatible REST assertions and
three additional REST runs. A resumable REST campaign executed all 30 scenarios: 44 actual calls yielded 42
schema-valid structured responses and two retained no-evidence failures that succeeded on retry. Exact
scenario grading was 17 pass / 13 fail. Six selected high-risk scenarios ran three times; none was byte-for-byte
stable, five were semantically stable after normalizing ordering and claim wording, and one varied only in
whether it recorded an adversarial-text contradiction. Deterministic reassessment remains 30/30; guidance
remains 29/30 plus the declared investment impersonation-copy failure.

Framework investigation found no termination configuration and confirmed the same raw `END` substring check
in the published evaluation-framework 1.7.0 wheel, so a non-pinned upgrade would not repair native execution.
The exact native dataset remains intact and REST remains the supported executable baseline path. Remaining
failures include `EXPECTED` contact collapsing to `NONE`, missing third-party-beneficiary and contradiction
indicators, bounded-value drift, and transient missing structured output. Phase B should not proceed as an
unqualified extraction release until those limitations have an agreed acceptance threshold or correction.

### Phase A.2 evidence hardening

Phase A.2 froze and classified all 13 Phase A.1 failures before changing instructions. Selected agent 1.1.2
preserves bounded mappings, treats narrative evidence additively and retains contradictory sources.
Glaramara's existing evidence validator now rejects explicit bounded-field, bounded-indicator and uncertainty
invariant violations instead of modifying model evidence. The schema, policy, guidance and payment boundaries
remain unchanged.

The selected original-suite run improved from 17/30 to 24/30 exact scenario passes and from 28/44 to 35/43
invocation passes. One initial call produced no evidence and two responses had invalid source-less `NONE`
provenance. Repeat semantic stability fell from 5/6 to 2/6 and unsupported indicators remained observable.
An experimental 1.1.3 revision regressed to 17/30, was rejected, and the development tenant was restored to
1.1.2.

An 18-scenario unseen set was authored only after selecting 1.1.2, hashed before its first call and never used
for further tuning. It passed 10/18 exact scenarios and 11/19 invocations; 18 calls returned structured output
and 16/19 were strict schema/provenance valid. Phase A.2 made 104 total live REST calls across selected, rejected and
unseen runs. Deterministic policy stayed fully passing and the known guidance defect remains declared. The
generalisation result is insufficient for Phase B readiness. See
[`PHASE-A2-REPORT.md`](../../watsonx-orchestrate/fraud-intelligence/evaluation/PHASE-A2-REPORT.md).

## Fraud Lab availability-message correction

On 6 November 2026 the Synthetic Fraud Lab retained its active 20,000-transaction dataset and dashboard
metrics, but a discovery run failed strict proposal validation at `supportingEvidenceRefs`. The analyses API
passed that domain error through the generic API fallback as HTTP 503 with "The fictional banking service is
temporarily unavailable." The client correctly retained the last dashboard state, which made a scoped
analysis failure look like a contradictory banking outage.

The analyses route now maps only `FraudRuleDiscoveryInvalidProposalError` to HTTP 422
`FRAUD_LAB_INVALID_PROPOSAL`, explicitly stating that the proposal was stopped safely and the banking service
remains available. Proposal validation, the discovery agent contract, questionnaire/Gemma contracts, Flink
rules and payment policy are unchanged. Observed verification after rebuilding only Glaramara:

- `make status`: every required service ready, both Flink jobs running and reported consumer lag zero.
- customer session, dashboard, activity, beneficiaries, health and Fraud Operations APIs returned HTTP 200;
  the active dataset remained `2ce20995-4996-4c17-a9fa-3d2d3277fc24` with 20,000 transactions.
- `make glaramara-smoke-test`: passed with deterministic `APPROVED`, both payment outbox events published,
  unchanged balance and no booked banking transaction.
- the persisted questionnaire 1.2.0 investment payment remained deterministically `CHALLENGED`, exposed all
  eight saved answers and a completed reassessment with `ledgerEffect: NONE`.
- focused Phase A/D contract tests passed 19/19, TypeScript type-check and the production Next.js build passed.

The failed discovery run remains failed by design; correcting the rule-discovery agent's invalid proposal is
separate from banking availability and was not attempted here.

### Fraud Rule Discovery diagnostic evidence and reliability measurement

On 6 November 2026, migration `0020_fraud_discovery_diagnostics` added an additive, analyst-only durable
diagnostic record for every future failed Rule Discovery run. It captures the configured agent/model/contract
provenance, invocation/structural/semantic stage, bounded credential-redacted provider completion snapshot,
extracted proposal, Zod issue code/path/message/expected type, evidence-reference mismatch details, supporting
evidence field state and latency. The record is available only through the existing analyst run-detail route;
customer-facing invalid-proposal responses remain the concise HTTP 422 `FRAUD_LAB_INVALID_PROPOSAL`.

The existing 20,000-row active dataset was then held fixed for 15 independent live Orchestrate calls using
the configured GPT-OSS-120B Rule Discovery agent. All 15 completed structural validation, evidence grounding
and deterministic held-out backtesting. There were no invocation, structural, semantic or backtest failures;
first-attempt validity was 15/15 (100%), agent-latency p50 was 4,659 ms and p95 was 6,657 ms. The 15 immutable
run snapshots each recorded 20,000 rows; no rule was approved, activated or deployed. This small sample does
not justify implementing automatic retries. See `deployment/fraud_lab_reliability_evaluation.py` for the
bounded repeatable measurement path.

## Limitations and outstanding work

### Slow-building APP beneficiary demonstrator

On 6 November 2026, the Java DataStream pipeline added an incremental, event-time
`SLOW_BUILDING_BENEFICIARY_RISK` assessment. A customer-beneficiary keyed stage retains an inclusive trailing
30 days and emits exact payment count, cumulative GBP, successive-growth/pair counts, current-to-first ratio,
observed relationship age, window bounds and applied thresholds into the single transaction assessment. State
and transaction-ID deduplication are pruned after 30 days plus the two-second out-of-order allowance. The
existing user-keyed 1/2/10-minute signals and their thresholds are unchanged.

Default conditions require all of: four payments, £4,000 cumulative, three strictly growing successive pairs,
a current/first ratio of four and 21 observed days. A checked-in 55-transaction, 12-scenario held-out fixture
found four additional fraud-labelled payments and two additional legitimate challenges; candidate precision
was 0.6667 and combined recall rose from 0.0938 to 0.2188. False positives were escalating family support and
an unusual legitimate escalation. This evidence supports only a gated technical demonstration, not ordinary
traffic or a production-ready control. The five-payment replay first signals on payment five (£3,000; £5,850
rolling exposure, four growth pairs, 15x current/first and 28 observed days).

The analyst-only control publishes real Kafka records through the transactional outbox to isolated replay
raw/enriched topics. A separate Flink job, UIDs, consumer group, replay key and monotonically reserved synthetic
event-time ranges prevent replay history from moving the live watermark and allow repeated runs without reset.
Only the isolated router accepts `SLOW_BUILDING_DEMO_POLICY_ENABLED=true`; it refuses any non-replay input topic
and records policy `fast-path-policy/1.2.0-slow-building-demo`. Live policy `1.1.0` observes but does not act on
the new signal. The final replay record is a simulated, no-ledger payment attempt so an immutable challenged
decision can reuse questionnaire 1.2.0 and the existing Gemma integration; no new AI agent or question was
added.

For a slow-building challenge, questionnaire routing also selects the existing bounded `contact_influence`
question even though the beneficiary has been paid before. This closes a contract gap in which Gemma could
correctly return `thirdPartyInfluence = UNCERTAIN` but could not cite a customer answer for the mandatory
finding. The investigation snapshot now keeps the actual Flink signal separately from deterministic policy
rule IDs and retains a bounded copy of the slow-building payment count, cumulative exposure, growth count,
ratio and observed age. Validated customer evidence and those Flink-derived facts remain separate inputs to
guidance: the former can support claims about influence or pressure, while the latter can describe only the
observed repeated and increasing payment pattern.

A live diagnostic replay of the previously failing request reproduced the exact rejected provenance item
(`thirdPartyInfluence.sources = []`). The corrected canonical request returned source-linked
`RECIPIENT_INFLUENCED`, citing the bounded `contact_influence` answer, with only the supported `INVESTMENT`
indicator. No model or agent configuration was changed. This correction is implemented and verified locally;
it has not been deployed to the running demonstration.

Observed repository verification: Java build and 13 tests passed; Python unit/contract suite 115 passed with
8 opt-in integration skips; Flink/generator/backtest suite 22 passed with 8 Kafka integration skips; deployment
lifecycle suite 31 passed; Glaramara contract tests 56 passed; TypeScript typecheck, production build and
Compose render passed. Live Gemma diagnostic requests were made against the unchanged agent to reproduce and
verify the questionnaire contract correction, but no application image or Flink job was deployed as part of
that investigation. The committed local timing is an in-process batch measurement, not Kafka/Flink latency
evidence.

### Gemma primary-model promotion

On 6 November 2026 the existing `fraud_intelligence` agent changed only its `llm` from
`groq/openai/gpt-oss-120b` to the independently benchmarked
`bedrock-mantle/google.gemma-4-31b`. Pre/post tenant exports confirmed unchanged identity, endpoint,
instructions, planner style and structured-output schema. The import retained the existing agent identity,
and an importable Groq rollback definition was captured first.

Six frozen cases then passed the Glaramara REST path 6/6 for extraction, simulated reassessment and grounded
guidance with no API failure. Latency was 4,300–10,815 ms (mean 7,666 ms). The runner has no banking database,
Kafka, verdict or ledger write path, so the acceptance created no payment or balance effects. Historical
50-case benchmark evidence remains distinct from this focused post-promotion acceptance. See
`watsonx-orchestrate/fraud-intelligence/evaluation/GEMMA-PROMOTION-2026-11-06.md`.

- Native Orchestrate Stage A now has a hash-guarded converter for the frozen independent 50-case dataset and
  three representative outputs validate against evaluation-framework 1.5.2's `TestCase` model. Native
  execution remains gated by the raw `END` substring collision with `FRIENDS_FAMILY`; no full campaign was
  run. CLI artifacts were not confirmed to populate SaaS Evaluate or Control Plane Quality, and the tenant
  token was expired during the 6 November read-only refresh. See
  `watsonx-orchestrate/fraud-intelligence/evaluation/NATIVE-ORCHESTRATE-FEASIBILITY.md`.
- A subsequent complete-input scan found no safe frozen subset: although 13 scenarios select
  `FRIENDS_FAMILY`, all 50 exact requests include it in the questionnaire options. The generated compatible
  manifest records 0 included and 50 excluded. The required three-case proof was therefore not invoked and
  no native metrics or UI records were produced.
- An explicitly labelled modified-input follow-up removed that unused option only in generated copies and
  excluded the 13 selected-answer cases. All 37 remaining cases executed with nonzero native LLM steps for
  isolated Gemma, Groq and Frontier agents. Strict fraud-harness results were 32/37, 22/37 and 26/37;
  temporary agents were removed. Browser permissions prevented visual SaaS Evaluate/Quality confirmation,
  while the CLI reported disk-only persistence. See
  `watsonx-orchestrate/fraud-intelligence/evaluation/NATIVE-MODIFIED-INPUT-CAMPAIGN-2026-11-06.md`.

- Repository Python targets 3.11; Phase 0's existing `agents/.venv` was 3.14.3. Retain pinned 3.11 CI.
- LightGBM and thresholds are synthetic/uncalibrated. There is no production feature store, synchronous
  fraud API, HA/TLS/backup design or operational SLO.
- Delivery is at least once. Physical Kafka duplicates remain possible; stable IDs and uniqueness matter.
- Java enrichment still logs genuinely late events rather than publishing a durable late-event contract.
  Phase B closes each sporadic UI event with a delayed marker ordered after raw publication; it does not change
  the general late-event policy.
- The isolated replay job restarts at the replay topic end rather than restoring replay state. A restart during
  an in-flight run can leave that immutable run pending; a fresh run uses a new key and reserved event-time range.
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
- Banking/Phase C/D/system view: `agents/migrations/versions/{0006_glaramara_banking,0007_glaramara_phase_b,0008_raw_event_time_clock,0009_release_banking_watermarks,0010_glaramara_phase_c,0011_glaramara_phase_d,0012_fraud_lab_wave_supersession,0013_fraud_intelligence_visualiser}.py`,
  `glaramara-bank/lib/{server,fraud-intelligence}/`, `glaramara-bank/app/api/v1/payments/`,
  `glaramara-bank/app/api/v1/fraud-operations/`, `glaramara-bank/lib/fraud-rule-discovery/`,
  `agents/src/fraud_agents/fraud_lab/`, `watsonx-orchestrate/{fraud-intelligence,fraud-rule-discovery}/`

At later milestones, update this handoff with observed commands/results, the system overview for
flow changes, and the nearest component README. Link evidence instead of duplicating logs.
