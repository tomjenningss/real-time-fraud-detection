# Glaramara Phase D — AI-assisted fraud rule discovery

Verified on 2 November 2026. This phase is a customer-facing technical POC over fictional synthetic data. It
does not alter the authoritative fraud pipeline or deploy generated controls.

## Implemented architecture

Alembic `0011_glaramara_phase_d` adds six isolated tables for immutable wave manifests and transactions,
snapshot-bound discovery runs, validated candidates, backtests and append-only reviews. Revision `0012` adds
append-only supersession records so a flawed immutable simulation wave can be preserved but excluded from new
snapshots. No Phase D table references customer banking, the shared outbox, balances or payment decisions.

The initial generator uses Python 3.11, a fixed seed, UUIDv5 identities and raw chronological events. Complete
customer/scenario groups receive a 70/30 discovery/evaluation assignment. It includes ordinary activity,
existing velocity/hopping/high-value cases, fraud-labelled extended payments to several new beneficiaries,
and genuine lookalikes. Labels are generated independently from baseline actions. The existing LightGBM
50,000-row corpus is unsuitable because its model-ready rows do not retain the raw beneficiary histories or
scenario groups needed for leakage-safe temporal discovery.

`make up` runs Alembic and idempotently seeds the initial 8,000 rows under a PostgreSQL advisory lock. A
matching replay is a no-op; a mismatched immutable manifest fails closed. `make fraud-lab-next-wave` adds a
fixed 6,000-row beneficiary fan-in period with legitimate shared-payee lookalikes. It uses no new service,
Kafka topic or Flink state.

Each analysis captures active wave IDs, digests, counts and a canonical snapshot hash before report
construction. Only `DISCOVERY` rows feed `fraud-discovery-report/1.0.0`; the report has at most 50 cohorts and
16 pseudonymous examples plus supported features and prior proposal fingerprints. Held-out rows and metrics
are absent. The `EVALUATION` query runs only after local validation and candidate persistence.

The standalone `fraud_rule_discovery` agent has no tools, collaborators, memory, database access or deployment
authority. Server-side IAM/REST uses the existing credential names but separate agent/model/timeout settings.
Local `fraud-rule-proposal/1.0.0` validation permits one-to-five `ALL` conditions, numeric safe operators,
allowlisted state-derived features and supported ISO windows; it rejects unknown evidence, features, windows,
OR/NOT, SQL, code and free-form expressions. Application code records authoritative provider and latency.

The evaluator rebuilds customer, customer-beneficiary and beneficiary features in timestamp/UUID order and
persists candidate-only, baseline and baseline-plus-candidate confusion matrices and incremental counts. Its
semantics are deterministic and reproducible, but it does not claim to reproduce Flink watermarks, late-event
side outputs, checkpoints or physical delivery duplicates.

The signed demo session is backward compatible. Only the server-recognised
`fraud-analyst-alex-morgan` persona receives `FRAUD_ANALYST`; customer sessions cannot access the page or API.
The dashboard displays waves, runs, evidence, conditions, examples and honest backtest trade-offs. Reviews
derive the reviewer from the signed session and are terminal append-only records. The only approval state is
`APPROVED_FOR_IMPLEMENTATION`.

## Live result

Run `1dec13bd-18cb-40a9-ab59-e6d4166cf0c6` snapshotted 8,000 active rows under hash
`ea1fa51479254b370d29f7999a7947ac9bdae29c3e0a5b513c866c2b8ef20719`. The TechZone standalone agent
`d67de40f-7ff4-4906-8e21-83425e7f2840`, model `groq/openai/gpt-oss-120b`, returned a schema-valid candidate in
6,082 ms: challenge higher-value events when at least four distinct merchants appear within two minutes.
This was not a predetermined generator rule.

On the 2,400 held-out transactions the computed results were:

| Evaluation | TP | FP | TN | FN | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|
| Existing baseline | 25 | 7 | 2,245 | 123 | 78.13% | 16.89% |
| Candidate only | 14 | 6 | 2,246 | 134 | 70.00% | 9.46% |
| Baseline + candidate | 30 | 9 | 2,243 | 118 | 76.92% | 20.27% |

The incremental result was five fraud-labelled payments detected, two genuine payments challenged and 13
events overlapping the baseline. Alex Morgan approved candidate
`d3bfc928-05d4-43f8-b54b-3fb55b4cc2b6` for future implementation. The UI confirmed that no live fraud
controls changed.

The optional wave command added calendar-Q1 `fraud-lab-wave-2027q1-v2` with 6,000 rows, seed `20270115`,
generator `fraud-lab-generator/1.0.2` and digest
`968bc228058ce65b86af09fc1eaec7325195b3175bef0658cf0d35774db617a3`. A second execution returned
`replayed=true`. Active history is 14,000 rows. Append-only supersession retains two development-time drafts
whose scenario/period manifests were corrected; old runs and all three candidates/backtests and two reviews
remain durable and reproducible.

## Verification

Focused contract tests cover deterministic digests, group isolation, both partitions, legitimate lookalikes,
unsafe proposals, evidence references, fingerprints, chronological evaluation, API/session role boundaries,
immutable snapshots and migration safety. Observed regression results were: agents 96 passed / 8 opt-in
skipped and Ruff clean; Glaramara 26 contract tests, TypeScript and production build passed; Playwright 16
desktop/mobile cases passed / 4 opt-in cases skipped; Java/Flink 8 Maven tests plus 15 Python unit tests passed
with 6 Kafka integration cases skipped; both Go modules passed `go test ./...` and `go vet ./...`; deployment
27 passed; Compose rendered successfully. The one-shot migration/seed replay returned the audited supersession
without changing rows. Final `make status` reported every required component ready, both existing Flink jobs
running and all reported consumer lag zero. The live run additionally demonstrated IAM authentication, strict
local validation, held-out evaluation, durable approval and customer `403` rejection.

## Known limitations

- This is a credible POC, not a calibrated fraud-control design. Synthetic labels and measured trade-offs do
  not establish production performance.
- Analysis is synchronous HTTP work; a production system would use a durable worker/queue and explicit retry
  controls.
- Planner style is deprecated in the current Orchestrate ADK but retained for structured-output support.
- The evaluator is bounded batch simulation, not operational Flink replay.
- Approval has no activation state and intentionally does not deploy anything.

## Incremental-wave live validation

On 2 November 2026, run `810ae2fe-7a9f-4f83-a188-23dee7fa7d1c` captured the current two-wave snapshot:

- `fraud-lab-wave-2026q4-v2`, 8,000 rows, digest
  `968600e3351341958085e74c852999e1de9cfff76c97378b454557e2d66cb915`;
- `fraud-lab-wave-2027q1-v2`, 6,000 rows, digest
  `968bc228058ce65b86af09fc1eaec7325195b3175bef0658cf0d35774db617a3`.

The canonical snapshot hash is
`63ffcd35c5765a11f2dd69acc5b98d23c76f8ce8aabfa4c372bd6ff1216a8b29`. The persisted discovery report
contains 9,800 rows, declares `DISCOVERY_ONLY`, and contains neither an evaluation section nor backtest metric
names. The backtest separately evaluated 4,200 rows and records the same snapshot hash.

The live agent proposed `FRD-001`, “High volume of new beneficiaries with large total amount,” with both
conditions joined by `ALL`:

- `customer_distinct_new_beneficiary_count GTE 5` over `PT24H`;
- `customer_new_beneficiary_total_gbp GTE 2500` over `PT24H`;
- action `CHALLENGED`.

Fingerprint `a64899445cc42d2c99a7050c295f65646296580138f423ece78a342707a4b55e` has no
`duplicate_of_candidate_id`, so it is novel relative to the three earlier persisted candidates. The agent
completed in 4,838 ms. On the held-out data, baseline TP/FP/TN/FN was 44/12/3936/208 (precision 78.57%, recall
17.46%); candidate-only was 15/17/3931/237 (46.88%, 5.95%); combined was 59/29/3919/193 (67.05%, 23.41%).
Incrementally it detected 15 additional fraud-labelled payments, challenged 17 additional genuine payments
and overlapped zero baseline detections. The candidate remains `BACKTESTED`, with no review or deployment.

The discovery report now names the three active deterministic signals separately under
`controlContext.activeDeterministicControls`. Every historical candidate carries
`deploymentStatus=NOT_DEPLOYED` and `relationshipToActiveControls=CANDIDATE_ONLY`; the report explicitly says
that `APPROVED_FOR_IMPLEMENTATION` is pending engineering work only. The live rationale correctly compared the
candidate with active `HIGH_VELOCITY`, `MERCHANT_HOPPING` and `NEW_BENEFICIARY_HIGH_VALUE` controls and did not
describe either approved candidate as active.

The two historical failed runs were both pre-backtest contract failures. Run
`8e55c7cd-f51a-4e31-98b3-531dd73da80d` used a parser that accepted only an exact schema-version field and
whole-string JSON; its live response contained no extractable schema-versioned proposal. Run
`6099591d-dab8-4cc6-b59f-6f4a5d965b0a` used the broadened nested/JSON-substring parser, but the response still
contained neither the schema version nor the fallback rule-identifier/conditions structure. Both were rejected
before candidate persistence, and the held-out query was never run. Their original response bodies were
intentionally not persisted, so finer field-level reconstruction is not possible; the historical rows recorded
only generic `Error`. The agent instructions were strengthened without relaxing Zod validation, and current
integration errors now persist distinct HTTP, missing-proposal or invalid-proposal error types. Two later live
runs, including the two-wave run, passed the strict contract.

The dashboard now labels 14,000 as the current active dataset and labels each run count as its historical
snapshot. When an 8,000-row run is opened, the detail shows both “Historical analysis snapshot: 8,000” and
“Current active dataset: 14,000.” Focused desktop/mobile Playwright coverage passes for this distinction.

## Future Flink activation design

An approved candidate would first become an engineering-owned, versioned Java rule and test fixture. The
implementation must generate a transaction-scoped signal inside `payments.enriched.demo`; publishing only to
`fraud.signals.demo` is insufficient because the Python router does not consume that topic. The enriched
schema and router allowlist/policy version would change together, retaining combined velocity/hopping
hard-block precedence and immutable verdict behaviour.

Before rollout, engineering would verify threshold semantics, event-time/watermark behaviour, deterministic
IDs, duplicate handling, savepoint compatibility and old/new schema interoperability. Deployment would use a
controlled shadow/canary period, explicit metrics and a tested rollback to the previous job artifact, policy
and savepoint. Phase D implements none of Kafka configuration topics, Flink Broadcast State, generated code,
dynamic compilation or automatic deployment.
