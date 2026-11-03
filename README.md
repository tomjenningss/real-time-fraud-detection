# Real-Time Fraud Detection

An auditable local fraud-platform demonstration for fictional banking payments. Kafka and Flink produce
real-time behavioural evidence; deterministic Python policy owns the initial payment verdict; LightGBM and
Go provide explicitly non-authoritative shadow evidence; and Glaramara presents a simulated banking journey.

The platform is designed to be reproducible on a Mac with Podman. All payment attempts are fictional and
simulated: they never book a transaction, change a balance, or create a ledger effect.

## Architecture

```text
Glaramara Next.js app                         Synthetic fixture
    │ simulated payment                            │
    ▼                                              ▼
PostgreSQL attempt + durable outbox ──────► Kafka: payments.raw.demo
                                                    │
                                                    ▼
                                          Flink enrichment + SQL signals
                                                    │
                                                    ▼
                                         Kafka: payments.enriched.demo
                                           │                       │
                                           ▼                       ▼
                         Deterministic Python router         LightGBM shadow scorer
                           APPROVED / CHALLENGED / BLOCKED       experimental only
                                           │                       │
                                           └────► PostgreSQL ◄─────┘
                                              immutable decisions
                                              inbox/outbox/audit
                                                    │
                                                    ▼
                                 Go correlator ──► Go shadow decision engine
                                                    │
                                                    ▼
                                      experimental shadow action/event

CHALLENGED Glaramara payment ─► versioned security questionnaire
                                      │
                                      ▼
                    Fraud Intelligence adapter: mock or watsonx Orchestrate
                    (server-side IAM/REST; optional bounded clarification)
                                      │
                                      ▼
                       simulated reassessment: never changes payment verdict
```

The deterministic fast path is the sole payment authority. It writes immutable `payment_decisions`; no
model score, shadow action, or customer-evidence result can relax or overwrite that verdict. Kafka delivery
is at least once, with stable event IDs and PostgreSQL constraints as the deduplication boundary.

For challenged Glaramara payments, the customer can complete a versioned, durable security questionnaire.
The optional server-side Fraud Intelligence adapter uses either a credential-free deterministic `mock` or the
existing IBM watsonx Orchestrate agent through IAM and REST. Its reassessment is simulated and append-only;
missing, invalid, or unavailable live evidence conservatively becomes `REQUIRES_FURTHER_REVIEW`.

The separate Fraud Operations persona provides Phase D rule discovery over immutable, synthetic PostgreSQL
history. A standalone Orchestrate agent can propose one constrained rule; Glaramara validates and backtests it
against an unseen holdout before an analyst records approval or rejection. Approval is an implementation
backlog decision only and never deploys a rule.

## Run the unified demo

Install Podman and a Compose provider, then from a fresh clone:

```sh
make prepare
# Optional: securely configure live watsonx Orchestrate; mock mode needs nothing else.
# make configure-orchestrate
make build
make up
make status
make smoke-test
```

Open <http://localhost:3000>. The default `FRAUD_INTELLIGENCE_PROVIDER=mock` works offline and requires no
IBM credentials. `make glaramara-smoke-test` submits one additional simulated banking payment and verifies
idempotency, immutable authority, downstream shadow provenance, and no balance movement.

See [DEPLOYMENT.md](DEPLOYMENT.md) for clean-machine setup, resource requirements, runtime configuration,
state-preserving shutdown, and the live `orchestrate` configuration.

## What is included

- Real-time event processing with Kafka 8.1 and Flink 1.20.
- Versioned deterministic fast-path policy and immutable PostgreSQL decisions.
- CPU LightGBM and Go Action Selection Control in experimental shadow-only mode.
- PostgreSQL inbox/outbox, idempotency, retries, and durable correlation history.
- Glaramara: a Next.js fictional bank UI with customer sessions, beneficiaries, simulated payment attempts,
  status polling, adaptive security checks, and a role-protected synthetic Fraud Operations dashboard.
- Extensible deterministic fraud-lab waves, strict AI rule proposals, held-out backtesting and append-only
  analyst review. `make fraud-lab-next-wave` adds the optional second period idempotently.
- Optional Phoenix/OpenTelemetry infrastructure for local observability.

## Repository layout

- [confluent-flink/](confluent-flink/) — generators, Java enrichment, SQL signals, and Flink lifecycle tools.
- [agents/](agents/) — deterministic router, outbox, migrations, LightGBM scorer, and tests.
- [fraud-assessment-correlator/](fraud-assessment-correlator/) — Go evidence correlator.
- [fraud-decision-engine/](fraud-decision-engine/) — Go experimental shadow action policy.
- [glaramara-bank/](glaramara-bank/) — fictional banking UI and server APIs.
- [docs/architecture/system-overview.md](docs/architecture/system-overview.md) — verified component and data-flow detail.
- [docs/architecture.md](docs/architecture.md) — decision authority and trust boundaries.

## Safety boundaries

- Fictional data only; no account balance or ledger mutation.
- Deterministic decisions are immutable and remain the sole payment authority.
- LightGBM and Go output is experimental, synthetic, and shadow-only.
- Orchestrate is server-side only; API keys and IAM tokens never enter images, build arguments, browser bundles,
  or PostgreSQL.
- Root deployment preserves Kafka offsets, PostgreSQL data, and Flink checkpoints/savepoints across `make down`.
