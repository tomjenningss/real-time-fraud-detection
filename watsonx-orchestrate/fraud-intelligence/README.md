# Fraud Intelligence

Canonical watsonx Orchestrate source for the single Phase C agent. Agent version 1.1.2 preserves bounded
questionnaire mappings, additive contradiction evidence and supported indicator provenance. The agent has no tools, collaborators,
knowledge bases or localhost dependencies. It receives one backend-created minimal JSON context and returns
only `fraud-intelligence-evidence/1.1.0`; payment outcomes remain deterministic application policy.
Every semantic finding cites an exact excerpt from a supplied answer, which the application validates before
policy evaluation.

`agent.yaml` records the measured/default model choice. To test another tenant model, copy the file to an
ignored temporary path and change only `llm`; do not edit another tenant agent. Validate the spec locally:

```sh
../.venv/bin/python -c "from ibm_watsonx_orchestrate.agent_builder.agents import Agent; Agent.from_spec('agent.yaml')"
```

After local tests, import only this definition into the designated development tenant:

```sh
../.venv/bin/orchestrate agents import --file agent.yaml --safe
```

The backend adapter reads JSON from stdin and emits JSON without copying authenticated ADK configuration:

```sh
../.venv/bin/python run_agent.py < minimal-context.json
```

The TechZone development tenant selects `bedrock-mantle/google.gemma-4-31b`, promoted on 6 November 2026
after the frozen independent benchmark and a 6/6 live REST acceptance. The previous rollback model is
`groq/openai/gpt-oss-120b`; see
[`evaluation/GEMMA-PROMOTION-2026-11-06.md`](evaluation/GEMMA-PROMOTION-2026-11-06.md).
`evaluate_live.py` uses the same REST chat-completions transport as Glaramara, checks
exact-excerpt provenance and evaluates returned evidence with the canonical JavaScript policy; ADK-only or
mock runs are not counted as production-path proof. Re-run it after any model or instruction change.
ADK 2.19.1 warns that planner style is deprecated; it remains intentional because this version exposes
structured output through planner. AskOrchestrate is outside this directory and must not be imported or edited.

## Evaluation baseline

The version-controlled Phase A evaluation framework is under [`evaluation/`](evaluation/README.md). Its 30
synthetic scenarios separately grade extraction, deterministic policy and persisted guidance. The 5 November
2026 baseline records 30/30 policy passes, 29/30 guidance passes with one known failing investment-guidance
regression, and a bounded ADK/REST parity extraction failure caused by an omitted `INVESTMENT` indicator.
Phase A.1 deployed the instruction-only 1.1.1 correction and verified that regression on both transports and
three further REST runs. The complete live REST campaign produced structured evidence for all 30 scenarios:
17 met every exact evidence/provenance assertion and 13 exposed remaining extraction reliability issues.
Phase A.2 selected agent 1.1.2 after frozen failure analysis. It improved the original set to 24/30, but a
frozen 18-case unseen set passed only 10/18 and repeat consistency regressed; the system is therefore not
recommended for Phase B evidence reliance. Application validation now rejects bounded mapping and indicator
invariant violations rather than silently normalising them.
Native IBM journey evaluation was also exercised, but framework 1.5.2 terminates exact Glaramara requests on
the `END` substring in `FRIENDS_FAMILY`; the published 1.7.0 wheel retains the same check. Its zero-step
result is reported as unsupported, never as passing. See the baseline for actual calls, retries and failures.
