# Multi-agent architecture and trust boundaries

## Core rule

`fast_path_policy.decide` is the sole initial payment authority and its decision is immutable. Claude
can select approved investigation tools and produce explanations. The separate
`policy_engine.apply_decision_rules` produces a deterministic investigation recommendation, never a
replacement payment verdict. The Supervisor response is constructed from validated policy output,
never model text.

## Evidence provenance

Four evidence classes remain structurally separate:

| Evidence | Authority | Mutable by Claude? |
|---|---|---:|
| Rolling counts, totals, signals, signal IDs | Flink enrichment (`evidence_source=flink`) | No |
| Distance and geographic applicability | Python Haversine tool | No |
| Historical statistics | Payments Engine or named fixture reference | No |
| Specialist explanation | Claude in live mode or fixture in dry-run | Yes, but non-authoritative |

The current Flink output does not contain GPS, payment channel, or historical statistics. The CLI therefore accepts those as a separate optional `context`/`historical` envelope. Missing card-present GPS is `UNKNOWN`; e-commerce distance is `NOT_APPLICABLE`. No average or z-score is inferred when historical evidence is absent.

## Live tool flow

The application drives the Anthropic Messages API client-tool loop manually so it can enforce validation, timeouts, cost accounting, and tool restrictions.

1. The configured Supervisor receives only a validated transaction ID and tools for Geo, Behaviour,
   and Action.
2. It may request Geo and Behaviour in one response; Python executes parallel tool calls concurrently.
3. Geo Haiku must call `check_geo_distance`. The handler ignores model-supplied numbers and returns the prevalidated deterministic result.
4. Behaviour Sonnet must call `get_canonical_behaviour_evidence`. The handler returns immutable Flink fields and separately tagged historical evidence.
5. Supervisor cannot call Action successfully until both mandatory specialist results exist.
6. Action Haiku must call `apply_decision_rules` with the stable investigation reference. It cannot pass risk numbers or a proposed verdict.
7. Python retrieves the evidence bundle, applies policy, reruns it for consistency, and constructs the final external response.

Every agent has a restricted registry. Unknown tools, malformed inputs, mismatched identities, excessive iterations and timeouts are rejected. Transaction strings and tool results are treated as untrusted data and never inserted into system instructions.

If the Supervisor omits a mandatory step, a specialist fails, evidence conflicts, or the API is unavailable, Python creates explicit failed evidence and applies `POL-FAILSAFE-INCOMPLETE-EVIDENCE`. Missing required evidence cannot produce approval.

## Supervisor model selection

Opus 5.5 was the original Supervisor configuration and remains the application's configured default.
Sonnet 5.5 was subsequently evaluated against Opus across the same 30 synthetic scenarios, with the
specialist models, prompts, tools, deterministic policy and graders held constant. Both configurations
met all defined quality criteria; Sonnet used less estimated API cost and had lower measured latency.

Sonnet 5.5 is therefore the recommended Supervisor for this evaluated workload. This recommendation
does not claim that the current default has changed, that the models are statistically equivalent, or
that the synthetic evaluation establishes production fraud-detection accuracy. The matched results are
documented in the
[`live-opus-vs-sonnet-30-v1` report](../agents/evaluation/reports/live-opus-vs-sonnet-30-v1.md).

## Dry-run flow

Dry-run invokes no SDK methods. Geo and Behaviour run independently with `asyncio.gather`, all deterministic tools remain active, explanations are tagged `fixture`, model usage is empty, and API cost is zero. It exercises the same evidence repository and policy engine used by live mode.

## Investigation policy version 1.0.0

Demonstration rules are intentionally conservative but do not claim regulatory compliance:

- Missing, failed or conflicting required evidence: `CHALLENGED`.
- Significant card-present geographic anomaly: `CHALLENGED`.
- High velocity alone: `CHALLENGED`.
- Velocity plus merchant hopping: `CHALLENGED`.
- Geographic anomaly combined with a behavioural signal: `BLOCKED`.
- No qualifying rule with complete/applicable evidence: `APPROVED`.

Amount alone is not a fraud rule. In particular, ordinary £10–£150 payments and a standalone higher-value payment are not automatically challenged or blocked.

## Audit and costs

The internal audit record contains stable investigation/transaction IDs, timestamp, configured models, tool outcomes and source classes, canonical references, policy version, triggered rules, deterministic reason, failures, per-call tokens/latency/cost, total estimated cost, and end-to-end latency. It excludes hidden reasoning and credentials.

Before each live request, a shared per-investigation controller reserves estimated worst-case output cost plus approximate input cost. Concurrent calls share the same lock and budget. Actual SDK `input_tokens` and `output_tokens` settle the reservation. Provider-side billing can still differ due to pricing changes, caching, tiered Haiku pricing, or token-accounting features; this is not a guaranteed billing cap.

## Observability boundary

Optional OpenTelemetry spans describe the worker, Supervisor, specialists, Anthropic Messages calls,
deterministic tools, policy result, and PostgreSQL/outbox hand-off using OpenInference span kinds.
Investigation, attempt, transaction, decision, and correlation identifiers join traces back to durable
records. PostgreSQL—not Phoenix—remains the source of truth for decisions, retries, cost accounting,
budgets, provenance, and audit.

Tracing is disabled by default and fails open: collector or exporter failures cannot fail an
investigation, trigger an Anthropic retry, or change a recommendation. Raw prompt/completion capture is
off unless an operator explicitly enables the synthetic-data-only option; structured attributes are
allowlisted and sensitive keys are redacted. The Kafka event schemas remain unchanged, preserving
event IDs and idempotency. Consequently, router and investigation-worker processes correlate through
durable IDs rather than continuous propagated trace context.

See [`observability/README.md`](../observability/README.md) for the Phoenix deployment, security model,
trace interpretation, and no-cost smoke test.

## Future Payments Engine interface

`PaymentsEngineClient` reserves two validated HTTP boundaries without calling them yet:

- `GET /v1/transactions/{transaction_id}/velocity`
- `GET /v1/users/{user_id}/spending-anomaly`

A future Payments Engine integration may enrich the separate Claude context envelope and invoke the same
Supervisor. It remains outside this phase and separate from the baseline ML shadow consumer below.

## Experimental baseline ML shadow path

Milestone 1 adds a separate, opt-in path:

```text
payments.enriched.demo -> CPU LightGBM shadow scorer -> fraud.risk.baseline.demo
```

The scorer uses the same canonical Flink payload validation as the deterministic router but shares no
decision authority, persistence, offset group, or failure domain with it. It does not change immutable
payment decisions and does not call Claude. `fraud.risk.baseline.demo` schema 1.0.0 carries a stable
model-and-transaction-derived event ID, probability, model and feature-schema versions, event/model time,
latency, and input provenance. Kafka delivery is at least once, so stable event IDs are the deduplication
boundary. The consumer is disabled unless `FRAUD_SHADOW_SCORING_ENABLED=true`.

The feature contract is `fraud-features-1.0.0` and contains only contemporaneous enriched values. The
training, validation, and later held-out test cohorts are separated by customer and event-time ranges.
Synthetic ground truth comes from latent scenarios rather than Flink signals, router verdicts, or Claude.
See [`agents/README.md`](../agents/README.md) for the reproducible methodology, measured results, and limits.

The roadmap is baseline ML shadow scoring now, followed later by separately governed Claude customer
evidence extraction and evidence-enriched ML. Those later phases and a fraud dashboard are not part of
this milestone.

## Asynchronous fraud assessment correlation

The Go Fraud Assessment Correlator consumes the deterministic decision, LightGBM risk, and Claude
request/completion streams and builds a versioned assessment per `transaction_id`. It is downstream of
all producers and has no payment-authorisation authority. It can publish an ML-first or decision-first
partial assessment and enrich it as out-of-order events arrive. The original deterministic verdict is
copied as immutable evidence; neither an ML probability nor a Claude recommendation can revise it.

PostgreSQL is the correlation system of record. Source-event identities and Kafka positions provide
durable deduplication, transaction-scoped locks serialize updates for one payment, history records every
meaningful revision, and a separate outbox survives Kafka outages. Kafka publication remains at least
once because PostgreSQL commit and Kafka acknowledgement are not one atomic transaction.

No current Kafka event exposes terminal investigation failure or timeout. The correlator therefore
does not turn missing events into a negative claim. A future additive investigation-status event should
make `FAILED`, `TIMED_OUT`, and ambiguous terminal states observable without querying another service's
private tables.

## Go Fraud Decision Engine: shadow Action Selection

A separate Go decision engine now consumes correlated assessments and applies
`fraud-action-policy-v1` in shadow mode. It evaluates only when both the immutable deterministic decision
and a supported LightGBM prediction exist. Partial, invalid, duplicate, and obsolete revisions are
durably classified and cannot produce an implicit approval. PostgreSQL history and an outbox make
publication to `fraud.decisions.shadow.demo` replay-safe at the application boundary; physical Kafka
duplicates remain possible after acknowledgement and are deduplicated by the stable shadow evaluation ID.

The policy preserves every deterministic hard block. A deterministic approval plus an experimental ML
probability at or above 0.24 becomes a shadow challenge, never an ML-only block. An existing deterministic
challenge plus probability at or above 0.70 becomes a shadow block. These thresholds are explicit POC
configuration derived from the synthetic model's validation-selected operating point and a deliberately
more conservative combined-evidence escalation boundary. They are not calibrated production fraud rates
or banking policy. Claude investigation results are copied as audit context but are not policy inputs.

## Future synchronous payment-time design

Flink would populate a near-real-time, point-in-time behavioural feature store. At payment time a
synchronous API around the same pure Action Selection package would retrieve features, combine them with
the new payment, run deterministic controls and synchronous LightGBM inference, and return the versioned
`APPROVED`, `BLOCKED`, or `CHALLENGED` action within an explicit latency budget.

Only selected challenged cases would enter the existing asynchronous Claude customer-evidence workflow.
Validated evidence could feed a later, separately versioned ML reassessment, while the original payment
decision remains immutable. The synchronous boundary must reject stale or future-dated features, use
point-in-time retrieval to avoid future-data leakage, define fail-safe behaviour for feature-store and
model failures, and reserve latency independently for retrieval, inference, policy, persistence, and
publication. Original authorisation and later challenge resolution remain distinct versioned events.
The Commonwealth Bank-inspired rule-discovery agents remain a separate asynchronous, human-approved
capability. Neither Claude nor the correlator belongs on the critical authorisation path.
