# Fraud agents and experimental ML baseline

The existing router and Claude investigation services remain the authoritative application paths. The
`fraud_agents.ml` package adds an independent, experimental LightGBM shadow score. It never changes a
payment verdict, writes PostgreSQL decisions, or invokes Claude.

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

Phase 1 is this baseline shadow model. Later phases may add Claude-based customer-evidence extraction and
evidence-enriched ML, but neither is implemented here; a dashboard is also out of scope.
