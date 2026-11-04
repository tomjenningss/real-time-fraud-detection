# Deterministic fraud services and experimental ML baseline

The router is the authoritative payment-decision path. Policy `fast-path-policy/1.1.0` preserves the existing
velocity-plus-merchant-hopping block and existing single-signal challenges, and also challenges Flink's
`NEW_BENEFICIARY_HIGH_VALUE` signal under versioned rule
`FP-CHALLENGE-NEW-BENEFICIARY-HIGH-VALUE/1.0.0`. The `fraud_agents.ml` package adds an independent,
experimental LightGBM shadow score. It never changes a payment verdict or writes an authoritative decision.

## CPU prerequisites

Use Python 3.11 or newer. On Apple Silicon the LightGBM wheel also needs OpenMP:

```sh
brew install libomp
cd agents
.venv/bin/python -m pip install -e '.[dev]'
```

LightGBM is fixed to `device_type=cpu`. The default is six threads; set `FRAUD_ML_CPU_THREADS` or pass
`--threads` to reduce it.

## Reproduce generation, training, and evaluation

From `agents/`:

```sh
.venv/bin/fraud-ml generate-data --output data/ml/synthetic-v1.jsonl --rows 50000 --seed 20261028
.venv/bin/fraud-ml train --dataset data/ml/synthetic-v1.jsonl \
  --artifact-dir artifacts/baseline --seed 20261028 --threads 6
.venv/bin/fraud-ml evaluate --dataset data/ml/synthetic-v1.jsonl \
  --artifact-dir artifacts/baseline
```

The training command selects the F1 threshold using only the validation split, evaluates the held-out
test split once, and writes `model.txt` plus `metadata.json`. Metadata includes the model version,
ordered features, feature-schema version, training configuration, dataset SHA-256, threshold, metrics,
timings, and gain importance. `data/` and `artifacts/` are ignored: do not commit generated data or model
artifacts by default.

Synthetic v1 has 50,000 rows (35,000 training, 10,000 validation, 5,000 test), seed `20261028`, and a
2.752% noisy positive rate. Its independent latent scenarios are legitimate activity, account takeover,
card testing, and merchant hopping. Twelve percent of simulated attacks are unlabelled and 0.15% of
otherwise legitimate rows receive a noisy positive label. Identifiers, Flink signals, and deterministic
rule verdicts are excluded from training. Customer identifiers are unique to one split, and validation
and test occupy later event-time ranges than training.

The shared `fraud-features-1.0.0` schema uses only fields present in `payments.enriched.demo`: amount,
1/2/10-minute counts, two-minute distinct merchants and total amount, plus contemporaneous mean amount
and merchant-diversity ratios. Values are clipped to documented safety bounds. A missing required live
field is rejected rather than imputed because it violates the canonical Flink contract; LightGBM still
supports non-finite numerical values as missing at the matrix boundary. Merchant ID is deliberately
excluded: it is high-cardinality, synthetic merchant identities would invite leakage, and no stable
merchant taxonomy exists in the live contract. No geographic feature exists in that contract.

The first local run produced these synthetic held-out test results at the validation-selected threshold
0.24: ROC-AUC 0.96050, PR-AUC 0.84760, precision 0.80625, recall 0.86000, F1 0.83226,
false-positive rate 0.00639, Brier score 0.00821, and confusion matrix `[[4819,31],[21,129]]`.
Training took 0.434 seconds on six CPU threads; model-only batch inference averaged 0.00089 ms per record.
End-to-end local scoring, including JSON validation, feature extraction, prediction and event creation,
averaged 0.0587 ms (median 0.0585 ms, p95 0.0699 ms) over 1,000 warm calls. The most important gain
feature was `transactions_2m`. These measurements describe separability of this generator,
not production fraud accuracy, calibration, fairness, robustness, or financial value.

## Run the optional shadow consumer

Create only the new topic (this does not restart services or reset offsets):

```sh
cd ../confluent-flink
podman compose exec -T kafka kafka-topics --bootstrap-server kafka:29092 \
  --create --if-not-exists --topic fraud.risk.baseline.demo --partitions 1 --replication-factor 1
```

Then, from `agents/`, explicitly enable it:

```sh
FRAUD_SHADOW_SCORING_ENABLED=true \
FRAUD_ML_MODEL_DIR=artifacts/baseline \
KAFKA_BOOTSTRAP_SERVERS=localhost:9092 \
.venv/bin/fraud-shadow-scorer
```

Stop with Ctrl-C. It starts at `latest` for a new `fraud-shadow-baseline-v1` group and never replays or
resets existing offsets. Results go to `fraud.risk.baseline.demo` with stable event ID, transaction ID,
model/schema versions, probability, model and transaction timestamps, scoring latency, source Kafka
position, and available correlation/trace headers. A crash after publish and before offset commit can
repeat an output; downstream consumers must deduplicate by stable `event_id`. Malformed records are
logged and committed. Model-loading and Kafka failures fail the shadow process, never authorization.

In Control Center at <http://localhost:9021>, open the Kafka cluster, **Topics**,
`fraud.risk.baseline.demo`, then **Messages**.

## Tests

```sh
.venv/bin/ruff check .
.venv/bin/pytest
```

The local tests need no broker. The opt-in integration test uses a unique test-only topic:

```sh
RUN_ML_KAFKA_INTEGRATION=1 KAFKA_BOOTSTRAP_SERVERS=localhost:9092 \
  .venv/bin/pytest tests/test_ml_kafka_integration.py -q
```

## Glaramara Phase B banking schema and outbox

## Agentic investigation laboratory foundation

Revision `0016_agentic_lab` adds a separate immutable synthetic laboratory for a future tool-using Fraud
Investigation Agent. It does not replace Phase D and has no foreign keys or write paths to banking,
decisions, Kafka, or customer Fraud Intelligence. Future waves contain group-safe `DISCOVERY`, `VALIDATION`,
and `FINAL_HOLDOUT` partitions. The current seed command is idempotent:

```sh
DATABASE_URL=postgresql://... .venv/bin/fraud-agentic-lab-seed
```

Only future machine-authenticated investigation tools may query discovery and validation data. Final holdout
access remains intentionally unimplemented until candidate freezing and one-shot evaluation are enforced.

## Configurable Phase D Fraud Lab datasets

Revisions `0017_fraud_lab_datasets`, `0018_dataset_run_backfill` and `0019_active_dataset_integrity` preserve
the existing immutable Phase D
waves while adding versioned dataset manifests, explicit per-environment activation and append-only activation
events. The migration backfills the existing 8,000-row wave; matching historical runs gain only a dataset
reference, while their snapshot manifest, digest, proposal and backtest remain unchanged.

`fraud-lab-dataset-worker` is a fixed-purpose PostgreSQL worker using the existing
`fraud_agents.fraud_lab.synthetic` generator. It accepts no command text or arbitrary Python. Only 8,000,
10,000 and 20,000 rows with the versioned `multi_new_beneficiary` scenario are supported. The API owns
request validation and idempotency; the worker claims one request, generates one immutable wave and commits
the wave, rows, membership and terminal `READY` state atomically. Failed work leaves no partial wave and
stale `GENERATING` claims fail closed for safe retry with a new idempotency key.

Alembic revision `0006_glaramara_banking` adds persistent fictional customers, accounts, beneficiaries,
allowlisted demo locations, immutable booked transactions and immutable simulated payment-attempt records.
It seeds deterministic Alex Morgan, Priya Shah and Daniel Evans fixtures. Demo balances, booked rows and
payment attempts are protected from mutation; every payment attempt is constrained to
`ledger_effect='NONE'` and `is_simulated=true`.

Apply the normal migration chain only to the intended environment:

```sh
DATABASE_URL=postgresql://... .venv/bin/alembic upgrade head
```

The PostgreSQL checks are opt-in so routine tests never connect to a running platform database:

```sh
RUN_PART3_POSTGRES_TESTS=1 DATABASE_URL=postgresql://... \
  .venv/bin/pytest -q tests/test_banking_schema_integration.py
```

Revision `0007_glaramara_phase_b` adds the `banking_payment_status` projection and an outbox aggregate index.
Revision `0008_raw_event_time_clock` adds the singleton event clock shared by interactive and root regression
producers. Revision `0009_release_banking_watermarks` releases pending markers scheduled against future event
time before publication delay was separated into processing time. Glaramara atomically inserts immutable
attempts plus `banking_payment_raw` and `banking_payment_watermark` rows into the existing outbox.
`FraudStore.claim_outbox` withholds a watermark
until its raw sibling is `PUBLISHED`; the existing lease, retry and Kafka-acknowledgement behaviour otherwise
remains unchanged. Terminal banking status is derived only from immutable `payment_decisions`.

Revision `0010_glaramara_phase_c` adds durable adaptive questionnaires, append-only investigation events and
answers, immutable Fraud Intelligence extraction records, a metrics view and separate simulated reassessment
history. Database triggers preserve original decision/questionnaire provenance and reject mutation of
evidence or resolution history. The reassessment outcome never replaces `payment_decisions`.

The LightGBM baseline remains shadow-only. Phase C does not add evidence-enriched ML or active model policy.
