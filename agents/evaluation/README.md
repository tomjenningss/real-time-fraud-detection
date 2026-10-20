# Fraud-agent evaluation harness

This harness evaluates the existing four-agent application; it does not introduce a second
orchestration framework. The local JSON report is authoritative. Phoenix is an optional viewer and
experiment index, not the source of truth.

## Dataset

`datasets/fraud-investigations-v1/inputs.json` contains 30 synthetic inputs. Ground truth lives in the
separate `ground_truth.json` file and is joined only after an investigation completes. The runner's
`agent_inputs()` method intentionally cannot expose acceptable outcomes, prohibited outcomes, expected
rules, or rationales to an agent.

The dataset covers legitimate and suspicious velocity, merchant diversity, reliable and unavailable
geography, incomplete and contradictory history, conflicting signals, duplicate and late events,
metadata prompt injection, and insufficient evidence. Version `fraud-investigations/1.0.0` is immutable;
material case changes require a new dataset directory and version.

## Offline baseline

From `agents/`:

```sh
.venv/bin/python scripts/run_evaluation.py \
  --output evaluation/reports/offline-baseline-v1.json \
  --markdown evaluation/reports/offline-baseline-v1.md
```

This mode runs the live-shaped `Supervisor` tool loop with an SDK-compatible deterministic fake client,
the existing tools, an in-memory cost controller, and no Kafka, PostgreSQL, or external API. Reported
tokens and costs are simulated efficiency estimates; incurred API cost is zero. The checked-in baseline
reports 27/30 passing cases. That baseline explicitly captured three gaps: absent, `UNKNOWN`, and
`CONFLICTING` historical evidence did not propagate to the Behaviour assessment's top-level status, so
policy 1.0.0 approved them instead of taking the authored fail-safe outcome. This is a measurement, not
a claim of production accuracy.

The preserved failure analysis and separate post-fix comparison are documented in
[`history-status-analysis.md`](history-status-analysis.md). The original dataset and baseline reports
remain unchanged.

## Recorded-response replay

Replay fixtures are JSON with an explicit sanitisation marker:

```json
{
  "sanitised": true,
  "responses": [
    {"case_id": "eval-v1-low-risk-complete", "result": {"recommendation": {}, "audit": {}}}
  ]
}
```

The `result` must be a valid existing `InvestigationResult`. Do not store prompts, completions, API
keys, customer data, or raw provider payloads. Run it with:

```sh
.venv/bin/python scripts/run_evaluation.py --mode replay \
  --replay-fixture evaluation/fixtures/sanitised-responses.json \
  --experiment-id part4b-replay-v1
```

Replay results are labelled `recorded-response-replay`; they are not fresh model evaluations.

## Phoenix publication

Install the optional client only when Phoenix publication is required:

```sh
.venv/bin/python -m pip install -e '.[evaluation]'
.venv/bin/python scripts/run_evaluation.py --publish-phoenix
```

The publisher creates a version-labelled dataset and an experiment containing case outputs, grader
results, scenario and investigation IDs, model configuration, latency, tokens, calls, and cost. Live
traces also carry dataset version, scenario ID and experiment ID and report their trace ID. A Phoenix
error is appended to the durable local report and does not invalidate or delete local results.

## Later Opus-versus-Sonnet comparison

Live comparison is deliberately unavailable from the CLI. It requires a reviewed driver to construct
`EvaluationRunner(mode=EvaluationMode.LIVE, live_authorized=True, ...)` and supply a
`live_supervisor_factory`. That factory must prepare a normal durable investigation attempt and return
the existing `Supervisor` with `DurableCostController`; bypassing PostgreSQL is rejected by
`Supervisor`.

Before approving a live comparison:

1. Choose a new experiment ID for each configuration. Put all earlier experiment IDs in
   `protected_experiment_ids`; the runner refuses to reuse them.
2. Create two `Settings` values that differ only in `supervisor_model`: `claude-opus-5-5` versus
   `claude-sonnet-5-5`. Keep Behaviour on `claude-sonnet-5-5`, Geo and Action on
   `claude-haiku-5-5`, and keep prompts, tools, cases and output limits fixed.
3. Set `LIVE_EXPERIMENT_ID` to the new ID. Do not edit a durable experiment's allocation limits;
   `configure_live_experiment` rejects configuration drift.
4. Obtain explicit approval for case count, repetitions and budget. Set the PostgreSQL experiment's
   baseline spend, investigation count, per-investigation reserve and per-call maximum before any call.
5. Run sequentially, stop on an ambiguous call or incomplete trace, and never retry a paid call merely
   because Phoenix export failed.
6. Compare per-case paired outcomes, grader scores, calls, latency, tokens and estimated cost. Do not
   claim statistical significance from this small synthetic dataset.

No live run is possible without both explicit `live_authorized=True` and a durable factory. The runner
also requires its experiment ID to match the PostgreSQL budget configuration.

## Graders and interpretation

The deterministic graders cover expected evidence interpretation, uncertainty, prohibited claims,
required tools, policy constraints, original-verdict immutability, structured output and contradictory
evidence. Hard failures identify authority, tool, structure, unsupported-claim or fail-safe violations;
factual agreement is retained as a softer quality metric. Agreement with action policy measures policy
compliance only—not whether the system independently detects real fraud accurately.

Known limitations include synthetic authoring bias, a small sample, no statistical power, no
model-quality measurement in offline mode, and incomplete representation of transport-level duplicate
handling. A controlled live comparison additionally requires approval for paid Anthropic calls and
PostgreSQL writes; Phoenix publication requires approval to create dataset and experiment records.
