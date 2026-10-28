# Go Fraud Decision Engine

This standalone service consumes `fraud.assessments.correlated.demo` and publishes versioned shadow
actions to `fraud.decisions.shadow.demo`. It never writes the existing decision tables, publishes to
`fraud.decisions.demo`, or triggers an investigation. The Action Selection Control is the pure
`internal/policy` package, so a later synchronous API can call it without Kafka or PostgreSQL.

## Policy `fraud-action-policy-v1`

The defaults are experimental POC configuration, not calibrated fraud probabilities or production
banking policy. The model was trained on synthetic data. Its validation-selected threshold, 0.24, is used
only as the shadow challenge boundary. The 0.70 block boundary requires an existing deterministic
challenge as independent evidence; ML alone never creates a hard block.

| Immutable deterministic verdict | ML probability | Shadow action | Reason |
|---|---:|---|---|
| `APPROVED` | `< 0.24` | `APPROVED` | deterministic approval and low experimental ML risk |
| `APPROVED` | `>= 0.24` | `CHALLENGED` | ML may add friction but cannot hard block alone |
| `CHALLENGED` | `< 0.70` | `CHALLENGED` | existing challenge cannot be relaxed by ML |
| `CHALLENGED` | `>= 0.70` | `BLOCKED` | deterministic concern plus high experimental ML risk |
| `BLOCKED` | any valid score | `BLOCKED` | hard-block safety control always wins |

Both detector branches must exist. The probability must be finite and within `[0,1]`, the feature schema
must be `fraud-features-1.0.0`, and the model version must begin `lgbm-baseline-`. Missing inputs are
recorded as `AWAITING_INPUTS`; invalid inputs are recorded as `INVALID_INPUTS`. Neither status publishes a
shadow decision. Optional Claude investigation content is copied to `investigation_context` for audit and
is never passed to the policy.

## Output contract

`fraud.decisions.shadow.demo` schema `1.0.0` is keyed by `transaction_id`. It contains a deterministic
`shadow_evaluation_id`/`event_id` derived from source assessment ID, source revision and policy version;
the proposed and original actions; disagreement flag; deterministic signals and rule IDs; structured
policy reasons; ML probability/model/schema metadata; assessment, deterministic and feature provenance;
optional investigation audit context; policy configuration; evaluation timestamp/latency; and
`evaluation_status=EVALUATED`.

PostgreSQL records every seen revision, the latest revision per transaction and policy, append-only
evaluations, rejected records, and a durable publication outbox. The consumer commits only after the
database transaction. A crash after Kafka acknowledges a publish but before the outbox update can produce
a physical duplicate, so downstream consumers must deduplicate by `shadow_evaluation_id`. Duplicate and
out-of-order source revisions do not create evaluations.

## Run and inspect

Do not reset offsets or recreate volumes. With the existing Kafka and PostgreSQL running:

```sh
cd agents
DATABASE_URL=... .venv/bin/alembic upgrade head
cd ../fraud-decisioning
sh scripts/create_topics.sh
podman compose --env-file .env --profile shadow-engine up -d --build fraud-decision-engine
curl -fsS http://localhost:8083/readyz
curl -fsS http://localhost:8083/metrics
curl -fsS http://localhost:8083/evaluation-report
MAX_MESSAGES=20 sh scripts/inspect_topic.sh fraud.decisions.shadow.demo
```

The default new consumer group starts at `earliest` to reconstruct shadow decisions from retained
assessment revisions. Established groups resume committed offsets; never reset one for testing.
Configuration variables are:

| Variable | Default |
|---|---|
| `SHADOW_DECISION_GROUP_ID` | `fraud-decision-engine-v1` |
| `SHADOW_DECISION_AUTO_OFFSET_RESET` | `earliest` |
| `ACTION_POLICY_VERSION` | `fraud-action-policy-v1` |
| `ACTION_CHALLENGE_THRESHOLD` | `0.24` |
| `ACTION_BLOCK_THRESHOLD` | `0.70` |
| `ACTION_SUPPORTED_MODEL_VERSION_PREFIX` | `lgbm-baseline-` |
| `ACTION_SUPPORTED_FEATURE_SCHEMA_VERSION` | `fraud-features-1.0.0` |
| `HTTP_PORT` | `8080` (`8083` on the host in Compose) |

## Tests

```sh
go test ./...
go vet ./...
SHADOW_ENGINE_POSTGRES_INTEGRATION=1 DATABASE_URL=... go test ./internal/store
```

The PostgreSQL test is opt-in and uses unique identifiers. Run it against an isolated migrated database,
or stop the engine publisher for the bounded test so it cannot race the temporary outbox rows. It covers
duplicate, obsolete and policy-version processing without resetting shared state. Unit tests cover the
complete decision matrix, missing/invalid/unsupported inputs, stable versioned identities, provenance,
and original-decision immutability.
