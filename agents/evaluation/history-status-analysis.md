# Historical evidence status analysis

This analysis compares the immutable `part4b-offline-baseline-v1-mocked` baseline with the separate
`part4b-history-status-propagation-v1` experiment. Dataset version
`fraud-investigations/1.0.0`, its ground truth, and the original baseline reports were not edited.

## Original failures

| Scenario | Historical input | Expected | Baseline actual | Failed graders |
|---|---|---|---|---|
| `eval-v1-history-missing:trial-1` | `null` | `CHALLENGED`, `POL-FAILSAFE-INCOMPLETE-EVIDENCE` | `APPROVED`, `POL-APPROVE-NO-QUALIFYING-RISK` | factual accuracy; uncertainty acknowledgement; policy compliance |
| `eval-v1-history-unknown:trial-1` | status `UNKNOWN`; statistics `null` | `CHALLENGED`, `POL-FAILSAFE-INCOMPLETE-EVIDENCE` | `APPROVED`, `POL-APPROVE-NO-QUALIFYING-RISK` | factual accuracy; uncertainty acknowledgement; policy compliance |
| `eval-v1-history-conflicting:trial-1` | status `CONFLICTING`; sample size 20 | `CHALLENGED`, `POL-FAILSAFE-INCOMPLETE-EVIDENCE` | `APPROVED`, `POL-APPROVE-NO-QUALIFYING-RISK` | factual accuracy; uncertainty acknowledgement; policy compliance; contradictory-evidence handling |

All three inputs otherwise contain low-risk local card-present geography and no Flink risk signals.
Their original payment verdict is `APPROVED`; the investigation recommendation never mutates it.

## Root cause

`HistoricalEvidence.status` correctly represented `UNKNOWN` and `CONFLICTING`, and the entire object
survived inside `BehaviourCanonical.historical`. The Behaviour agent then unconditionally emitted
top-level `BehaviourAssessment.status=AVAILABLE` and inferred `risk_level=LOW` solely from an empty
Flink signal list. The Supervisor stored that assessment unchanged. Action policy already fails closed
for top-level `FAILED`, `UNKNOWN`, or `CONFLICTING`, but it received `AVAILABLE`, so it reached the
no-qualifying-risk approval rule.

This is a propagation defect for explicit `UNKNOWN` and `CONFLICTING` evidence. A `null` history is also
a contract ambiguity: it cannot distinguish a failed/unavailable lookup from a legitimate new customer.
The dataset's fail-safe expectation is defensible only when `null` means unavailable. Producers should
represent a legitimate no-history customer explicitly as `HistoricalEvidence.status=NOT_APPLICABLE`.

## Narrow correction

Behaviour assessment now maps:

- absent history to `UNKNOWN`;
- `UNKNOWN`, `FAILED`, or `CONFLICTING` history to the same top-level status;
- `AVAILABLE` or explicit `NOT_APPLICABLE` history to top-level `AVAILABLE`, because independently
  sourced Flink evidence remains usable.

Uncertain top-level status must carry `RiskLevel.UNKNOWN`; schema validation rejects a silent conversion
to `LOW`. The existing deterministic fail-safe rule then produces a `CHALLENGED` recommendation. No
policy rule, policy version, payment decision, database record, or ground-truth expectation changed.

## Comparison and implications

The new experiment passes 30/30 cases. Only the three historical-status cases changed, each from
`APPROVED` to `CHALLENGED`. Aggregate outcomes changed from 16 approved / 12 challenged / 2 blocked to
13 approved / 15 challenged / 2 blocked.

The trade-off is a possible challenge false positive when an upstream producer uses `null` for a
legitimate new customer. Explicit `NOT_APPLICABLE` avoids that outcome, and regression tests confirm
that both a new customer with `NOT_APPLICABLE` history and an `AVAILABLE` one-record history can still
be approved when other evidence is low risk. Operationally, producers should migrate away from
ambiguous `null`; until then, fail-safe challenge is preferred to silently treating unavailable evidence
as normal.

The pre-existing five-case synthetic live-scenario producer also used `null` to mean “not part of this
scenario.” It now emits explicit `NOT_APPLICABLE`, preserving its established velocity and geo policy
expectations while conforming to the clarified contract. This changes future synthetic inputs only; it
does not rewrite any completed experiment or payment record.
