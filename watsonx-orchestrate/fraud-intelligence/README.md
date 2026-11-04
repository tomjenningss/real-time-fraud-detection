# Fraud Intelligence

Canonical watsonx Orchestrate source for the single Phase C agent. The agent has no tools, collaborators,
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

The TechZone development tenant currently selects `groq/openai/gpt-oss-120b`. On 3 November 2026 the v1.1
builder, safe-account and ambiguous live REST evaluation passed 3/3 at 5,097 / 5,302 / 4,135 ms
(mean 4,845 ms). `evaluate_live.py` uses the same REST chat-completions transport as Glaramara, checks
exact-excerpt provenance and evaluates returned evidence with the canonical JavaScript policy; ADK-only or
mock runs are not counted as production-path proof. Re-run it after any model or instruction change.
ADK 2.19.1 warns that planner style is deprecated; it remains intentional because this version exposes
structured output through planner. AskOrchestrate is outside this directory and must not be imported or edited.
