# Real-Time Fraud Detection

An event-driven fraud detection platform combining low-latency, deterministic payment decisions with asynchronous, multi-agent Claude investigations.

**Core design principle: Claude is not in the payment-authorisation path.**

Confluent Kafka and Apache Flink process transaction streams and generate fraud evidence. A versioned, deterministic policy makes the authoritative payment decision, while selected transactions enter a separately governed AI investigation workflow.

This separation allows Claude to investigate suspicious activity and recommend follow-up actions without introducing LLM latency or uncertainty into the initial payment decision.

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
  APPROVED · CHALLENGED · BLOCKED                 │
        │                                        ├── immutable decisions
        │ selected cases only                    ├── durable deduplication
        ▼                                        └── budget ledger
Kafka: fraud.investigations.requested
        │
        ▼
Claude investigation worker
  Configurable Supervisor · Geo · Behaviour · Action
        │
        ▼
Kafka: fraud.investigations.completed
  recommendation kept separate from payment verdict
```

## Design decisions

### Why Claude does not authorise payments

Payment authorisation and fraud investigation have different latency, reliability and governance requirements. The payment-authorisation path uses Apache Flink to generate behavioural evidence and a deterministic, versioned policy to produce an `APPROVED`, `CHALLENGED` or `BLOCKED` decision. Claude operates asynchronously, investigating selected transactions after the initial verdict has been recorded.

This separation provides several advantages:

- **Predictable latency:** Payment decisions do not wait for multi-step LLM reasoning or external model API responses.
- **Deterministic outcomes:** The same evidence and policy version produce the same initial decision.
- **Clear accountability:** Every payment verdict can be traced to the evidence and policy that produced it.
- **Fault isolation:** Model latency, API failures or investigation backlogs do not block the payment-decision path.
- **Enforced authority:** PostgreSQL prevents modifications to original payment verdicts. Claude's recommendations are stored separately.

The objective is not to replace deterministic fraud controls with an LLM, but to use Claude where contextual reasoning adds value: interpreting behavioural anomalies, assessing geographical evidence, identifying uncertainty and recommending further investigation.

### Why different Claude models are used

The investigation workflow uses a multi-model architecture, matching model capability and cost to each agent's responsibilities. The original configuration placed Opus in the supervisory role; a subsequent matched live evaluation tested Sonnet as a direct substitute.

| Agent | Evaluated model ID(s) | Responsibility |
| --- | --- | --- |
| Supervisor | `claude-opus-5-5` (original) / `claude-sonnet-5-5` (evaluated alternative) | Coordinates specialist investigations, reconciles evidence and manages multi-step reasoning. |
| Behaviour | `claude-sonnet-5-5` | Interprets Flink-generated transaction velocity, merchant diversity and historical evidence. |
| Geo | `claude-haiku-5-5` | Assesses geographic evidence with deterministic distance calculations and provenance. |
| Action | `claude-haiku-5-5` | Invokes the versioned deterministic action policy and returns a governed recommendation. |

Geographic calculations and final action-policy enforcement remain deterministic tools, not unconstrained model decisions. **Sonnet is now the recommended Supervisor for this evaluated workload**: it matched the ten defined quality checks across 30 synthetic scenarios at lower measured cost and latency. This is an evidence-based recommendation, **not a claim that the deployed default configuration has already changed**, or that the models are equivalent on harder or production workloads. See the [matched live comparison](#live-supervisor-comparison-opus-vs-sonnet).

## What this demonstrates

- **Real-time streaming analytics:** Kafka and Flink process transactions using event-time windows, behavioural enrichment and canonical fraud signals.
- **Deterministic payment authority:** A zero-Claude authorisation path produces `APPROVED`, `CHALLENGED` or `BLOCKED` decisions using versioned policies.
- **Governed AI investigations:** Four logical Claude agents collaborate through Anthropic SDK tool-use orchestration, with deterministic policy enforcement at the action boundary.
- **Immutable decisions:** AI investigations can recommend follow-up actions but cannot overwrite original payment verdicts.
- **Reliable event processing:** PostgreSQL transactional inbox/outbox patterns, durable deduplication and idempotent consumers support at-least-once Kafka delivery.
- **Cost-controlled AI execution:** PostgreSQL-backed budget reservations enforce investigation limits across concurrent workers and process restarts, with live API access disabled by default.
- **End-to-end auditability:** Structured provenance captures transaction evidence, policy decisions, model usage, tool calls, investigation outcomes and estimated costs.

## Validated end-to-end behaviour

A controlled test through Kafka, both Flink jobs, deterministic decisioning, PostgreSQL and the dry-run investigation worker processed **16 synthetic payments**: 11 approved, 2 challenged and 3 blocked, with five asynchronous investigations. Replaying the same fixture produced no additional enriched payments, decisions or investigations.

A separate initial live Anthropic evaluation completed **eight investigations and 72 model calls** in two batches, at a combined estimated API cost of **$0.2359784**. All eight predefined policy recommendations matched. The original payment verdicts remained unchanged, even where Claude recommended a different action.

These investigations operate asynchronously, independently of the initial payment decision. The eight-case cost excludes an earlier $0.02740 smoke-test baseline.

Fraud thresholds are configurable examples. The platform uses at-least-once event delivery with explicit idempotency controls rather than assuming end-to-end exactly-once processing.

## Agent Observability — Phoenix & OpenTelemetry

Arize Phoenix provides execution visibility into the existing Python orchestration built directly on the Anthropic SDK. OpenTelemetry carries trace context through the investigation worker, Supervisor, specialist agents and deterministic tools, while OpenInference conventions identify agent, model and tool spans.

The illustrated **live investigation** completed in approximately **22.6 seconds**, with an estimated API cost of **$0.03**.

![Phoenix trace showing the Opus Supervisor delegating to the Geo agent and a deterministic geographic-distance tool, with correlation and provenance attributes](docs/images/phoenix-geographic-investigation-trace.png)

*Geographic investigation: the nested Supervisor and Geo-agent path records the `deterministic_haversine` evidence source, synthetic identifiers and original `APPROVED` payment verdict.*

![Phoenix trace showing the Behaviour and Action agent branches, Sonnet model-call telemetry and deterministic policy execution](docs/images/phoenix-behaviour-action-trace.png)

*Behaviour and Action investigations: nested spans expose model selection, latency, token usage and estimated cost alongside canonical evidence retrieval and deterministic tools.*

Every trace can be correlated with PostgreSQL using investigation and trace identifiers. **Phoenix provides observability; PostgreSQL remains authoritative** for immutable payment decisions, durable cost controls and audit records. Prompts and completions are not exported by default. See the [observability guide](observability/README.md) for deployment, redaction and trace interpretation.

## Agent evaluation & regression testing

The evaluation harness uses **30 versioned synthetic fraud scenarios**, independent reference data and **ten model-quality and safety graders**. It supports deterministic offline tests, sanitised response replay and explicitly authorised live Anthropic evaluations, with results recorded locally and in Phoenix Datasets & Experiments.

### Offline regression: discovering an evidence-handling defect

The original mocked baseline passed **27/30 scenarios**. Three failures exposed an evidence-contract problem: missing, unknown or conflicting historical data could be converted into an `AVAILABLE` Behaviour assessment with low risk, allowing the deterministic policy to approve a transaction without acknowledging uncertainty.

The contract was corrected to preserve uncertainty and distinguish unavailable history from legitimately `NOT_APPLICABLE` history. With the same dataset and unchanged payment policy, the corrected offline evaluation passed **30/30**. The three affected cases changed from `APPROVED` to `CHALLENGED`, while legitimate low-risk approvals remained valid.

| Offline metric | Before | After |
| --- | ---: | ---: |
| Scenarios passed | 27/30 | 30/30 |
| Hard failures | 3 | 0 |
| Approved | 16 | 13 |
| Challenged | 12 | 15 |
| Blocked | 2 | 2 |
| Anthropic API cost | $0 | $0 |

These tests used **mocked Anthropic responses**. They validate the application and grading contract, not live-model accuracy. See the [original baseline](agents/evaluation/reports/offline-baseline-v1.md) and [post-fix report](agents/evaluation/reports/history-status-propagation-v1.md).

### Live model evaluation: Opus-led baseline

The original four-agent configuration was evaluated using **real Anthropic API responses** against all 30 synthetic scenarios. The harness assessed model-authored evidence interpretation, uncertainty and Supervisor synthesis, as well as tool use, policy compliance and decision integrity.

| Metric | Opus-led live baseline |
| --- | ---: |
| Scenarios passed | **30/30** |
| Grader checks passed | **300/300** |
| Hard safety failures / unscorable cases | 0 / 0 |
| Model calls / deterministic tool calls | 270 / 180 |
| Mean investigation latency | 24.36 seconds |
| Estimated settled API cost | **$1.04718190** |
| Recommendations | 13 approved, 15 challenged, 2 blocked |

All three tested prompt-injection scenarios passed the defined checks. Missing or conflicting evidence retained uncertainty rather than being converted into unjustified low-risk assessments. Original payment verdicts remained immutable.

Two deliberately legitimate high-velocity scenarios were nevertheless challenged by **deterministic policy**, illustrating a possible false-positive and customer-friction trade-off. This is not evidence that Opus independently detected fraud.

### Live Supervisor comparison: Opus vs Sonnet

To test whether the more expensive supervisory model was justified, the same **30 synthetic scenarios** were run once with Opus and once with Sonnet as Supervisor. The Behaviour, Geo and Action models, prompts, dataset, graders, orchestration, deterministic tools and payment policy were held constant. Both runs used genuine Anthropic API calls, with matched per-case results and Phoenix traces.

| Metric | Opus 5.5 Supervisor | Sonnet 5.5 Supervisor |
| --- | ---: | ---: |
| Scenarios passed | **30/30** | **30/30** |
| Grader checks passed | **300/300** | **300/300** |
| Hard safety failures | 0 | 0 |
| Unscorable cases | 0 | 0 |
| Model calls | 270 | 270 |
| Deterministic tool calls | 180 | 180 |
| Mean latency | 24.36 s | **18.95 s** |
| Median latency | 24.48 s | **17.33 s** |
| P95 latency | 32.52 s | **26.67 s** |
| Input tokens | 210,326 | 210,187 |
| Output tokens | 52,068 | 48,521 |
| Estimated settled API cost (30 cases) | $1.04718190 | **$0.61246720** |
| Estimated cost per case | $0.03490606 | **$0.02041557** |

**Measured result:** Sonnet matched all recorded scenario passes, grader outcomes, policy recommendations (**13 approved, 15 challenged, 2 blocked**), delegation patterns and model/tool-call counts, while reducing **mean investigation latency by 22.2%** and **estimated API cost by 41.5%** ($0.43471470 across 30 cases). Median latency fell approximately 29.2%, and P95 fell approximately 18.0%.

Human review found one substantive difference in assessment wording: in `eval-v1-insufficient-with-velocity`, Opus described a high-velocity signal and `UNKNOWN` Behaviour status as a conflict; Sonnet described an unresolved indicator without implying a contradiction. Both retained uncertainty and returned `CHALLENGED`. Three other cases differed in uncertainty wording without changing the interpreted evidence.

**Engineering decision:** For this synthetic workload and these graders, the comparison provides **no measured justification for Opus's higher supervisory cost**. Sonnet is the preferred candidate for the Supervisor role, with Opus retained as a configurable option for harder cases and future re-evaluation.

**Evaluation limits:** These are **one live trial per model per synthetic case**, not statistically established model equivalence or production fraud-detection accuracy. The suite may be too easy to separate their reasoning performance. Deterministic policy governs the final recommendations, so recommendation parity alone does not establish equal fraud-detection intelligence. Broader adversarial scenarios and repeated trials are future work; analyst review/disposition would be a further operational integration step, not a feature claimed here.

See the [matched comparison report](agents/evaluation/reports/live-opus-vs-sonnet-30-v1.md), [Sonnet live evaluation report](agents/evaluation/reports/live-sonnet-supervisor-30-v1.md), [initial six-case Opus report](agents/evaluation/reports/live-opus-baseline-v1.md) and [evaluation harness guide](agents/evaluation/README.md) for methodology and case-level results. The Opus 30-case baseline was assembled from the original six-case pilot and a separate 24-case experiment; neither historical record was modified for this comparison.

## Technology

| Area | Implementation |
| --- | --- |
| Streaming | Confluent Kafka 8.1.6, Apache Flink 1.20.2 |
| Decisioning | Python, deterministic versioned policies |
| AI investigations | Anthropic SDK, Claude multi-agent tool-use orchestration |
| Agent observability | Arize Phoenix 20.23.0, OpenTelemetry, OpenInference |
| Evaluation | Versioned synthetic datasets, deterministic graders, Phoenix Experiments |
| Durable state | PostgreSQL 17, SQLAlchemy, Alembic |
| Local runtime | Podman Compose |
| Verification | Pytest, Ruff, synthetic integration scenarios |

## Repository structure

- [`confluent-flink/`](confluent-flink/) — Kafka and Flink infrastructure, Java DataStream enrichment, SQL fraud signals, synthetic transaction generator and lifecycle scripts.
- [`agents/`](agents/) — Decision router, Claude investigation agents, asynchronous worker, budget enforcement, database models, migrations and tests.
- [`agents/evaluation/`](agents/evaluation/) — Versioned synthetic dataset, graders, offline/replay/live evaluation runner, Phoenix experiments and reports.
- [`fraud-decisioning/`](fraud-decisioning/) — PostgreSQL deployment, operational workflows and recovery documentation.
- [`docs/architecture.md`](docs/architecture.md) — Architecture, trust boundaries, agent responsibilities and decision-authority model.
- [`observability/`](observability/) — Optional Phoenix deployment, OpenTelemetry configuration, trace interpretation and no-cost smoke test.

## Documentation

- [Streaming and Flink guide](confluent-flink/README.md)
- [Decisioning, recovery and operations](fraud-decisioning/README.md)
- [Agent architecture and security boundaries](docs/architecture.md)
- [Phoenix and OpenTelemetry observability](observability/README.md)
- [Fraud-agent evaluation harness](agents/evaluation/README.md)

## Security and execution controls

Live Anthropic investigations are disabled by default and require explicit enablement and durable budget approval. Payment verdicts are protected by database-enforced immutability, while AI recommendations are recorded separately for audit and follow-up.

API credentials and local environment configuration remain outside version control, with safe configuration templates provided in the repository.
