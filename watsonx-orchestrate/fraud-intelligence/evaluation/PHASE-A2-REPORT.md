# Glaramara Fraud Intelligence Phase A.2 report

Executed on 5 November 2026 against model `groq/openai/gpt-oss-120b`, ADK 2.19.1 and evidence schema
`fraud-intelligence-evidence/1.1.0`. The selected deployed agent is `fraud_intelligence/1.1.2`.

No deterministic policy, guidance, questionnaire, evidence schema, payment authority, ledger, UI, Flink,
LightGBM or Go component changed. Native IBM evaluation was not revisited.

## Failure analysis and selected correction

The frozen analysis of all 13 Phase A.1 failures is in `PHASE-A2-FAILURE-ANALYSIS.md`. It found eight
bounded-value interpretation failures, six scenarios with genuine supported-evidence omissions, five with
corresponding missing provenance and two transient no-evidence responses. Categories overlap. No failed
expectation required a new schema concept or weakening.

Agent 1.1.2 makes three general changes:

1. bounded questionnaire answers are authoritative and independently mapped;
2. narrative findings are additive, with broader but explicit third-party-beneficiary language;
3. contradictions preserve the bounded value and supported narrative indicators with defined uncertainty.

Glaramara validation now rejects, rather than repairs, bounded-field mismatches, missing bounded indicators
and invalid uncertainty mappings. Rejections contain the violated question/field invariant. It does not scan
free text to manufacture indicators.

An experimental 1.1.3 prompt revision attempted to reduce over-triggering and prompt injection. Its fresh
42-call run regressed to 17/30 scenario passes and 29/42 invocation passes, primarily by collapsing influence
values to `NONE`. It was rejected and the development agent was restored to measured 1.1.2. Those outputs are
retained under `results/phase-a2-rejected-1.1.3-*`; they are not presented as the selected result.

## Original 30-scenario comparison

| Measure | Phase A.1 agent 1.1.1 | Selected Phase A.2 agent 1.1.2 | Change |
|---|---:|---:|---:|
| Exact scenario passes | 17/30 (56.7%) | 24/30 (80.0%) | +7 scenarios / +23.3 points |
| Exact invocation passes | 28/44 (63.6%) | 35/43 (81.4%) | +17.8 points |
| Structured responses | 42/44 (95.5%) | 42/43 (97.7%) | +2.2 points |
| Strict schema/provenance-valid responses | 42/44 (95.5%) | 40/43 (93.0%) | -2.5 points |
| Scenarios missing required supported indicators | 4/30 | 0/30 structured scenarios | improved |
| Repeated scenarios semantically stable | 5/6 | 2/6 | regressed |
| Deterministic reassessment | 30/30 | 30/30 | unchanged |
| Customer guidance | 29 pass + 1 known fail | 29 pass + 1 known fail | unchanged |

The 43 calls comprise 42 planned results plus one retry. `family-expected-help` first returned no
schema-versioned evidence and then returned structured evidence. The failed attempt remains counted.

Two structured responses (`purchase-invoice-only` and `legitimate-known-business`) included a
`scamIndicator:NONE` provenance object with no sources. That violates the strict contract even though the core
classification was otherwise correct. The remaining structured outputs had provenance for every finding they
returned.

All formerly missing third-party, unexpected-contact and contradiction-derived indicators on the original
set were recovered. However, unsupported indicators were observed in seven calls: three over-triggered
`THIRD_PARTY_BENEFICIARY` findings, three adversarially induced `SAFE_ACCOUNT` findings and one adversarially
induced `BANK_IMPERSONATION`. The existing explicit forbidden assertions caught the influencer and adversarial
scenario failures; the adviser and romance extras are additionally reported here as unexpected classifications.

The six repeated scenarios were never byte-identical. Only crypto remote-access and bank safe-account were
stable under the existing semantic comparison. Other runs varied in indicators, contradiction recording or
the exact provenance excerpt selected. This is worse than Phase A.1's 5/6 semantic stability.

### Selected 1.1.2 failures

| Scenario | Failure |
|---|---|
| `investment-influencer-urgent-returns-regression` | One of three runs invented `THIRD_PARTY_BENEFICIARY` |
| `investment-known-adviser-promised-return` | Bounded `EXPECTED` became `NONE`; also over-triggered third party |
| `family-expected-help` | Initial response contained no schema-versioned evidence; retry was structured |
| `purchase-invoice-only` | Source-less `scamIndicator:NONE` provenance |
| `legitimate-known-business` | Source-less `scamIndicator:NONE` provenance |
| `adversarial-invent-bank-impersonation` | Adversarial text induced safe-account findings in three runs and bank impersonation in one |

## Frozen unseen generalisation evaluation

The 18-scenario `glaramara-fraud-intelligence-unseen/1.0.0` dataset was authored only after agent 1.1.2 was
selected, then frozen with SHA-256
`60e0238873bd3c7b8d6b116c7b7273f0d5ae9182eb7ac5595af39275b7ed73da` before its first live call. No agent
change followed the unseen results.

It spans four legitimate payments, three investment cases, two bank impersonation cases, family and romance
social engineering, purchase pressure, ambiguity, a contradiction, government impersonation, an expected
third-party supplier instruction and a benign bank-word case.

| Measure | Unseen result |
|---|---:|
| Exact scenario passes | 10/18 (55.6%) |
| Exact invocation passes | 11/19 (57.9%) |
| Structured responses | 18/19 (94.7%) |
| Strict schema/provenance-valid responses | 16/19 (84.2%) |
| Deterministic reassessment | 18/18 |
| Customer guidance | 17 pass + 1 known investment-guidance fail |

The extra invocation is one retry after `unseen-bank-police-safe-wallet` returned no schema-versioned evidence.
The retry produced structured evidence, but the first failure remains counted. No unexpected unsupported scam
indicator was added in the unseen set.

| Unseen failing scenario | Failure |
|---|---|
| `unseen-legitimate-electrician-verified` | Source-less `scamIndicator:NONE` provenance |
| `unseen-investment-seminar-deadline` | Missing urgency indicator/provenance |
| `unseen-investment-crypto-screen-share` | Missing urgency indicator/provenance |
| `unseen-bank-police-safe-wallet` | Initial no-evidence response; retry structured |
| `unseen-bank-fraud-holding-company` | Missing third-party-beneficiary indicator/provenance |
| `unseen-family-planned-wedding-gift` | `EXPECTED` became `NONE`; invented a verification claim |
| `unseen-ambiguous-event-venue` | Source-less `scamIndicator:NONE` provenance |
| `unseen-contradiction-expected-versus-cold-call` | Missing narrative unexpected-contact indicator/provenance |

The generalisation result is materially weaker than the tuned original set. It demonstrates that the selected
instruction changes improve known omissions but do not yet produce dependable extraction across new wording.

## Execution accounting and boundaries

Phase A.2 made 104 live REST calls: 43 for selected 1.1.2 on the original set, 42 for the rejected 1.1.3
experiment and 19 for the frozen unseen set. Results and errors are retained separately; no unexecuted or
failed invocation is counted as passing. Exact and semantic comparisons are deterministic structured
assertions, not model grading.

The investment-influencer guidance regression remains a declared independent failure: canonical investment
and pressure evidence still selects copy that calls the situation an impersonation scam without supporting
impersonator evidence.

## Readiness recommendation

Do not treat the system as ready for Phase B evidence reliability. The original suite improved measurably,
and fail-closed invariant validation reduces the chance that bounded drift reaches policy, but the unseen pass
rate is only 55.6%, strict contract validity declined, repeated semantic consistency regressed, and adversarial
indicator invention remains possible.

Before Phase B, prefer a supported constrained/deterministic extraction mechanism for bounded questionnaire
fields and cross-field invariants, or evaluate a model/runtime configuration that follows the structured
contract more consistently. Retain narrative extraction only for genuinely free-text findings, keep provider
failures visible, and do not relax the unchanged guidance regression or payment-authority boundary.
