# Gemma 4 31B production-agent promotion — 6 November 2026

## Outcome

The existing TechZone `fraud_intelligence` agent now uses
`bedrock-mantle/google.gemma-4-31b`. Its identity and REST endpoint are unchanged:
agent ID `f7859afd-0e8d-488e-88c3-64b591330524`, contract version 1.1.2.

The previous model was `groq/openai/gpt-oss-120b`. The tenant listed the exact benchmarked Gemma identifier as
supported and preferred immediately before promotion. It is the same identifier used for the independent
50-case campaign (44/50 primary strict, 62/70 invocation strict, 70/70 bounded-field preservation and 10/10
semantic repeat consistency). No alternative Gemma identifier was substituted. The CLI did not expose
numeric tenant invocation or rate limits; entitlement was demonstrated by listing, successful agent import,
and six successful live calls.

## Controlled change and rollback

The live agent was exported before the change. A semantic comparison of the pre- and post-change exports
confirmed that identity, display name, description, planner style, instructions and structured-output schema
are equal; `llm` is the only changed top-level field.

Rollback artifact:
`results/gemma-promotion-20261106/pre-change/fraud-intelligence-groq.yaml`.

Rollback command:

```sh
watsonx-orchestrate/.venv/bin/orchestrate agents import \
  --file watsonx-orchestrate/fraud-intelligence/evaluation/results/gemma-promotion-20261106/pre-change/fraud-intelligence-groq.yaml
```

After rollback, export/list the agent and rerun the six-case acceptance suite with model
`groq/openai/gpt-oss-120b`. Rollback was verified as possible from the captured importable definition but was
not exercised because no critical acceptance failure occurred.

## Post-promotion REST acceptance

Six unchanged scenarios were selected from the frozen independent dataset and invoked through the same
non-streaming `/v1/orchestrate/{agent-id}/chat/completions` path used by Glaramara:

| Scenario | Coverage | Extraction | Reassessment | Guidance | Latency |
|---|---|---:|---:|---:|---:|
| `legitimate-builder-stage-payment` | legitimate payment | pass | pass | pass | 7,640 ms |
| `investment-crypto-liquidity-release` | investment scam | pass | pass | pass | 10,815 ms |
| `family-ai-voice-grandson-bail` | family/AI-voice impersonation | pass | pass | pass | 9,328 ms |
| `ambiguous-beneficiary-trading-name` | beneficiary mismatch | pass | pass | pass | 5,927 ms |
| `legitimate-high-value-kitchen` | high-value new beneficiary | pass | pass | pass | 7,984 ms |
| `ambiguous-remote-access-unsure` | uncertainty/remote access | pass | pass | pass | 4,300 ms |

Observed mean latency was 7,666 ms; median was 7,640 ms and observed p95/max was 10,815 ms. All 6/6 calls
returned the exact top-level structured contract, schema-valid evidence, grounded excerpts, expected bounded
fields/indicators/uncertainty, no unsupported verification claims, the expected deterministic simulated
reassessment, and acceptable deterministic customer guidance. There were no API failures.

The acceptance subset and outputs are separate from the historical benchmark:
`results/gemma-promotion-20261106/acceptance-suite.json`, `live-rest/`, and
`acceptance-summary.json`.

## Payment and ledger safety

The acceptance runner sends synthetic, pseudonymous requests directly to IAM and the existing Orchestrate
REST endpoint. It has no PostgreSQL, Kafka, payment-decision, account or ledger client. Therefore these calls
cannot update the immutable deterministic payment verdict or create ledger effects. No banking UI,
questionnaire, deterministic policy, Kafka/Flink/Go service, LightGBM scorer or shadow policy changed.

## Remaining limitations

- Provider generation settings remain tenant defaults.
- The tenant CLI exposes availability but not numeric rate/invocation limits or a cost entitlement report.
- Planner style remains intentionally unchanged despite the ADK deprecation warning.
- The six acceptance calls are focused release evidence, not a replacement for the frozen 50-case benchmark.
- Native Orchestrate evaluation/UI visibility remains a separate concern and was not a promotion gate.
