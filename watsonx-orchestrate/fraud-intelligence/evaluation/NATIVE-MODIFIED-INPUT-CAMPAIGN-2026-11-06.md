# Native Orchestrate modified-input campaign — 6 November 2026

## Scope and result

This is a **modified-input native evaluation subset**, not a direct reproduction of the frozen 50-case
benchmark. The original scenarios, requests and ground truth remain unchanged and hash-identical.

The converter removed only `FRIENDS_FAMILY` from the `payment_purpose` question options in generated copies.
It excluded the 13 cases whose selected answer was `FRIENDS_FAMILY`, without remapping their answers. The
remaining 37 serialized native cases contained no case-sensitive `END` substring and validated against
evaluation-framework 1.5.2's `TestCase` model.

All three isolated agents copied `fraud_intelligence/1.1.2`; only name, display name and `llm` differed. The
production agent was unchanged. The temporary agents were removed after execution and a tenant inventory
confirmed only the pre-existing agents remained.

## Three-case proof

The Groq proof used `legitimate-builder-stage-payment`, `ambiguous-beneficiary-trading-name`, and
`investment-crypto-liquidity-release`. All three invoked the intended temporary agent, returned structured
evidence, and recorded 2 total steps including 1 LLM step. Latencies were 5.735–7.656 seconds in the first
run. The first CLI attempt failed before invocation because its input directory also contained the conversion
manifest; rerunning with explicit case files succeeded. Scenario-specific dataset names were then added so
the evaluator retained each raw response rather than overwriting same-named artifacts.

## Campaign comparison

| Model | Tenant identifier | Calls / LLM steps | Schema valid | Strict fraud harness | Native journey success | Mean / median / p95 latency |
|---|---|---:|---:|---:|---:|---:|
| Gemma 4 31B | `bedrock-mantle/google.gemma-4-31b` | 37 / 37 | 37/37 | **32/37** | 31/37 | 7.325 / 7.170 / 9.891 s |
| Frontier alias | `watsonx-orchestrate/frontier` | 37 / 37 | 37/37 | 26/37 | 24/37 | 7.275 / 7.048 / 9.480 s |
| Groq GPT-OSS-120B | `groq/openai/gpt-oss-120b` | 37 / 37 | 37/37 | 22/37 | 22/37 | **5.650 / 5.449 / 6.889 s** |

Every invocation recorded 2 total steps and 1 LLM step: 74/37 per model. The current tenant listed Gemma and
Groq as supported/preferred. Frontier remained hidden as an alias; prior tenant evidence showed it resolving
to `bedrock/us.anthropic.claude-sonnet-4-6`, so it is not reported as a distinct underlying model.

Gemma's five strict failures were `app-builder-invoice-redirection`, `app-supplier-factoring-verified`,
`ambiguous-recognition-changing`, `ambiguous-beneficiary-trading-name`, and
`ambiguous-expected-contact-cold-call`. Frontier failed 11 and Groq failed 15; per-case differences are in
`results/native-modified-20261106/campaign/comparison-summary.json`.

## Native versus independent scoring

The native framework primarily applies keyword, semantic and full-text goal matching. Its strict journey
score is not the fraud contract scorer. Gemma had 31 native successes versus 32 fraud-harness passes; Groq
was 22 versus 22; Frontier was 24 versus 26. Individual classifications still disagreed: for example,
Frontier's `investment-crypto-screen-help` passed native matching while failing the required indicator check.

On the same 37 IDs, the historical independent campaign passed Gemma 33/37 and Groq 17/37. Current native-run
strict results agreed with those historical pass/fail classifications on 36/37 Gemma cases and 24/37 Groq
cases. These are executions at different times and the input option list was modified, so disagreement is not
attributed solely to the model. The independent fraud harness remains authoritative for bounded-value
preservation, indicators, provenance, contradictions and safety.

## Persistence, identifiers and UI visibility

The CLI persisted per-scenario messages, metrics, summary CSV, average metrics and configuration under
`results/native-modified-20261106/`. It logged evaluation/experiment identifiers during execution, but the
persisted message records contain null `trace_id` and `run_id`. Disk persistence was the only reported
exporter; `--with-langfuse` was not used.

Direct UI verification was attempted after the runs. The available browser inventory failed with “browser
access host is unavailable”, and macOS denied Chrome control because Computer Use permissions were not
granted. Therefore appearance under **Evaluate → Evaluations**, Control Plane **Quality**, and **Agents
evaluated** is **not visually confirmed**. The disk-only exporter and null persisted IDs provide no positive
evidence that these CLI runs populated those SaaS views. This is a local UI-access limitation, not a claim
that the tenant dashboards are empty.

## Reproduce

Generate a model-specific modified copy with:

```sh
node watsonx-orchestrate/fraud-intelligence/evaluation/convert_independent_50_to_native.mjs \
  --output /tmp/glaramara-native-modified \
  --case-directory cases \
  --remove-question-option FRIENDS_FAMILY \
  --exclude-selected-payment-purpose FRIENDS_FAMILY \
  --exclude-substring END \
  --agent temporary_evaluation_agent
```

Pass only the `cases/` directory to `orchestrate evaluations evaluate`; the parent conversion manifest is not
a native `TestCase`.
