# Shadow Action Selection milestone report

Validated on 28 October 2026 with policy `fraud-action-policy-v1` and controlled run
`shadowv1-20261028T1605Z`.

## 1. Files

Created `fraud-decision-engine/` with the Go module, container image, pure `internal/policy` package,
correlated assessment and shadow output contracts, durable PostgreSQL store/outbox, revision ordering,
metrics, HTTP service, tests, operating guide, and evaluation report. Created Alembic migration
`agents/migrations/versions/0005_shadow_decision_engine.py`.

Modified the root README, architecture guide, decisioning README and Compose file, and topic creation
and inspection scripts. Existing deterministic decision, LightGBM, correlator and Claude code was not
changed.

## 2. Kafka topics and contracts

- Input: `fraud.assessments.correlated.demo`, schema `1.0.0`, keyed by `transaction_id` by the correlator.
- Output: `fraud.decisions.shadow.demo`, schema `1.0.0`, keyed by `transaction_id`.
- Rejected input: `fraud.decisions.shadow.dlq`, schema `1.0.0` sanitized validation envelope.

The output includes stable evaluation/event identity, transaction and source assessment identity,
source revision, policy version and configuration, proposed and original actions, disagreement,
signals and deterministic rule IDs, structured reasons, model metadata, provenance, optional
investigation audit context, evaluation time/latency and status. PostgreSQL plus an outbox provides
durable processing and at-least-once publication; consumers deduplicate by `shadow_evaluation_id`.

## 3. Decision matrix

| Original verdict | ML probability | Shadow action |
|---|---:|---|
| `APPROVED` | `< 0.24` | `APPROVED` |
| `APPROVED` | `>= 0.24` | `CHALLENGED` |
| `CHALLENGED` | `< 0.70` | `CHALLENGED` |
| `CHALLENGED` | `>= 0.70` | `BLOCKED` |
| `BLOCKED` | any valid value | `BLOCKED` |

The 0.24 boundary is the synthetic model's validation-selected threshold. The 0.70 combined-evidence
boundary is deliberately conservative POC configuration. Neither is a calibrated production fraud
rate or banking policy. ML alone cannot hard block, ML cannot relax a deterministic challenge, and no
input can relax a deterministic hard block. Missing, invalid or unsupported inputs publish no action.

## 4. Commands executed

The principal commands were:

```sh
go test ./...
go vet ./...
SHADOW_ENGINE_POSTGRES_INTEGRATION=1 DATABASE_URL=... go test ./...
cd agents && .venv/bin/ruff check . && .venv/bin/pytest
cd confluent-flink && python3 -m unittest discover -s tests -v
podman compose --env-file .env config
DATABASE_URL=... .venv/bin/alembic upgrade head
cd fraud-decisioning && sh scripts/create_topics.sh
podman compose --env-file .env --profile shadow-engine up -d --build fraud-decision-engine
cd confluent-flink && python3 scripts/generate_controlled_scenario.py \
  --run-id shadowv1-20261028T1605Z
```

Read-only Kafka group, topic, PostgreSQL, health, metrics and report inspections were also executed.
No offset, Flink job, volume or immutable decision was reset or changed.

## 5. Verification results

- Decision engine: all Go unit tests passed; `go vet` passed.
- Decision engine PostgreSQL integration: passed, including duplicate, obsolete, policy-version and
  outbox behavior.
- Existing correlator: all Go tests and `go vet` passed.
- Agents: 78 passed, 2 opt-in tests skipped; Ruff passed.
- Flink/Python: 16 tests passed, including 6 opt-in Kafka tests skipped.
- Compose configuration: valid.
- Both Flink jobs: `RUNNING`.
- Router, scorer, worker, correlator and engine groups: zero lag after the controlled run.
- Shadow publication: 24 messages for 16 logical transactions; all outbox rows published.
- Rejected shadow inputs: zero.

The PostgreSQL integration test was initially run while the live publisher was active. It published two
clearly prefixed `shadow-engine-integration-*` test events at offsets 155 and 156 before cleanup. They do
not affect the controlled-run results above. Kafka data and offsets were deliberately not reset; the test
guide now requires an isolated database or a stopped publisher for shared-database execution.

## 6. Representative real Kafka message

This bounded message was read from `fraud.decisions.shadow.demo` at offset 137. It demonstrates a
shadow action different from the original immutable verdict:

```json
{
  "schema_version": "1.0.0",
  "event_id": "shadow-evaluation:efebe4683df1edb5c5772b44f8864e4634044ccdf6b4d6e2f31e0b65e84c787b",
  "shadow_evaluation_id": "shadow-evaluation:efebe4683df1edb5c5772b44f8864e4634044ccdf6b4d6e2f31e0b65e84c787b",
  "transaction_id": "controlled-shadowv1-20261028T1605Z-velocity-3",
  "source_assessment_id": "assessment:controlled-shadowv1-20261028T1605Z-velocity-3",
  "source_assessment_revision": 2,
  "policy_version": "fraud-action-policy-v1",
  "proposed_action": "CHALLENGED",
  "original_payment_verdict": "APPROVED",
  "differs_from_original": true,
  "contributing_signals": [],
  "deterministic_rule_ids": ["FP-APPROVE-NO-SIGNAL"],
  "policy_reasons": [{
    "code": "ML_EXPERIMENTAL_RISK_CHALLENGE",
    "detail": "ML probability is at or above experimental challenge threshold 0.2400; ML alone cannot hard block."
  }],
  "ml": {
    "fraud_probability": 0.5330738091656015,
    "model_version": "lgbm-baseline-20261028T115824Z-abfd893e",
    "feature_schema_version": "fraud-features-1.0.0",
    "model_timestamp": "2026-10-28T16:04:20.988264Z"
  },
  "evaluation_status": "EVALUATED",
  "evaluation_latency_ms": 0.001541
}
```

The actual message also contains complete assessment, Flink feature and deterministic evidence
provenance plus the explicit policy threshold configuration.

## 7. Controlled comparison

Latest result per transaction:

| Original verdict | Shadow `APPROVED` | Shadow `CHALLENGED` | Shadow `BLOCKED` |
|---|---:|---:|---:|
| `APPROVED` | 9 | 2 | 0 |
| `CHALLENGED` | 0 | 2 | 0 |
| `BLOCKED` | 0 | 0 | 3 |

The immutable `payment_decisions` rows remained 11 approved, 2 challenged and 3 blocked. Shadow results
were 9 approved, 4 challenged and 3 blocked. The second changed transaction was `hopping-3`, whose
probability was `0.25447106624911336`. Three deterministic hard blocks remained blocked even though the
dry-run Claude recommendation visible in later assessment context was `CHALLENGED`.

## 8. Observed policy latency

For the latest result of each of the 16 transactions: mean 0.003425 ms, median 0.002105 ms, p95
0.007521 ms and maximum 0.012709 ms. This is pure in-process Action Selection latency, not end-to-end
payment latency. It excludes Flink, Kafka, PostgreSQL, feature retrieval and model inference.

## 9. Known limitations

- The model and thresholds are synthetic and uncalibrated; the controlled run has no trustworthy
  transaction-level labels, so false-positive and false-negative rates were not fabricated.
- Some early assessment revisions do not contain raw deterministic signals; rule IDs and the immutable
  verdict are used, and missing signals are not invented.
- Kafka publication is at least once. Stable evaluation IDs are the logical deduplication boundary.
- The service targets assessment schema `1.0.0`, model prefix `lgbm-baseline-`, and feature schema
  `fraud-features-1.0.0`; unsupported inputs are retained but not evaluated.
- PostgreSQL and Kafka are local POC services without production HA, TLS, backup or operational SLOs.

## 10. Synchronous-engine readiness

The Action Selection Control is transport-independent and can be called by a future synchronous API
without rewriting policy logic. The next phase still needs the API, point-in-time feature store,
synchronous deterministic controls and ML inference, freshness and future-data-leakage protections,
latency/failure budgets, and separately versioned challenge resolution. Claude customer evidence and
Commonwealth Bank-inspired rule discovery remain separate future workflows.
