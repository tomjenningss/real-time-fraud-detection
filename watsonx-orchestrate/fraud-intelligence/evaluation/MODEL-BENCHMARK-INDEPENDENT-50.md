# Glaramara independent 50-scenario model benchmark — 5 November 2026

## Recommendation

**Switch Glaramara to Gemma 4, subject to the normal separate change approval and an availability/cost/SLO
check.** This evaluation did not change the live agent. Gemma's earlier advantage was reproduced on 50 new
cases: it achieved 44/50 primary exact matches versus 24/50 for the current Groq GPT-OSS-120B baseline.
Gemma also preserved bounded questionnaire values on every invocation and was semantically stable on all ten
repeated cases. Groq was faster, but its accuracy, caution and repeatability deficits are too large to offset
the latency advantage.

## Method

The campaign used 50 newly written synthetic UK banking cases: ten investment, ten impersonation/family
emergency, ten APP fraud, ten legitimate and ten ambiguous/contradictory. The closest old/new narrative
token-set similarity was 0.462; no old fixture was copied or edited. Customer and payment details are wholly
synthetic.

Before either model was invoked, `scenarios.json` and `ground-truth.json` were generated, frozen and SHA-256
hashed in `frozen-manifest.json`. All 50 canonical evidence objects use only the existing
`fraud-intelligence-evidence/1.1.0` fields and enums. The unchanged JavaScript policy and guidance renderer
validated 50/50 fixtures. No case was excluded from exact-match scoring.

Two temporary agents copied `fraud_intelligence/1.1.2` exactly and changed only name/display name and `llm`:
`bedrock-mantle/google.gemma-4-31b` and `groq/openai/gpt-oss-120b`. Each received the same REST
chat-completions payloads and provider-default generation settings. There were 50 primary calls plus two
additional calls for each of ten representative cases (70 calls/model). No previous response was reused,
and API failures would have counted as failures. Both temporary agents were removed after execution.

“Primary exact” grades run 1 of each new case. The existing strict suite result is more conservative for a
repeated scenario: all three runs must pass (Gemma 44/50, Groq 22/50). Indicator metrics and downstream
metrics include all 70 calls. “Semantic repeat consistency” ignores harmless provenance claim wording and
array ordering but retains evidence values, indicators, contradictions and uncertainty.

## Results

| Measure | Gemma 4 31B | Groq GPT-OSS-120B |
|---|---:|---:|
| Primary exact evidence | **44/50 (88%)** | 24/50 (48%) |
| All-invocation exact evidence | **62/70 (88.6%)** | 33/70 (47.1%) |
| Indicator precision / recall | **96.1% / 96.8%** | 94.4% / 92.9% |
| Questionnaire core-field preservation | **70/70** | 55/70 |
| Contradiction detection | **68/70** | 64/70 |
| Uncertainty classification | **70/70** | 66/70 |
| Canonical reassessment outcome and rule | **70/70** | 66/70 |
| Acceptable deterministic guidance | **70/70** | 65/70 |
| Unsupported verification claims | 0 | 0 |
| False-positive indicators | **5** | 7 |
| Schema-valid responses / API failures | 70/70 / 0 | 70/70 / 0 |
| Semantic repeat consistency | **10/10** | 5/10 |
| Ambiguous-case exact/cautious result | **7/10** | 3/10 |
| Mean / median / p95 latency | 6,547 / 6,549 / 7,986 ms | **4,937 / 4,945 / 6,431 ms** |

Gemma's errors were mostly narrow interpretation errors: it missed two required contradictions, mishandled
the family-versus-investment narrative, and disagreed on invoice/third-party evidence in two APP cases. It
never changed a bounded questionnaire mapping, invented no verification claim, produced the correct
deterministic reassessment on every call and did not treat suspected AI voice generation as verified.

Groq's main failure mode was structured-value preservation, not merely scam interpretation. It changed one
or more bounded core fields on 15/70 calls, particularly `EXPECTED` influence and known relationships. It
also missed third-party, urgency or invoice evidence, and failed to express required caution in several
contradictory cases. Those evidence changes propagated to four wrong reassessments and five wrong guidance
results. Neither model invented a verification claim; unsupported evidence appeared as false-positive
indicators or provenance/value errors.

## Paired comparison and individual failure analysis

Both models passed 23 cases:

`investment-whatsapp-copy-trading`, `investment-crypto-screen-help`,
`investment-crypto-recovery-fee`, `investment-app-manipulated-return`,
`family-ai-voice-grandson-bail`, `family-brother-voice-usual-number`,
`family-nephew-landlord-account`, `family-dad-care-home-verified`, `app-safe-account-sort-code`,
`app-police-secure-wallet`, `app-marketplace-concert-tickets`, `app-holiday-let-pressure`,
`app-bank-remote-safe-account`, `legitimate-builder-stage-payment`,
`legitimate-family-house-deposit-gift`, `legitimate-wedding-photographer`,
`legitimate-car-showroom-balance`, `legitimate-sibling-loan-repayment`,
`legitimate-roofing-final-invoice`, `legitimate-high-value-kitchen`,
`ambiguous-remote-access-unsure`, `ambiguous-safe-word-not-instruction`, and
`ambiguous-invoice-edited-details`.

Only Gemma passed 21 cases:

- Investment: `investment-crypto-liquidity-release`, `investment-broker-tax-before-withdrawal`,
  `investment-fake-broker-insurance`, `investment-property-bond-deadline`,
  `investment-known-adviser-new-fund`, and `investment-pension-cold-call`. Groq omitted required indicators
  or provenance and, in three cases, changed a bounded core value.
- Family: `family-daughter-hospital-new-number`, `family-mum-stranded-airport`,
  `family-cousin-planned-medical-help`, `family-police-officer-relative`, and
  `family-friend-emergency-email`. Groq alternated between missed indicators and changing expected/known
  bounded values.
- APP: `app-solicitor-client-account-change`, `app-car-deposit-third-party`, and
  `app-puppy-courier-account`. Groq missed urgency/third-party evidence or changed expected contact.
- Legitimate: `legitimate-school-fees`, `legitimate-auction-house-purchase`, and
  `legitimate-private-tutor`. Groq changed bounded relationship/influence values despite the explicit facts.
- Ambiguous: `ambiguous-contact-none-versus-caller`, `ambiguous-beneficiary-trading-name`,
  `ambiguous-pressure-denied-urgent`, and `ambiguous-family-voice-known-number`. Groq missed contradictions,
  lowered uncertainty or changed bounded values rather than retaining competing facts.

Only Groq passed `family-son-voice-uncertain`; Gemma added an unsupported urgency indicator.

Both models failed five cases:

- `app-builder-invoice-redirection`: both added or omitted indicator/verification evidence; Gemma's error was
  identical on all repeats.
- `app-supplier-factoring-verified`: both mishandled the explicitly verified third-party beneficiary;
  Groq also changed a bounded core value.
- `ambiguous-purpose-family-versus-investment`: Gemma added the narrative investment indicator while the
  frozen label retained the bounded family purpose; Groq overwrote the bounded purpose.
- `ambiguous-recognition-changing`: both missed the required contradiction.
- `ambiguous-expected-contact-cold-call`: both missed the bounded-answer/narrative contradiction.

The detailed machine-readable differences for every failed invocation and the complete paired lists are in
`model-benchmark-independent-50/comparison-summary.json`; raw request hashes, evidence and REST responses are
under `model-benchmark-independent-50/raw/`.

## Repeatability

Gemma was semantically identical on all ten three-run subsets. Eight scenarios passed on all three runs;
`app-builder-invoice-redirection` failed consistently. Groq was semantically stable on five of ten. Its
pass/fail result changed across repeats for `investment-crypto-liquidity-release`,
`family-brother-voice-usual-number`, and `legitimate-builder-stage-payment`; two other cases varied
semantically while remaining failures. This reproduces the prior campaign's 6/6 Gemma versus 3/6 Groq
semantic-consistency direction on a larger repeat sample.

## Comparison with the first benchmark

| Campaign | Gemma | Groq baseline |
|---|---:|---:|
| Original 30 | 28/30 (93.3%) | 21/30 (70.0%) |
| First held-out 18 | 16/18 (88.9%) | 16/18 (88.9%) |
| Independent new 50 | **44/50 (88.0%)** | **24/50 (48.0%)** |

Gemma reproduced its previous performance almost exactly on genuinely new cases. Groq did not: the new
campaign is materially lower than both its original and held-out scores. These are not identical samples;
the independent suite intentionally contains more third-party-beneficiary, fine-grained verification and
contradiction traps, which exposed Groq's `EXPECTED`/`NONE` and relationship mapping instability. Provider
defaults remain uncontrolled, and the campaigns were executed at different times, so service/model-side
changes and stochastic variation are also possible causes. The consistent repeat instability and the
specific bounded-value errors make case composition and model behaviour more plausible explanations than
API reliability: both models returned 70/70 schema-bearing responses with no transport failure.

Gemma is about 1.61 seconds slower at the mean (33%) and model entitlement, cost and production availability
were not established by this accuracy campaign. Those checks should gate a separately approved switch, but
the evidence no longer supports retaining Groq on quality grounds or extending the same accuracy evaluation.
