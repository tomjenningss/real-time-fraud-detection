# Repository context

## Purpose

This repository is a local, auditable fraud-platform demonstration. Kafka and Flink derive real-time
behavioural evidence; deterministic Python policy owns the initial payment verdict; optional Claude agents
investigate asynchronously; a CPU LightGBM model and Go policy evaluate an experimental shadow action.
`glaramara-bank/` is the fictional customer-facing banking application. Phase B submits simulated payments
through the existing fraud platform without ledger effects.

## Directory map and ownership

- `confluent-flink/`: generators, Java per-transaction enrichment, Flink SQL aggregate signals, tests.
- `agents/`: Python router, inbox/outbox, investigations, budgets, LightGBM scorer, migrations, tests.
- `fraud-assessment-correlator/`: Go correlator for deterministic, ML and investigation events.
- `fraud-decision-engine/`: Go shadow Action Selection Control; it is not payment authority.
- `fraud-decisioning/`: legacy/component Compose and Kafka operational scripts.
- `glaramara-bank/`: Next.js fictional banking UI and PostgreSQL-backed Phase B APIs.
- `deployment/`, root `compose.yaml`, `Makefile`: isolated `fraud-platform-dev` lifecycle.
- `observability/`: optional Phoenix/OpenTelemetry stack. `docs/`: design, evidence and handoffs.

## Stack and service boundaries

Kafka 8.1/KRaft, Flink 1.20/Java 11, Python 3.11/Pydantic/PostgreSQL 17/Alembic, LightGBM,
Go, and Next.js/TypeScript/Tailwind/Playwright. PostgreSQL is authoritative for durable decisions,
deduplication, outboxes, budgets, correlated/shadow history, and fictional banking data. Kafka delivery is
at least once; stable event IDs and database constraints are the logical deduplication boundary.

## Non-negotiable constraints

- The deterministic fast path alone writes immutable `payment_decisions`. Claude recommendations and Go
  shadow actions must never overwrite or relax that verdict.
- LightGBM is synthetic, experimental, non-authoritative, and must remain explicitly enabled/shadow-only.
- Live Anthropic calls are disabled unless separately approved; tests must never make paid calls.
- Preserve provenance, deterministic/versioned IDs, schemas, policies, retries, idempotency and budgets.
- Never commit `.env` files, credentials, API keys or sensitive payment data.
- Do not reset Kafka offsets, cancel/reseed Flink state, recreate volumes, mutate decisions/balances, or
  stop protected golden projects during routine work.
- Preserve the approved Glaramara prototype/UI. Phase B payment attempts remain simulated with no ledger effect.
- Preserve IBM TechZone and AskOrchestrate; Orchestrate is outside Phase B and blocked until Phase C.
- Integration tests are opt-in and can publish. Read component READMEs and use isolated IDs/databases.
  Validate Compose changes with `make config` or `podman compose config` first.

## Common commands

```sh
# Isolated root deployment (stateful; read DEPLOYMENT.md first)
make config                 # render only
make status                 # read-only health, jobs and lag
make build && make up       # build/start only when explicitly required
make smoke-test             # publishes a unique 16-payment fixture

cd agents && .venv/bin/pytest && .venv/bin/ruff check .
cd confluent-flink && scripts/build_enrichment.sh
cd confluent-flink && python3 -m unittest discover -s tests -v
cd fraud-assessment-correlator && go test ./... && go vet ./...
cd fraud-decision-engine && go test ./... && go vet ./...
cd glaramara-bank && npm test && npm run typecheck && npm run build && npm run test:e2e
python3 -m unittest discover -s deployment/tests -v
```

Never run `make reset` without explicit approval. `make down` is state-aware but changes the runtime.

Python targets 3.11, four-space indentation, type hints and 110-character lines; Ruff enforces `E`, `F`,
`I`, `UP`, `B` and `ASYNC`. Use deterministic fixtures and fake model responses. Routing, persistence
and investigation changes should cover retries, idempotency, immutable verdicts and budgets where relevant.

## Read before changing the system

- Verified architecture: `docs/architecture/system-overview.md`
- Milestone handoff and next-phase boundary: `docs/implementation/current-state.md`
- Deployment lifecycle/isolation: `DEPLOYMENT.md`, `docs/golden-reference.md`
- Decision authority/trust boundaries: `docs/architecture.md`
- Component details: each component's `README.md`
- Phase evidence: `docs/implementation/glaramara-phase-0-baseline.md` and
  `docs/implementation/glaramara-phase-a-summary.md`

At every major milestone, update `docs/implementation/current-state.md`, the verified system overview when
flows/contracts changed, and the nearest component README. Record commands/results and distinguish observed
evidence from plans; do not turn handoff files into chronological logs.
