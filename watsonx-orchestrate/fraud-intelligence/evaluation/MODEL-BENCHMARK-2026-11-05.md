# Fraud Intelligence foundation-model benchmark — 5 November 2026

## Scope and method

The active ADK 2.19.1 environment was `glaramara-techzone`, Global workspace, at the Toronto
`https://api.ca-tor.watson-orchestrate.cloud.ibm...` endpoint. Tenant inspection was read-only:
premier models were disabled, the denylist was empty and no provider or model was enabled. GPT-5.4 was
excluded completely.

Each benchmark agent copied `fraud_intelligence/1.1.2` and changed only its unique evaluation name and
`llm`. Calls used Glaramara's non-streaming `/v1/orchestrate/{agent_id}/chat/completions` REST integration,
the unchanged 30 original and frozen 18 held-out synthetic scenarios, and identical six-scenario three-run
repeats. Orchestrate generation settings remained provider defaults (the agent exposes no temperature,
top-p, seed or token override), so provider-specific defaults are an unavoidable difference. Raw REST
responses, errors and strict grading are under `results/model-benchmark-20261105/`.

## Discovery and actual availability

| Model ID | Provider | Catalog/access status | Actual result |
|---|---|---|---|
| `watsonx-orchestrate/frontier` | Orchestrate alias | Hidden from both list commands; not denied; premier remained disabled | Direct validator 4/4; evaluation agent resolved to `bedrock/us.anthropic.claude-sonnet-4-6`; REST callable |
| `groq/openai/gpt-oss-120b` | Groq | Preferred; tenant default | Validator 4/4; strict REST schema compatible |
| `bedrock/us.anthropic.claude-sonnet-4-6` | AWS Bedrock | Preferred | Validator 4/4; strict REST schema compatible |
| `bedrock/openai.gpt-oss-120b-1:0` | AWS Bedrock | Preferred | Validator 4/4; strict REST schema compatible |
| `bedrock-mantle/google.gemma-4-31b` | Bedrock Mantle | Preferred | Validator 4/4; strict REST schema compatible |
| `watsonx/openai/gpt-oss-120b` | watsonx.ai | `--all` only | Validator 4/4; strict REST schema compatible but very slow |
| `watsonx/meta-llama/llama-3-3-70b-instruct` | watsonx.ai | `--all` only | Validator 4/4, but 0/42 REST evidence-schema responses; incompatible |
| `watsonx/meta-llama/llama-4-maverick-17b-128e-instruct-fp8` | watsonx.ai | `--all` only | Validator 4/4, but 0/42 REST evidence-schema responses; incompatible |
| `watsonx/mistral-large-2512` | watsonx.ai | `--all` only | Validator 4/4, but 0/42 REST evidence-schema responses; incompatible |
| `watsonx/mistralai/mistral-small-3-1-24b-instruct-2503` | watsonx.ai | `--all` only | Validator 4/4, but 0/42 REST evidence-schema responses; incompatible |
| `watsonx/ibm/granite-4-h-small` | watsonx.ai | `--all` only | Validator 2/4; structured/tool calls failed; excluded |
| `watsonx/mistralai/mistral-medium-2505` | watsonx.ai | `--all` only | Validator 3/4; streamed structured/tool call failed; excluded |
| `watsonx/ibm/granite-3-1-8b-base` | watsonx.ai | `--all` only, base/pre-training model | Not suitable for instruction extraction; excluded |

`watsonx/meta-llama/llama-4-maverick...` was callable but its generic validation took 88.3 seconds. The
catalog also advertised `watsonx/mistralai/mistral-small...` and the other `--all` entries, but generic ADK
callability did not imply compatibility with the planner agent's strict structured output.

## Regression comparison

Accuracy is strict scenario accuracy: every repeated run must pass. Indicator precision/recall is micro-
averaged over all 42 original invocations. Reassessment and guidance are graded from each model's observed
evidence, not the canonical fixture. Latency is original-suite mean/median. All six compatible variants had
100% schema-valid responses and zero transport timeouts.

| Model | Original exact | Held-out exact | Indicator P / R | Reassessment | Guidance | Repeat semantic | Mean / median latency |
|---|---:|---:|---:|---:|---:|---:|---:|
| Gemma 4 31B | **28/30** | **16/18** | **100.0% / 100.0%** | **41/42** | **38/42** | **6/6** | 6,679 / 6,655 ms |
| Bedrock GPT-OSS-120B | 25/30 | 14/18 | 94.0% / 97.5% | 38/42 | 35/42 | 3/6 | 7,391 / 7,510 ms |
| watsonx GPT-OSS-120B | 24/30 | 13/18 | 97.5% / 97.5% | 40/42 | 37/42 | 3/6 | 34,061 / 31,705 ms |
| Frontier alias | 23/30 | 14/18 | 98.8% / 100.0% | 28/42 | 24/42 | 2/6 | 6,309 / 6,406 ms |
| Claude Sonnet 4.6 | 23/30 | 16/18 | 98.8% / 100.0% | 26/42 | 22/42 | 4/6 | 6,317 / 6,243 ms |
| Groq GPT-OSS-120B baseline | 21/30 | 16/18 | 94.0% / 97.5% | 38/42 | 35/42 | 3/6 | **4,770 / 4,544 ms** |

Held-out indicator precision/recall was: Gemma 100.0%/97.1%, Frontier 97.1%/97.1%, Claude
97.2%/100.0%, Bedrock GPT-OSS 97.1%/97.1%, Groq GPT-OSS 94.4%/97.1%, and watsonx GPT-OSS
94.3%/94.3%. Held-out reassessment/guidance was 18/18 and 17/18 for Gemma, Groq and Bedrock GPT-OSS;
Frontier achieved 14/18 and 13/18. The known investment-guidance defect remains visible rather than being
relabelled.

## Error analysis

- **Questionnaire values:** Groq and both alternative GPT-OSS hosts repeatedly changed bounded `EXPECTED`
  contact to `NONE`; Frontier/Claude instead overrode required `LOW` uncertainty with `MEDIUM`. Gemma had no
  bounded-value mapping failure.
- **Investment and impersonation:** all compatible models retained investment evidence well. Groq missed a
  bank-impersonation case; Frontier missed held-out urgency; watsonx GPT-OSS missed held-out third-party
  beneficiary evidence.
- **Contradictions and third-party instructions:** Groq, Bedrock GPT-OSS and watsonx GPT-OSS missed
  unexpected-contact evidence in contradiction cases. Gemma retained all required original contradiction and
  third-party indicators.
- **Unsupported findings:** Groq and both non-Groq GPT-OSS variants hallucinated verification claims or
  indicators. The Groq baseline followed adversarial text into unsupported bank/safe-account findings in one
  repeat. Gemma added no false-positive indicator, but hallucinated a verification claim in one original and
  one held-out scenario.
- **Equivalent evidence:** Gemma was semantically stable on all 6 repeated scenarios and byte-for-byte stable
  on 4; Frontier was semantically stable on 2, Claude on 4 and each GPT-OSS host on 3. No model was
  byte-for-byte stable on all repeats because provenance wording/order varied.

## Finding and recommendation

Frontier does **not** materially outperform Groq GPT-OSS-120B. It improves original strict accuracy by two
scenarios and indicator precision, but falls from 16/18 to 14/18 held-out, from 38/42 to 28/42 reassessment,
from 35/42 to 24/42 guidance, and from 3/6 to 2/6 semantic repeat consistency; it is also about 32% slower.
It is a hidden alias currently resolving to Claude Sonnet 4.6, not a separately disclosed Frontier model.

Gemma 4 31B is the strongest measured candidate: best original accuracy, tied-best held-out accuracy,
perfect original indicator precision/recall, best downstream correctness and best repeat consistency, at
moderate latency. Nevertheless, do **not** change Glaramara's model yet. Its 16/18 held-out result still
missed urgency and invented a verification claim, and the benchmark used provider-default stochastic
generation. Run a second independent campaign and confirm service entitlement/cost and production SLOs
before an approved model change. The existing agent and application remain unchanged.
