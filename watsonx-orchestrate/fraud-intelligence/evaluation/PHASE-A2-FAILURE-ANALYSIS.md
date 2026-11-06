# Phase A.2 failure analysis

This analysis freezes the Phase A.1 evidence before any Phase A.2 agent or evaluator change. It covers all
13 scenarios that failed exact live extraction. Raw responses are under `results/phase-a1-live/`; the
deterministic grading source is `results/phase-a1-summary.json`.

## Classification summary

| Classification | Affected observations | Conclusion |
|---|---:|---|
| Genuine evidence-extraction error | 6 scenarios | Supported indicators or contradiction-derived evidence were omitted |
| Missing or incorrect provenance | 5 scenarios | Every missing indicator also lacked its required provenance |
| Incorrect bounded-value interpretation | 8 scenarios | Seven `EXPECTED` answers became `NONE`; one `OTHER` purpose became `UNCERTAIN` |
| Ambiguous or defensible alternative | 1 scenario | `HIGH` uncertainty was conservative, but contradicted the defined `MEDIUM` mapping |
| Overly strict or incorrect expectation | 0 | Every failed expectation follows the questionnaire mapping or explicit supported indicator rules |
| Unsupported schema concept | 0 | All expected findings exist in evidence schema 1.1.0 |
| Transient provider/structured-output failure | 2 invocations | No schema-versioned evidence was returned; both scenarios passed or reached structured grading on retry |

The classifications overlap where one omission necessarily causes missing provenance. Severity reflects
effect on deterministic downstream interpretation, not whether the original payment authority changes; it
never does.

## Per-scenario analysis

| Scenario | Expected | Phase A.1 actual | Classification and root cause | Severity | Recommended action |
|---|---|---|---|---:|---|
| `investment-known-adviser-promised-return` | `thirdPartyInfluence=EXPECTED`; `INVESTMENT` with provenance | First call returned no schema-versioned evidence. Retry returned complete investment evidence but changed `EXPECTED` to `NONE` while citing the literal `EXPECTED` answer. | Transient structured-output failure plus incorrect bounded-value interpretation. The model semantically collapsed “expected contact” into “no suspicious contact”. | High | Make bounded mappings immutable and validate them after extraction; retain provider failure as a failed attempt. |
| `investment-third-party-beneficiary` | `THIRD_PARTY_BENEFICIARY` and provenance from the friend's-account instruction | Indicator and provenance absent; all other expected evidence present. | Genuine extraction and provenance omission. The narrative explicitly directs payment to somebody other than the broker. | High | Define general third-party-beneficiary language and require a final narrative-indicator scan. |
| `bank-security-team-third-party` | Bank impersonation plus `UNEXPECTED_CONTACT` and `THIRD_PARTY_BENEFICIARY`, all sourced | Only bank impersonation was returned. | Genuine extraction/provenance omissions. Specialising influence to bank impersonation incorrectly suppressed the independently supported unexpected-contact and third-party findings. | Critical | State that specialised influence never removes additive indicators; validate bounded `UNEXPECTED` and explicit third-party instructions independently. |
| `family-daughter-urgent-new-number` | Unexpected contact, pressure, urgency and third-party beneficiary | Three of three runs omitted only `THIRD_PARTY_BENEFICIARY` and its provenance. | Repeatable genuine extraction/provenance omission. “Told me to pay an unknown beneficiary” is explicit and supported. | High | Generalise third-party recognition beyond possessive-account wording; add invariant validation. |
| `family-expected-help` | `thirdPartyInfluence=EXPECTED` | `NONE`, with provenance citing `EXPECTED`. | Incorrect bounded-value interpretation. | Medium | Preserve the literal bounded mapping regardless of risk semantics. |
| `purchase-invoice-only` | `thirdPartyInfluence=EXPECTED` | `NONE`, with provenance citing `EXPECTED`; invoice evidence was correct. | Incorrect bounded-value interpretation. | Medium | Preserve bounded mapping; do not equate expected contact with no contact. |
| `legitimate-known-business` | `thirdPartyInfluence=EXPECTED` | `NONE`, with provenance citing `EXPECTED`. | Incorrect bounded-value interpretation. | Medium | Preserve bounded mapping. |
| `legitimate-new-business-high-value` | Complete low-risk structured evidence | First call returned no schema-versioned evidence; retry passed all assertions. | Transient provider/structured-output failure, not an extraction expectation defect. | High | Continue fail-closed handling and explicit failed-attempt reporting; do not synthesize evidence. |
| `legitimate-invoice-not-independent-proof` | `thirdPartyInfluence=EXPECTED` | `NONE`, while both verification claims and provenance were correct. | Incorrect bounded-value interpretation. | Medium | Preserve bounded mapping independently of verification claims. |
| `ambiguous-recognition-unsure` | Bounded `paymentPurpose=OTHER`; uncertainty comes from recognition | Purpose changed to `UNCERTAIN`, with provenance citing `OTHER`. | Incorrect bounded-value interpretation. Uncertainty in one field leaked into another explicit bounded field. | High | Make each bounded mapping independent; uncertainty must not rewrite other answered fields. |
| `ambiguous-remote-access-unsure` | `thirdPartyInfluence=EXPECTED`, overall `MEDIUM` | Influence became `NONE`; overall uncertainty was correct. | Incorrect bounded-value interpretation. | Medium | Preserve bounded influence while separately recording remote-access uncertainty. |
| `contradiction-purpose-investment-versus-family` | Preserve bounded investment and expected contact, record contradiction, `MEDIUM` uncertainty | Preserved investment and contradiction but changed influence to `NONE` and used `HIGH`. | Incorrect bounded mapping plus a conservative/defensible interpretation that violates the defined contradiction-to-`MEDIUM` contract. | Medium | Preserve all bounded answers; use `MEDIUM` for supplied contradictions and reserve `HIGH` for missing required evidence. |
| `contradiction-contact-none-versus-caller` | Preserve bounded influence `NONE`, record contradiction, and add narrative-supported unexpected contact and urgency | Preserved `NONE`, contradiction and urgency, but omitted `UNEXPECTED_CONTACT` and provenance. | Genuine extraction/provenance omission. The model identified the contradiction yet discarded one side's supported indicator. | High | Explicitly require contradictory evidence to coexist: bounded field remains unchanged while supported narrative indicators and provenance are retained. |

## Root cause and change boundary

The schema can represent every expected Phase A.1 finding. The failures arise because the instructions mix
three tasks without a sufficiently explicit ordering boundary: immutable bounded mapping, additive narrative
extraction, and contradiction/uncertainty reporting. The model sometimes resolves these into one semantic
summary instead of preserving each evidence source.

The justified correction is therefore instruction-level and general:

1. map every supplied bounded answer mechanically and never rewrite it from narrative or uncertainty;
2. scan narrative evidence additively for supported indicators, especially third-party payment directions;
3. preserve both sides of contradictions and use the defined uncertainty mapping;
4. perform a final invariant audit and report violations rather than silently normalising evidence in
   Glaramara.

No Phase A.1 expectation should be weakened, no new fraud category is needed, and no schema, policy, guidance,
payment authority or ledger change is justified by this analysis.
