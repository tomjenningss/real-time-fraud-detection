# Fraud Intelligence

Canonical watsonx Orchestrate source for the single Phase C agent. The agent has no tools, collaborators,
knowledge bases or localhost dependencies. It receives one backend-created minimal JSON context and returns
only `fraud-intelligence-evidence/1.0.0`; payment outcomes remain deterministic application policy.

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

The TechZone development tenant currently selects `groq/openai/gpt-oss-120b`. On 2 November 2026 the strict
three-scenario live evaluation passed 3/3 at 5,026 / 6,949 / 6,594 ms (mean 6,190 ms). A measured Mistral Small
candidate failed to return schema-versioned evidence and was rejected. Re-run `evaluate_live.py` after any
model or instruction change. ADK 2.19.1 warns that planner style is deprecated; it remains intentional here
because this version exposes structured output through planner. AskOrchestrate is outside this directory and
must not be imported or edited by this workflow.
