# Native-compatible subset investigation — 6 November 2026

## Outcome

The compatible subset is empty: **0 included, 50 excluded**. No native agent or model invocation was made.
This is the required stop condition before the three-case proof, not a zero-step evaluation result.

The evaluator's suspected terminator is a case-sensitive substring match for `END`. Thirteen frozen scenarios
select `FRIENDS_FAMILY` as their `payment_purpose` answer:

`family-ai-voice-grandson-bail`, `family-daughter-hospital-new-number`,
`family-brother-voice-usual-number`, `family-nephew-landlord-account`,
`family-mum-stranded-airport`, `family-son-voice-uncertain`,
`family-cousin-planned-medical-help`, `family-police-officer-relative`,
`family-friend-emergency-email`, `legitimate-family-house-deposit-gift`,
`legitimate-sibling-loan-repayment`, `ambiguous-purpose-family-versus-investment`, and
`ambiguous-family-voice-known-number`.

Excluding only those answers is insufficient. Every one of the 50 preserved structured requests includes the
complete `payment_purpose` question definition, whose allowed options include `FRIENDS_FAMILY`. The literal
`END` therefore occurs in every complete generated native input. Rewriting or removing the option would
violate the request-preservation and frozen-dataset constraints.

The complete per-scenario exclusion list, selected answer, occurrence count, and source hashes are in
[`native-compatible-independent-50/conversion-manifest.json`](native-compatible-independent-50/conversion-manifest.json).

## Reproduce

```sh
node watsonx-orchestrate/fraud-intelligence/evaluation/convert_independent_50_to_native.mjs \
  --output watsonx-orchestrate/fraud-intelligence/evaluation/native-compatible-independent-50 \
  --exclude-substring END
node --test watsonx-orchestrate/fraud-intelligence/evaluation/evaluation-assets.test.mjs
```

The scan is case-sensitive and covers the complete serialized native test case: request story, starting
sentence, expected structured response, keywords and metadata. The converter does not write a case file for
an excluded scenario.

## Consequences

- No legitimate, ambiguous-beneficiary and suspected-fraud proof trio exists under the stated constraints.
- No genuine steps, structured responses, native metrics, latency, trace IDs or run IDs were produced.
- Candidate-model availability was not relevant and no model campaign was attempted.
- There is nothing new to inspect in Evaluate or Control Plane Quality; UI population remains unconfirmed.
- Independent frozen results remain authoritative and no native/independent score comparison is possible.

The next supported path requires an IBM evaluator fix or documented termination configuration. A transformed
request would be a different evaluation input and must not be presented as evaluation of the frozen contract.
