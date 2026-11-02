# Local development deployment

The repository has one self-contained Podman Compose deployment managed from the repository root. Its
default project name is `fraud-platform-dev`; it does not use the existing `confluent-flink`, `part3`, or
`fraud-observability` projects.

## Prerequisites

- Podman with a running Podman machine
- a Compose provider available through `podman compose`
- `make`, `openssl`, and the standard macOS command-line tools

No host Java, Maven, Go, PostgreSQL, or application Python environment is required for the core stack. Image
builds compile the Flink JAR, install the Python package and exact checked-in LightGBM artifact, compile both
Go services, and build the Glaramara Next.js application. The bounded Glaramara acceptance probe uses host
Python's standard library only.

## First startup

On a clean Mac, install Podman Desktop (or Podman plus a Compose provider), then create and start a machine
with enough memory for Kafka and Flink. The deployment uses only localhost-bound published ports.

```sh
git clone <repository-url> fraud-detection
cd fraud-detection
podman machine init --cpus 4 --memory 8192 --disk-size 60  # first Podman setup only
podman machine start
make prepare
# Optional: securely configure the live provider; otherwise the offline mock is used.
# make configure-orchestrate
make build
make up
make status
make smoke-test
```

Open [http://localhost:3000](http://localhost:3000) after startup. No separate host Next.js process is
required. `make prepare` generates the ignored, mode-600 `.env` with random local PostgreSQL and session
secrets. `make configure-orchestrate` is optional: it prompts for the service-instance URL and hides API-key
input, then writes only to that ignored file. If Podman already has a machine, adjust its resources through
Podman Desktop or `podman machine set` instead of creating a second machine.

`make prepare` (and therefore `make build` or `make up`) creates an ignored, mode-600 `.env` on first use with
a random local PostgreSQL password. It
also creates the ignored `.runtime/` directory used for Kafka startup boundaries and Flink recovery records.
The committed `.env.example` documents every setting but contains no deployed credential. Credential and
Glaramara session-secret generation occurs only in the ignored mode-600 `.env`; existing deployment files
are upgraded additively without changing their PostgreSQL credential. PostgreSQL credential generation occurs
only when `.env` and the project PostgreSQL volume are both absent. If the volume exists, startup refuses to
invent a replacement credential and reports the non-destructive recovery choices.
Generated passwords are hexadecimal and therefore safe in the PostgreSQL URL. Existing configuration is
validated to contain only URL-unreserved password characters instead of guessing how a custom secret should
be encoded.

The repository `.env` is authoritative for deployment settings. The Compose wrapper reloads it before every
provider call so exported `POSTGRES_DB`, `POSTGRES_USER`, or `POSTGRES_PASSWORD` shell variables cannot
silently override the credentials used by PostgreSQL, migrations, or application services. The project name
and additional Compose profiles remain explicit shell-level overrides.

All Compose commands use `deployment/compose.sh`. The wrapper always enables the internal `tools` profile
both explicitly and through `COMPOSE_PROFILES`, including when Podman delegates Compose to the external
`podman-compose` provider on macOS. This makes the one-shot migration, checkpoint, Flink client, and smoke-test
services available without exporting `COMPOSE_PROFILES`; any additional profiles supplied by the caller are
preserved.

The Flink lifecycle client reaches `jobmanager` only over the private Compose network and deliberately bypasses
host HTTP proxy settings. This prevents workstation or corporate proxy variables propagated by Podman from
intercepting Flink REST planning and health requests. Startup also normalizes TTY line endings and selects only
the exact `java` and `sql` planner records, so external Compose provider notices cannot hide fresh-install job
submissions. A failed Java or SQL submission reports its command exit status and preserves the command's stderr.

Status uses the provider-portable `compose ps` form. Required services are then resolved independently with
project and service labels through `podman ps -a`, so stopped containers remain visible even on older
`podman-compose` releases that do not support `compose ps --all`.

Before Alembic runs, startup opens a short connection from the migrations image to this Compose project's
`postgres` service using the same `DATABASE_URL` as the migration and application containers. An
authentication failure stops startup with a non-secret diagnostic; it never changes the database role or
deletes the retained volume.

`make up` starts Kafka and PostgreSQL first, waits for them, runs Alembic migrations, creates all Kafka topics
idempotently, fixes the Flink checkpoint volume to UID/GID 9999 with mode 0750, starts Flink, ensures exactly
one current instance of each required job is running, captures fresh Python consumer boundaries, and only
then starts the application services, including Glaramara. The fresh boundary is captured once and retained
across partial or subsequent startups. Re-running `make up` does not reset offsets, recreate consumers merely
because the topic advanced, or submit duplicate running jobs.

The deployment runs the deterministic router, outbox publisher, checked-in LightGBM scorer, Go correlator,
Go shadow decision engine, and Glaramara. The deterministic verdict remains payment authority throughout.

## Configuration

Edit the ignored `.env` before first startup to change ports or resource sizes:

| Setting | Default | Purpose |
| --- | ---: | --- |
| `KAFKA_HOST_PORT` | `19092` | host Kafka listener |
| `POSTGRES_HOST_PORT` | `55433` | host PostgreSQL listener |
| `FLINK_HOST_PORT` | `18081` | Flink REST/UI |
| `CORRELATOR_HOST_PORT` | `18082` | correlator HTTP |
| `SHADOW_ENGINE_HOST_PORT` | `18083` | shadow engine HTTP |
| `GLARAMARA_HOST_PORT` | `3000` | localhost-only fictional banking HTTP |
| `GLARAMARA_PUBLIC_ORIGIN` | `http://localhost:3000` | exact browser mutation origin |
| `GLARAMARA_SESSION_SECRET` | generated | signed demo-session secret |
| `GLARAMARA_COOKIE_SECURE` | `false` | localhost-only HTTP cookie override |
| `FRAUD_INTELLIGENCE_PROVIDER` | `mock` | `mock` offline or `orchestrate` live server-side extraction |
| `FRAUD_INTELLIGENCE_MODEL` | `mock-fraud-intelligence/1.0.0` | extraction provenance/model name |
| `FRAUD_INTELLIGENCE_TIMEOUT_MS` | `45000` | bounded live Orchestrate request timeout |
| `WATSONX_ORCHESTRATE_API_KEY` | empty | server-only live credential; required for `orchestrate` |
| `WATSONX_ORCHESTRATE_URL` | empty | server-only IBM service-instance URL |
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

The default `mock` provider is fully offline and requires no IBM credential. To use the existing Orchestrate
agent, run `make configure-orchestrate` from an interactive terminal, then run `make up`. It securely prompts
for the service-instance URL and hides API-key input while updating the ignored mode-600 root `.env`. These
values are injected at runtime into the server container; they are not build arguments, image layers,
`NEXT_PUBLIC_` values, or browser data. Authentication, timeout, network, non-2xx and schema failures are
recorded as a simulated `REQUIRES_FURTHER_REVIEW` outcome. The server never falls back to mock when
`orchestrate` is selected.

Do not change `POSTGRES_PASSWORD` after PostgreSQL has initialized. Migrations deliberately fail before
workers start if the configured password no longer matches the persisted database. Use the confirmed reset
workflow for a disposable development database instead.

If an ignored `.env` is lost while `${COMPOSE_PROJECT_NAME}_postgres-data` remains, restore the original
`.env` (preferred) or edit the current file to use the original password. If the old password is unavailable
but local socket administration is still permitted, connect interactively inside the PostgreSQL container and
use psql's `\\password fraud_app` command; it prompts without putting the password in shell history. This is an
explicit credential reconciliation, not an automatic deployment action. If neither route is available,
restore from backup or obtain approval for a deliberate destructive reset; normal startup will not remove the
volume.

## Normal operation

```sh
make status
make logs
LOG_TAIL=500 make logs
make restart
make down
```

`make status` reports container state and configured health checks, performs Kafka/PostgreSQL protocol checks,
checks the two required current Flink jobs independently, performs the Go and Glaramara HTTP readiness checks,
and prints consumer offsets/lag. Historical failed Flink executions do not make the platform unhealthy when
one current job with the required name is running.

`make down` creates a savepoint for each running required Flink job, records its exact path under `.runtime/`,
and runs Compose down without `--volumes`. `make up` passes those savepoints to the Java and SQL submissions
and records the verified result in `.runtime/flink-start-status`. A job is reported as restored only after the
savepoint-based submission succeeds and the expected job is observed in `RUNNING` state. Checkpoints and
savepoints live in the project-scoped `flink-checkpoints` volume.

If a savepoint command fails, shutdown stops before Compose is taken down. This avoids silently replacing a
stateful job with a fresh submission. Consumer groups are never reset by lifecycle commands.

Job IDs and savepoint results are normalized for TTY line endings before validation. Shutdown requires both
named RUNNING jobs to have distinct 32-character hexadecimal IDs, and verifies each returned savepoint directory
inside the JobManager before writing the recovery manifest or stopping any container.

## Smoke test

`make smoke-test` first requires the Compose-network Glaramara health endpoint, then creates a unique run ID,
establishes output boundaries, and publishes 16 payments plus an
event-time watermark marker to this deployment's broker. It requires all 16 transaction IDs to appear in:

- `payments.enriched.demo`
- `fraud.decisions.demo`
- `fraud.risk.baseline.demo`
- `fraud.assessments.correlated.demo`
- `fraud.decisions.shadow.demo`

It also verifies the deterministic 11/2/3 approved/challenged/blocked distribution and independently requires
`HIGH_VELOCITY` and `MERCHANT_HOPPING` records from the Flink SQL job. The generator reads the last raw-topic
event time before choosing its next timestamp, so repeated runs remain ahead of the previous test watermark.

`make glaramara-smoke-test` is a second opt-in, publishing acceptance probe. It creates a signed fictional
banking session, submits one unique payment, verifies same-key replay and conflicting-key rejection, and waits
for the authoritative deterministic verdict plus independent ML/correlation/shadow provenance. It also proves
the fictional account balance is unchanged. The probe persists its immutable payment attempt and Kafka events;
it never creates a booked transaction or ledger effect.

The 16-payment probe and Glaramara reserve raw event time under the same PostgreSQL advisory lock. This lets the
SQL probe publish a later window-closing marker without making a payment submitted immediately afterward late
to the Java evidence job. The marker payload retains that future event time, but its outbox row becomes
available after three seconds of processing time; migration `0009_release_banking_watermarks` repairs pending
rows created before those clocks were separated.

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

