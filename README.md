# Real-Time Fraud Detection

An event-driven banking fraud demonstration that combines low-latency deterministic payment
decisions with asynchronous, multi-agent Claude investigations.

The central design rule is simple: **Claude is not in the payment-authorisation path.** Kafka and
Flink produce canonical evidence, a versioned policy makes the authoritative payment decision, and
only selected cases enter a separately governed AI investigation workflow.

## Architecture

```text
Synthetic payments
        │
        ▼
Kafka: payments.raw.demo
        │
        ├──────────────► Flink SQL ──────────────► fraud.signals.demo
        │
        ▼
Flink DataStream enrichment
  velocity · merchant hopping · rolling evidence
        │
        ▼
Kafka: payments.enriched.demo
        │
        ▼
Deterministic fraud router ───────────────► PostgreSQL inbox/outbox
  APPROVED · CHALLENGED · BLOCKED              │
        │                                       ├── immutable decisions
        │ selected cases only                   ├── durable deduplication
        ▼                                       └── budget ledger
Kafka: fraud.investigations.requested
        │
        ▼
Claude investigation worker
  Opus supervisor · Geo · Behaviour · Action
        │
        ▼
Kafka: fraud.investigations.completed
  recommendation kept separate from payment verdict
```

## What this demonstrates

- Real-time Kafka/Flink enrichment with event-time windows and canonical fraud signals.
- A zero-Claude fast path with explicit `APPROVED`, `CHALLENGED`, and `BLOCKED` outcomes.
- Immutable payment authority: an investigation can recommend follow-up action but cannot rewrite
  the original verdict.
- PostgreSQL transactional inbox/outbox processing for restart-safe idempotency and at-least-once
  Kafka publication.
- A genuine Anthropic SDK tool-use loop across four logical agents, with deterministic policy
  enforcement at the action boundary.
- Durable per-investigation usage accounting, paid-attempt tracking, concurrency-safe budget
  reservations, and live mode disabled by default.
- Structured provenance for decisions, evidence, model calls, tool calls, retries, and costs.

## Tested behavior

A controlled 16-payment end-to-end run produced 11 approved, 2 challenged, and 3 blocked decisions, with five asynchronous investigations. A separate live Anthropic evaluation completed five investigations across 45 model calls, matching all five predefined policy recommendations at an estimated API cost of $0.146. Original payment verdicts remained immutable throughout, and duplicate-event replay produced no additional decisions or investigations.

The platform demonstrates an enterprise-oriented fraud detection architecture, with particular emphasis on streaming analytics, deterministic decision-making, resilient event processing, and governed AI investigations. Fraud thresholds are configurable, and the system uses at-least-once delivery with explicit idempotency controls.

## Technology

| Area          | Implementation                                    |
| ------------- | ------------------------------------------------- |
| Streaming     | Confluent Kafka 8.1.6, Apache Flink 1.20.2        |
| Decisioning   | Python, deterministic versioned policies          |
| Investigation | Anthropic SDK, multi-agent tool-use orchestration |
| Durable state | PostgreSQL 17, SQLAlchemy, Alembic                |
| Local runtime | Podman Compose                                    |
| Verification  | Pytest, Ruff, synthetic integration scenarios     |

## Repository guide

- [`confluent-flink/`](confluent-flink/) — Kafka/Flink infrastructure, enrichment job, SQL fraud
  detection, synthetic generator, and job lifecycle scripts.
- [`agents/`](agents/) — decision router, investigation worker, Claude agents, deterministic policies,
  database layer, migrations, fixtures, and tests.
- [`fraud-decisioning/`](fraud-decisioning/) — PostgreSQL deployment and Part 3 operational guide.
- [`docs/architecture.md`](docs/architecture.md) — trust boundaries, agent responsibilities, and
  decision-authority model.

## Explore further

- [Streaming and Flink guide](confluent-flink/README.md)
- [Decisioning, recovery, and operations](fraud-decisioning/README.md)
- [Agent architecture and security boundaries](docs/architecture.md)

Live Anthropic calls require two explicit enablement flags and durable budget approval. Local
credentials belong only in ignored `.env` files; the repository contains safe templates instead.
