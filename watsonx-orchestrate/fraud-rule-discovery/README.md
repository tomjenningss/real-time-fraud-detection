# Fraud Rule Discovery

Canonical Phase D watsonx Orchestrate source for the standalone `fraud_rule_discovery` agent. It receives
only a bounded discovery-partition report and returns `fraud-rule-proposal/1.0.0`. It has no database,
deployment, Kafka or banking-decision authority.

Validate and import only this agent into the designated development tenant:

```sh
../.venv/bin/python -c "from ibm_watsonx_orchestrate.agent_builder.agents import Agent; Agent.from_spec('agent.yaml')"
../.venv/bin/orchestrate agents import --file agent.yaml --safe
```

After import, configure the returned ID as `FRAUD_RULE_DISCOVERY_AGENT_ID`. The Glaramara server performs
local semantic validation and an independent held-out backtest; the agent never receives evaluation rows.
