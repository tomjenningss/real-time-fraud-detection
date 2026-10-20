# real-time-fraud-detection

This repository contains two deliberately separated layers:

1. `confluent-flink/` produces canonical, real-time transaction evidence with Kafka and Flink.
2. `agents/` contains the deterministic payment router and four logical Claude investigation agents.
3. `fraud-decisioning/` defines the separate PostgreSQL service and Part 3 operational tooling.

```text
payments.raw.demo
       │
       ├── Flink SQL windows ─────────────────────> fraud.signals.demo
       │
       └── Flink DataStream keyed enrichment ─────> payments.enriched.demo
                                                          │ future integration
                                                          ▼
             Supervisor ──┬── Geo Agent ───── deterministic Haversine
                          └── Behaviour Agent ─ canonical Flink evidence
                                      │
                                      ▼
                               Action Agent
                                      │
                             deterministic policy
                                      │
                          three-field external verdict
```

The fast-path Python policy is the sole initial payment authority. Claude investigates, interprets and
orchestrates asynchronously; its deterministic Action policy produces a separate recommendation and
cannot overwrite the immutable payment decision.

See [the agent architecture](docs/architecture.md) and [the Flink documentation](confluent-flink/README.md) for detailed boundaries and operational instructions.
Part 3 setup, recovery guarantees and failure modes are documented in
[fraud-decisioning/README.md](fraud-decisioning/README.md).

## Repository security

The following local files are ignored and must never be staged or printed:

- `agents/.env`
- `anthropic-key.txt`
- `confluent-flink/.env`

`agents/.env.example` is the non-sensitive template. Do not paste API keys into prompts, source, fixtures, or command arguments.

## Agent setup

Python 3.11 or newer is supported.

```sh
cd agents
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
```

The existing `agents/.env` is loaded with `python-dotenv`. Dry-run remains the default and does not require an API key.

## Run one dry investigation

The CLI reads one stored JSON event. It is intentionally not connected to live Kafka.

```sh
cd agents
.venv/bin/fraud-investigate \
  --input fixtures/normal.json \
  --mode dry-run
```

Standard output contains exactly the external contract:

```json
{"transaction_id":"fixture-normal-001","verdict":"APPROVED","reason":"No qualifying deterministic fraud rule was triggered."}
```

Audit location and zero-cost usage are written separately to standard error. Audit files default to `agents/audit_records/`, are mode `600`, and are ignored by Git.

## Tests

```sh
cd agents
.venv/bin/ruff check .
.venv/bin/pytest -q
```

The offline suite covers normal shopping, velocity, merchant hopping, combined risk, geographic anomalies, missing GPS, e-commerce, missing history, duplicates, conflicting evidence, timeouts, prompt injection, malformed arguments, higher-value normal activity, cost limits, audit permissions, and attempted verdict override.

## Live mode

Live mode uses the official Anthropic Python SDK and real client-side tool-use loops. It requires both an explicit mode and acknowledgement flag:

```sh
cd agents
.venv/bin/fraud-investigate \
  --input fixtures/normal.json \
  --mode live \
  --approve-live
```

Do not run this command until paid testing is explicitly approved. A single invocation processes one event. `MAX_INVESTIGATION_COST_USD` is checked before each call using configured pricing metadata, but it is an estimate rather than a provider billing cap.

The configured model IDs and base pricing metadata were checked against the [Anthropic model overview](https://platform.claude.com/docs/en/models/overview) on 19 October 2026. Pricing metadata must be reviewed when model pricing changes.

## Infrastructure safety

Agent development and dry-run tests do not start, stop, rebuild, or consume from the Kafka/Flink deployment. Never run `podman compose down -v`; Kafka data is persistent project state.
