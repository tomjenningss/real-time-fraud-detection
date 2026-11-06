# Glaramara Fraud Intelligence Phase A baseline

Executed on 5 November 2026 against repository `fraud_intelligence/1.1.0`, ADK 2.19.1, IBM evaluation
framework 1.5.2, evidence schema `fraud-intelligence-evidence/1.1.0`, policy
`customer-evidence-reassessment/1.1.0` and guidance `fraud-prevention-guidance/1.0.0`.

No agent definition, evidence schema, policy, guidance, payment authority, payment decision, balance or
ledger behavior was changed. Live calls used synthetic questionnaire data only.

## Results

| Layer | Executed result | Baseline status |
|---|---|---|
| Native Orchestrate evaluation | One exact-payload smoke case; zero agent steps, journey success false | Unsupported by evaluator 1.5.2 because its literal `END` termination check matches `FRIENDS_FAMILY`; not counted as an agent result |
| Extraction, direct ADK diagnostic | Mandatory influencer scenario; schema/provenance valid; 5,829 ms | Fail: omitted required `INVESTMENT` scam indicator and its provenance |
| Extraction, Glaramara REST parity | Same scenario through `/v1/orchestrate/{agent_id}/chat/completions`; schema/provenance valid; 5,922 ms | Fail: same omission as ADK; semantic parity observed |
| Deterministic reassessment | 30 canonical validated evidence fixtures | 30 pass, 0 fail |
| Customer guidance | Same 30 fixtures and observed policy results | 29 pass, 0 unexpected fail, 1 known fail |

The 29 uninvoked extraction scenarios are `NOT_RUN`, not passes. In scenario-level terms the extraction
summary is 0 pass, 1 fail and 29 not run; both executed transport runs failed the same expectation.

## Mandatory investment regression

Scenario `investment-influencer-urgent-returns-regression` states that an online influencer promised
guaranteed returns and demanded an urgent payment before the opportunity closed.

Expected validated evidence is investment purpose plus `INVESTMENT`, `UNEXPECTED_CONTACT`,
`PRESSURE_OR_SECRECY` and `URGENCY`, with no `BANK_IMPERSONATION`, `SAFE_ACCOUNT`, remote-access or
third-party-beneficiary invention. That evidence deterministically declines under
`CER-DECLINE-PRESSURE-SECRECY`.

Both live transports returned `paymentPurpose=INVESTMENT`, `thirdPartyInfluence=UNEXPECTED`, urgency,
pressure and unexpected-contact indicators with verbatim provenance. Neither invented bank impersonation.
Both omitted the separate `INVESTMENT` indicator and `scamIndicator:INVESTMENT` provenance despite the
agent instruction requiring the bounded `INVESTMENT` purpose to produce it. Extraction therefore fails on
both paths; ADK and REST are nevertheless in parity for the observed semantic values (array ordering alone
differed).

Independently, the guidance layer was evaluated with the canonical schema-valid expected evidence. It selects
`UNEXPECTED_CONTACT_AND_PRESSURE` and renders “That can be a warning sign of an impersonation scam.” No
bank, family, trusted-person or other impersonation evidence supports that statement. This is the required
known failing guidance regression. It remains failing even though the live extraction also has a separate
investment-indicator omission; neither defect masks the other. As a cross-check, feeding either live ADK or
REST evidence through the unchanged policy and guidance produced the same
`CER-DECLINE-PRESSURE-SECRECY` / `UNEXPECTED_CONTACT_AND_PRESSURE` result and the same unsupported phrase.

## Per-scenario result

`NR` means not run. `KF` means known failing regression.

| Scenario | Extraction | Policy | Guidance |
|---|---:|---:|---:|
| investment-influencer-urgent-returns-regression | Fail (ADK + REST) | Pass | KF |
| investment-known-adviser-promised-return | NR | Pass | Pass |
| investment-crypto-remote-access | NR | Pass | Pass |
| investment-third-party-beneficiary | NR | Pass | Pass |
| bank-safe-account-call | NR | Pass | Pass |
| bank-security-team-third-party | NR | Pass | Pass |
| bank-remote-access | NR | Pass | Pass |
| bank-word-only-no-contact | NR | Pass | Pass |
| family-daughter-urgent-new-number | NR | Pass | Pass |
| family-son-lost-phone | NR | Pass | Pass |
| family-expected-help | NR | Pass | Pass |
| family-unsure-contact | NR | Pass | Pass |
| romance-new-partner-emergency | NR | Pass | Pass |
| romance-travel-ticket | NR | Pass | Pass |
| purchase-marketplace-pressure | NR | Pass | Pass |
| purchase-builder-verified | NR | Pass | Pass |
| purchase-invoice-only | NR | Pass | Pass |
| legitimate-known-business | NR | Pass | Pass |
| legitimate-known-person | NR | Pass | Pass |
| legitimate-new-business-high-value | NR | Pass | Pass |
| legitimate-invoice-not-independent-proof | NR | Pass | Pass |
| legitimate-unrecognised-payment | NR | Pass | Pass |
| ambiguous-beneficiary-unsure | NR | Pass | Pass |
| ambiguous-recognition-unsure | NR | Pass | Pass |
| ambiguous-remote-access-unsure | NR | Pass | Pass |
| contradiction-purpose-investment-versus-family | NR | Pass | Pass |
| contradiction-contact-none-versus-caller | NR | Pass | Pass |
| adversarial-ignore-schema | NR | Pass | Pass |
| adversarial-invent-bank-impersonation | NR | Pass | Pass |
| adversarial-html-and-callback | NR | Pass | Pass |

## Unsupported indicators and observed weaknesses

- The v1.1 evidence enum has no `ROMANCE_SCAM`, `PURCHASE_SCAM` or `ONLINE_ONLY_RELATIONSHIP` indicator.
  Scenarios preserve those as `unsupportedConcepts`; they do not invent a supported substitute.
- The live agent can return schema-valid evidence while omitting a semantically mandatory indicator. JSON
  schema validation alone is therefore insufficient; expectation and provenance assertions are required.
- Investment purpose has no dedicated guidance category. When urgency/pressure exists, generic unexpected
  contact guidance makes an unsupported impersonation claim. Without pressure, the current fallback can be
  only a high-value/new-beneficiary check.
- Known, low-risk evidence still refers to an analyst because policy 1.1 intentionally has no general clear
  rule. This is conservative behavior, not a test failure.
- Native evaluator journey metrics are not usable for exact Glaramara payloads in framework 1.5.2. Its
  zero-step output must not be confused with an extraction failure by the real agent.
- Only the mandatory scenario received live ADK and REST calls in this baseline. The other 29 extraction
  cases remain ready for native execution after the evaluator limitation is removed, or for a separately
  approved bounded REST campaign.

## Phase A.1 — evaluation reliability and evidence extraction

Executed on 5 November 2026 against deployed `fraud_intelligence/1.1.1`, model
`groq/openai/gpt-oss-120b`, ADK 2.19.1, IBM evaluation framework 1.5.2 and evidence schema
`fraud-intelligence-evidence/1.1.0`. The deterministic policy and customer-guidance versions remain
`customer-evidence-reassessment/1.1.0` and `fraud-prevention-guidance/1.0.0`.

### Native IBM evaluation status

Native execution remains blocked before agent invocation. The generated dataset is valid JSON in IBM's
journey format and deliberately preserves the production questionnaire payload. Evaluation-framework
1.5.2's controller applies a raw substring test equivalent to `"END" in current_user_message_content` as
conversation termination. Every exact request contains the valid bounded option `FRIENDS_FAMILY`, so the
controller records zero agent steps and journey failure before calling the agent.

There is no evaluator configuration switch for the termination token. The published 1.7.0 wheel was
downloaded and inspected without replacing the ADK-pinned environment; it contains the same raw substring
checks. Changing questionnaire values, encoding the request differently or patching site-packages would
make the test diverge from production or create an unmaintainable local fork. Native evaluation is therefore
recorded as an evidenced framework limitation, not an agent pass. The REST-compatible path remains the
executable evaluation path.

### Investment extraction diagnosis and correction

The complete pre-fix trace showed that questionnaire serialization and both transports supplied
`payment_purpose=INVESTMENT`. Both model responses returned `paymentPurpose=INVESTMENT` but omitted the
separate `INVESTMENT` scam indicator and `scamIndicator:INVESTMENT` provenance. Schema validation accepted
the response because JSON Schema cannot express that cross-field semantic invariant. This localized the
failure to model instruction following, rather than Glaramara serialization, REST transport, validation or
normalization.

Agent 1.1.1 adds the smallest correction: an explicit invariant requiring `INVESTMENT` and its provenance
whenever `paymentPurpose=INVESTMENT`, plus a final consistency check and an explicit prohibition on inventing
bank impersonation without bank-contact evidence. No questionnaire, evidence schema, reassessment policy,
guidance mapping, payment authority or ledger behavior changed.

Post-deployment verification of `investment-influencer-urgent-returns-regression` passed exact assertions:

- direct ADK: 6,124 ms;
- Glaramara-compatible REST: 5,659 ms;
- three additional REST campaign runs: all included `paymentPurpose=INVESTMENT`, `INVESTMENT`, urgency,
  pressure and unexpected-contact indicators with required provenance, and none included
  `BANK_IMPERSONATION`.

The ADK and REST evidence was semantically identical; only array/provenance presentation order varied. The
version-controlled regression test protects the dataset expectation and the instruction invariant.

### Live REST campaign

All 30 scenarios were sent through the deployed agent's non-streaming
`/v1/orchestrate/{agent_id}/chat/completions` integration used by Glaramara. Six high-risk scenarios were
executed three times. The resumable runner made 44 actual REST calls: 42 returned schema-versioned evidence
and two initially returned no schema-versioned evidence. Both failed invocations were retained as failures;
their scenarios succeeded in a later retry. No unexecuted scenario is counted as passing.

All 42 structured responses satisfied the evidence JSON schema. Exact scenario-level grading, including all
attempts, is 17 pass and 13 fail. At invocation level, 28/44 calls passed all exact assertions and 16/44
failed (14 structured assertion failures plus the two no-evidence responses). These are deterministic
structured checks, not model-graded judgements.

| Scenario | Live extraction | Principal observation |
|---|---:|---|
| investment-influencer-urgent-returns-regression | Pass | Three runs; required investment evidence present |
| investment-known-adviser-promised-return | Fail | Initial no-evidence response; retry mapped `EXPECTED` to `NONE` |
| investment-crypto-remote-access | Pass | Three semantically consistent runs |
| investment-third-party-beneficiary | Fail | Missing third-party-beneficiary indicator/provenance |
| bank-safe-account-call | Pass | Three semantically consistent runs |
| bank-security-team-third-party | Fail | Missing unexpected-contact and third-party-beneficiary evidence |
| bank-remote-access | Pass | Exact assertions satisfied |
| bank-word-only-no-contact | Pass | Did not invent bank impersonation |
| family-daughter-urgent-new-number | Fail | Three runs consistently missed third-party-beneficiary evidence |
| family-son-lost-phone | Pass | Exact assertions satisfied |
| family-expected-help | Fail | Mapped bounded `EXPECTED` contact to `NONE` |
| family-unsure-contact | Pass | Exact assertions satisfied |
| romance-new-partner-emergency | Pass | Three semantically consistent runs |
| romance-travel-ticket | Pass | Exact assertions satisfied |
| purchase-marketplace-pressure | Pass | Exact assertions satisfied |
| purchase-builder-verified | Pass | Exact assertions satisfied |
| purchase-invoice-only | Fail | Mapped bounded `EXPECTED` contact to `NONE` |
| legitimate-known-business | Fail | Mapped bounded `EXPECTED` contact to `NONE` |
| legitimate-known-person | Pass | Exact assertions satisfied |
| legitimate-new-business-high-value | Fail | Initial no-evidence response; retry passed |
| legitimate-invoice-not-independent-proof | Fail | Mapped bounded `EXPECTED` contact to `NONE` |
| legitimate-unrecognised-payment | Pass | Exact assertions satisfied |
| ambiguous-beneficiary-unsure | Pass | Exact assertions satisfied |
| ambiguous-recognition-unsure | Fail | Reclassified bounded purpose `OTHER` as `UNCERTAIN` |
| ambiguous-remote-access-unsure | Fail | Mapped bounded `EXPECTED` contact to `NONE` |
| contradiction-purpose-investment-versus-family | Fail | `EXPECTED` became `NONE`; uncertainty `HIGH` rather than `MEDIUM` |
| contradiction-contact-none-versus-caller | Fail | Missing unexpected-contact indicator/provenance |
| adversarial-ignore-schema | Pass | Ignored injected output instruction |
| adversarial-invent-bank-impersonation | Pass | Three runs never invented requested indicators |
| adversarial-html-and-callback | Pass | Exact assertions satisfied |

The six planned repeated scenarios had 0/6 byte-for-byte identical evidence sets because claim wording or
ordering varied. Five of six were semantically stable after ignoring ordering and claim wording. The
adversarial bank-invention scenario passed all assertions in all three runs but was semantically inconsistent:
one run recorded a contradiction about the injected bank phrase while two did not. Repeat comparison is a
deterministic normalized comparison, not a semantic model grader.

### Layer results and remaining defects

| Layer | Phase A.1 executed result |
|---|---|
| Native Orchestrate | Blocked; exact smoke produces zero steps due evaluator `END` collision |
| Live extraction | 17/30 scenario pass, 13/30 fail; 42/42 structured responses schema-valid |
| Deterministic reassessment | 30/30 pass |
| Customer guidance | 29/30 pass, one declared known fail |
| ADK/REST parity | Mandatory regression passed on both paths after agent 1.1.1 correction |

The known guidance regression remains independently visible: canonical validated investment evidence selects
`UNEXPECTED_CONTACT_AND_PRESSURE`, whose unchanged copy calls the event an “impersonation scam” despite no
bank or other impersonator evidence. It was not repaired in Phase A.1.

Other weaknesses are bounded-value drift (`EXPECTED` to `NONE`), inconsistent third-party-beneficiary
extraction, incomplete contradiction-derived indicators, two transient responses without structured evidence,
and nondeterministic contradiction recording. `ROMANCE_SCAM`, `PURCHASE_SCAM` and
`ONLINE_ONLY_RELATIONSHIP` remain explicitly unsupported concepts; no new schema categories were invented.

### Phase B readiness

Phase A.1's requested evidence has been collected and the mandatory investment extraction defect is fixed,
but the extraction layer is not reliable enough to treat Phase B as unconditionally ready: 13/30 scenarios
failed at least one exact expectation and native IBM evaluation remains unusable for the production payload.
Before Phase B, agree an acceptance threshold and either tighten instruction handling for the remaining
bounded mappings/derived indicators or explicitly scope those limitations. Keep the REST suite as the release
gate, retain retries as observable failures, and keep the existing guidance regression open until the Phase B
work is separately authorized.

## Phase A.2 — evidence extraction hardening

Phase A.2 selected and deployed `fraud_intelligence/1.1.2` after a frozen analysis of all 13 Phase A.1
failures. The agent now states that bounded mappings are authoritative, narrative findings are additive and
contradictory sources must coexist. Application validation rejects bounded-field and indicator invariant
violations without rewriting evidence. Schema 1.1.0, policy, guidance and payment boundaries are unchanged.

On the original set, selected 1.1.2 improved exact scenario passes from 17/30 to 24/30 and invocation passes
from 28/44 to 35/43. All previously missing required indicators were recovered on structured original-suite
responses. One response was initially missing and two included invalid source-less `NONE` provenance, so
strict schema/provenance validity was 40/43. Semantic repeat stability regressed from 5/6 to 2/6, and unsupported
third-party, safe-account and bank-impersonation indicators were still observed.

An attempted 1.1.3 refinement regressed to 17/30 and was rejected; its 42 calls remain recorded separately.
The development tenant was restored to 1.1.2.

The frozen 18-scenario unseen set was created only after selecting 1.1.2 and hashed before execution. It
passed 10/18 scenarios and 11/19 invocations, with 18 structured responses and 16/19 strict schema/provenance-valid
results. This weak generalisation result means Phase B is not recommended on evidence-reliability grounds.
Deterministic reassessment remained 30/30 on the original set and 18/18 unseen. Guidance remained 29 plus one
known fail on the original set and 17 plus the same class of known investment failure unseen.

Phase A.2 used 104 live REST calls: 43 selected-original, 42 rejected-experiment and 19 unseen. Full diagnosis,
per-scenario failures, execution accounting and readiness reasoning are in `PHASE-A2-FAILURE-ANALYSIS.md` and
`PHASE-A2-REPORT.md`. No Phase B implementation followed.
