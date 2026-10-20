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

1. Opus Supervisor receives only a validated transaction ID and tools for Geo, Behaviour, and Action.
2. It may request Geo and Behaviour in one response; Python executes parallel tool calls concurrently.
3. Geo Haiku must call `check_geo_distance`. The handler ignores model-supplied numbers and returns the prevalidated deterministic result.
4. Behaviour Sonnet must call `get_canonical_behaviour_evidence`. The handler returns immutable Flink fields and separately tagged historical evidence.
5. Supervisor cannot call Action successfully until both mandatory specialist results exist.
6. Action Haiku must call `apply_decision_rules` with the stable investigation reference. It cannot pass risk numbers or a proposed verdict.
7. Python retrieves the evidence bundle, applies policy, reruns it for consistency, and constructs the final external response.

Every agent has a restricted registry. Unknown tools, malformed inputs, mismatched identities, excessive iterations and timeouts are rejected. Transaction strings and tool results are treated as untrusted data and never inserted into system instructions.

If the Supervisor omits a mandatory step, a specialist fails, evidence conflicts, or the API is unavailable, Python creates explicit failed evidence and applies `POL-FAILSAFE-INCOMPLETE-EVIDENCE`. Missing required evidence cannot produce approval.

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

## Future Payments Engine interface

`PaymentsEngineClient` reserves two validated HTTP boundaries without calling them yet:

- `GET /v1/transactions/{transaction_id}/velocity`
- `GET /v1/users/{user_id}/spending-anomaly`

The first Kafka integration should consume `payments.enriched.demo`, persist/idempotently claim `transaction_id`, enrich the separate context envelope, and invoke the same Supervisor. That consumer is intentionally outside this phase.
