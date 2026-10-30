# Local development deployment

The repository has one self-contained Podman Compose deployment managed from the repository root. Its
default project name is `fraud-platform-dev`; it does not use the existing `confluent-flink`, `part3`, or
`fraud-observability` projects.

## Prerequisites

- Podman with a running Podman machine
- a Compose provider available through `podman compose`
- `make`, `openssl`, and the standard macOS command-line tools

No host Java, Maven, Go, PostgreSQL, or Python environment is required. Image builds compile the Flink JAR,
install the Python package and exact checked-in LightGBM artifact, and compile both Go services.

## First startup

```sh
make build
make up
make status
make smoke-test
```

`make build` creates an ignored, mode-600 `.env` on first use with a random local PostgreSQL password. It
also creates the ignored `.runtime/` directory used for Kafka startup boundaries and Flink recovery records.
The committed `.env.example` documents every setting but contains no deployed credential.

`make up` starts Kafka and PostgreSQL first, waits for them, runs Alembic migrations, creates all Kafka topics
idempotently, fixes the Flink checkpoint volume to UID/GID 9999 with mode 0750, starts Flink, ensures exactly
one current instance of each required job is running, captures fresh Python consumer boundaries, and only
then starts the application services. Re-running it does not reset offsets or submit duplicate running jobs.

Live Anthropic investigations remain disabled. The deployment runs only the deterministic router, outbox
publisher, checked-in LightGBM scorer, Go correlator, and Go shadow decision engine requested by this local
pipeline.

## Configuration

Edit the ignored `.env` before first startup to change ports or resource sizes:

| Setting | Default | Purpose |
| --- | ---: | --- |
| `KAFKA_HOST_PORT` | `19092` | host Kafka listener |
| `POSTGRES_HOST_PORT` | `55433` | host PostgreSQL listener |
| `FLINK_HOST_PORT` | `18081` | Flink REST/UI |
| `CORRELATOR_HOST_PORT` | `18082` | correlator HTTP |
| `SHADOW_ENGINE_HOST_PORT` | `18083` | shadow engine HTTP |
| `KAFKA_HEAP_OPTS` | `-Xms256m -Xmx512m` | development broker heap |
| `JOBMANAGER_MEMORY` | `768m` | Flink JobManager process memory |
| `TASKMANAGER_MEMORY` | `1280m` | Flink TaskManager process memory |

Override the project name per command when another isolated instance is required:

```sh
COMPOSE_PROJECT_NAME=my-fraud-dev make up
```

The Compose project owns its network and the `kafka-data`, `postgres-data`, and `flink-checkpoints` named
volumes. Service-to-service traffic uses Compose DNS names (`kafka`, `postgres`, and `jobmanager`), never
host `localhost`.

Do not change `POSTGRES_PASSWORD` after PostgreSQL has initialized. Migrations deliberately fail before
workers start if the configured password no longer matches the persisted database. Use the confirmed reset
workflow for a disposable development database instead.

## Normal operation

```sh
make status
make logs
LOG_TAIL=500 make logs
make restart
make down
```

`make status` reports container state and configured health checks, performs Kafka/PostgreSQL protocol checks,
checks the two required current Flink jobs independently, performs the Go HTTP readiness checks, and prints
consumer offsets/lag. Historical failed Flink executions do not make the platform unhealthy when one current
job with the required name is running.

`make down` creates a savepoint for each running required Flink job, records its exact path under `.runtime/`,
and runs Compose down without `--volumes`. `make up` passes those savepoints to the Java and SQL submissions
and records the verified result in `.runtime/flink-start-status`. A job is reported as restored only after the
savepoint-based submission succeeds and the expected job is observed in `RUNNING` state. Checkpoints and
savepoints live in the project-scoped `flink-checkpoints` volume.

If a savepoint command fails, shutdown stops before Compose is taken down. This avoids silently replacing a
stateful job with a fresh submission. Consumer groups are never reset by lifecycle commands.

## Smoke test

`make smoke-test` creates a unique run ID, establishes output boundaries, and publishes 16 payments plus an
event-time watermark marker to this deployment's broker. It requires all 16 transaction IDs to appear in:

- `payments.enriched.demo`
- `fraud.decisions.demo`
- `fraud.risk.baseline.demo`
- `fraud.assessments.correlated.demo`
- `fraud.decisions.shadow.demo`

It also verifies the deterministic 11/2/3 approved/challenged/blocked distribution and independently requires
`HIGH_VELOCITY` and `MERCHANT_HOPPING` records from the Flink SQL job. The generator reads the last raw-topic
event time before choosing its next timestamp, so repeated runs remain ahead of the previous test watermark.

## Destructive reset

`make reset` displays the exact project and requires typing its name. It removes only that Compose project's
containers, network, and named volumes. It does not remove `.env`, images, or any golden-reference resource.

## Portability and limits

The configuration uses only repository-relative paths and builds every application artifact from the clone.
The checked-in LightGBM model is the validated baseline; startup does not retrain it. This deployment has been
designed for another Mac clone, but portability must not be claimed as validated until the IBM work laptop has
actually completed `make build`, `make up`, and `make smoke-test`.

Running this development stack beside another Kafka/Flink stack requires enough Podman VM memory. Increase the
Podman machine allocation or stop optional workloads deliberately; never stop or resize a reference deployment
without its owner's approval.

