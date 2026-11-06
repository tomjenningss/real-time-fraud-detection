# Native watsonx Orchestrate evaluation feasibility — 6 November 2026

## Decision

Stage A establishes a useful conversion path but **does not establish a reliable native evaluation
integration for Glaramara**. Do not start Stage B or describe the independent 50-case results as native
Orchestrate evaluations.

The 6 November compatible-subset follow-up confirmed that this blocks all 50 cases, not only the 13 whose
selected answer is `FRIENDS_FAMILY`: every exact request carries that value in the preserved questionnaire
options. The complete-input `END` scan therefore produced 0 included and 50 excluded cases. See
[`NATIVE-COMPATIBLE-SUBSET-2026-11-06.md`](NATIVE-COMPATIBLE-SUBSET-2026-11-06.md).

The installed ADK can bulk-read journey JSON files, invoke a named tenant agent, calculate built-in journey
metrics and write local artifacts. Glaramara's exact request cannot currently reach the agent:
evaluation-framework 1.5.2 treats the `END` substring inside the valid `FRIENDS_FAMILY` option as an
end-of-conversation marker. The existing tenant reproduction ended with zero agent steps. Published framework
1.7.0 retained the same check when inspected on 5 November. Changing the frozen value is not an acceptable
workaround.

## Confirmed capabilities and limits

The inspected environment has ADK 2.19.1 and evaluation-framework 1.5.2. The CLI exposes `evaluate`,
`record`, `generate`, `analyze`, `validate-native`, `quick-eval` and red-team commands. Supported bulk inputs
are journey JSON files/directories and, for `validate-native`, TSV rows containing input, expected output and
agent name. Existing frozen cases therefore do not need to be manually saved from conversations.

Journey JSON accepts the structured request only as text in `story`/`starting_sentence`. A text goal can hold
the expected JSON response and keywords. It has no typed fields for Glaramara's policy result, guidance
assertions, precision/recall, questionnaire preservation, prohibited claims or repeat consistency. Built-in
code includes journey success, response time, keyword/semantic/text matching and LLM-as-a-judge/rubric
metrics. `quick-eval` requires a tools path in this ADK and is not a replacement for the deterministic fraud
scorer. Python custom-evaluation extension points exist, but no supported CLI or tenant REST contract was
confirmed for registering Glaramara metrics in the SaaS evaluation product.

The run is associated with the case's agent name and active environment. Model, provider, agent version,
prompt hash and all generation settings are not immutable case fields, so Glaramara's manifest remains the
provenance authority.

## Conversion proof

`convert_independent_50_to_native.mjs` reads but never modifies the frozen assets. It verifies the SHA-256
values of `scenarios.json` and `ground-truth.json`, embeds each existing
`fraud-intelligence-request/1.0.0` file and canonical expected evidence, and writes policy, guidance, caution
and source hashes to `conversion-manifest.json`. Those manifest-only criteria remain independently scored.

The installed framework's Pydantic `TestCase` model validated three representative outputs:
`investment-crypto-liquidity-release`, `legitimate-builder-stage-payment`, and the ambiguous beneficiary case
`ambiguous-beneficiary-trading-name`.

```sh
node watsonx-orchestrate/fraud-intelligence/evaluation/convert_independent_50_to_native.mjs \
  --output /tmp/glaramara-native-poc \
  --id investment-crypto-liquidity-release \
  --id legitimate-builder-stage-payment \
  --id ambiguous-beneficiary-trading-name
node --test watsonx-orchestrate/fraud-intelligence/evaluation/evaluation-assets.test.mjs
```

Omit `--id` to convert all 50. Conversion is not execution.

## UI, Quality dashboard and history

No supported evidence was found that normal ADK result files populate SaaS **Evaluate → Evaluations** or the
Control Plane Quality dashboard. `evaluate` writes to `output_dir`; its only explicit remote persistence flag
is `--with-langfuse`, for a Langfuse-enabled server with separate credentials. That is not evidence of SaaS
Evaluate or Control Plane ingestion.

The active `glaramara-techzone` environment was visible on 6 November, but its saved token had expired. No new
tenant call or UI observation was made. Treat both UI destinations as **unconfirmed/not populated by this
work** until IBM documents an upload/run API and a fresh isolated run is correlated with a visible record.
No documented command or official REST operation was found for importing historical results as native runs.

## Models and comparison controls

| Candidate | Tenant identifier | Qualification |
|---|---|---|
| Gemma 4 31B | `bedrock-mantle/google.gemma-4-31b` | Bedrock Mantle tenant route |
| Groq GPT-OSS-120B | `groq/openai/gpt-oss-120b` | Groq route; current baseline |
| Frontier | `watsonx-orchestrate/frontier` | Alias observed resolving to Claude Sonnet 4.6; not a distinct model |

Model listing could not be refreshed because the token was expired. Before any future campaign, record the
fresh identifier/provider, resolution timestamp, temporary agent spec hash, instruction/schema versions and
supported generation parameters. Use isolated copies, change only identity and `llm`, and remove them after
the bounded run. Never edit the live agent. Provider-default sampling in the historical campaign means exact
generation-parameter parity was not proven; cost/token data was not reliable enough for comparison.

## Metric and governance boundary

Native metrics may supplement response time and broad judge measures after the parser defect is fixed. They
cannot replace strict evidence equality, schema/provenance validation, indicator precision/recall,
reassessment, guidance, prohibited-claim, consistency or failure accounting. Keep deterministic metrics
separate from LLM-as-a-judge scores. The independent harness remains authoritative, and its existing results
are historical benchmark evidence—not native evaluations. There is no score disagreement to report because
the native proof produced no agent response.

Stage B requires an IBM-supported version that invokes a temporary agent with the unchanged request, three
non-zero-step proof cases, refreshed model/lifecycle evidence, an explicit UI-visibility finding, and agreed
deterministic safety gates plus human review. Existing hashes, raw responses and summaries already provide the
audit trail; no new database or dashboard is warranted.

## Official references

- [IBM ADK repository and CLI](https://github.com/IBM/ibm-watsonx-orchestrate-adk)
- [IBM evaluation examples](https://github.com/IBM/ibm-watsonx-orchestrate-adk/tree/main/examples/evaluations)
- [IBM CPD evaluation example](https://github.com/IBM/ibm-watsonx-orchestrate-adk/blob/main/examples/evaluations/cpd/README.md)
- [IBM ADK documentation](https://developer.watson-orchestrate.ibm.com/)
