# Fraud Intelligence evaluation suite

This directory is the Phase A evaluation baseline, extended through Phase A.2 for the selected
`fraud_intelligence/1.1.2` agent,
`fraud-intelligence-evidence/1.1.0` contract, deterministic reassessment policy and customer-guidance
renderer. It does not modify any of them.

## Assets

- `scenarios.json` is the canonical 30-scenario dataset. Each scenario declares expected core evidence,
  verification claims, required and forbidden indicators, uncertainty, provenance, policy outcome/rule and
  guidance assertions. Unsupported concepts are explicit rather than mapped to invented indicators.
- `native-cases/` contains one IBM native journey-evaluation case per scenario.
- `generate_native_cases.mjs` deterministically regenerates those native cases.
- `run_suite.mjs` performs strict schema/provenance expectation grading, evaluates the canonical validated
  evidence fixture through the real JavaScript policy and guidance modules, and never invokes a provider.
- `run_live_parity.py` performs a bounded live comparison between the standalone ADK path and the same
  non-streaming REST chat-completions transport used by Glaramara.
- `run_live_suite.py` executes the 30 scenarios through that REST transport, caches successful structured
  results, records invocation errors separately, accepts an alternate `--suite`, and repeats the configured
  high-risk subset three times.
- `generate_unseen_scenarios.mjs` and `unseen-scenarios.json` define the frozen 18-case Phase A.2
  generalisation set.
- `PHASE-A2-FAILURE-ANALYSIS.md` freezes the pre-change diagnosis; `PHASE-A2-REPORT.md` records selected,
  rejected-experiment and unseen results.
- `MODEL-BENCHMARK-2026-11-05.md` records tenant model discovery and the REST comparison against the unchanged
  original and held-out suites; raw model responses are retained under `results/model-benchmark-20261105/`.
- `MODEL-BENCHMARK-INDEPENDENT-50.md` retains the frozen independent campaign.
  `convert_independent_50_to_native.mjs` hash-checks and converts its exact requests without changing the
  sources. `NATIVE-ORCHESTRATE-FEASIBILITY.md` records the Stage A capability, UI and governance findings.
- `NATIVE-COMPATIBLE-SUBSET-2026-11-06.md` records the full-input termination scan. All 50 exact requests
  contain `END` through the preserved `FRIENDS_FAMILY` questionnaire option, so no three-case native proof or
  model campaign was run.
- `NATIVE-MODIFIED-INPUT-CAMPAIGN-2026-11-06.md` records the explicitly modified 37-case native campaign
  against isolated Gemma, Groq and Frontier agents. Generated requests remove the unused termination-triggering
  option; they are not direct reproductions of the frozen benchmark.
- `evaluation-assets.test.mjs` protects the investment-indicator/provenance expectation and the corresponding
  agent-instruction invariant.
- `results/phase-a1-live/`, `results/phase-a1-summary.json` and
  `results/phase-a1-parity-summary.json` retain the credential-free observed outputs and grading summary.
- `results/phase-a2-live/` and `results/phase-a2-summary.json` are the selected 1.1.2 results. The explicitly
  named rejected 1.1.3 outputs and unseen outputs remain separate.
- `BASELINE.md` records what was actually executed on 5 November 2026. `NOT_RUN` is never treated as pass.

IBM ADK 2.19.1 exposes `orchestrate evaluations evaluate`, `validate-native`, `quick-eval`, `analyze` and
red-teaming. The pinned native evaluator is the separately installed
`ibm-watsonx-orchestrate-evaluation-framework==1.5.2`. IBM's reference journey format and commands are in
the [official ADK examples](https://github.com/IBM/ibm-watsonx-orchestrate-adk/tree/main/examples/evaluations/evaluate).

## Reproduce the credential-free layers

From the repository root:

```sh
node watsonx-orchestrate/fraud-intelligence/evaluation/generate_native_cases.mjs
node watsonx-orchestrate/fraud-intelligence/evaluation/run_suite.mjs \
  --output /tmp/glaramara-evaluation-local.json
```

Expected baseline: 30 policy passes, 30 guidance passes and 30 extraction `NOT_RUN` results. The command
exits non-zero for an unexpected deterministic policy or guidance failure.

## Native Orchestrate evaluation

Install the evaluator version selected by the pinned ADK and activate the existing development tenant:

```sh
watsonx-orchestrate/.venv/bin/pip install \
  'ibm-watsonx-orchestrate[agentops]==2.19.1'
watsonx-orchestrate/.venv/bin/orchestrate env activate glaramara-techzone
watsonx-orchestrate/.venv/bin/orchestrate evaluations evaluate \
  --config watsonx-orchestrate/fraud-intelligence/evaluation/native-evaluation-config.yaml
```

Evaluation-framework 1.5.2 currently cannot execute the exact Glaramara payload. Its controller terminates
before agent invocation when a first user message contains the literal substring `END`; the bounded
`FRIENDS_FAMILY` option in every real request triggers that behavior. The checked-in native cases preserve
the exact request rather than escaping or deleting that option. Until IBM fixes the controller, record this
layer as unsupported/failed with zero steps, never as an agent pass. The baseline includes an executed
one-case reproduction. Inspection of the published 1.7.0 wheel found the same substring test, so upgrading
outside ADK 2.19.1's pinned dependency is not a supported fix and would not remove the collision.

Convert the three-case independent proof set without making a tenant call:

```sh
node watsonx-orchestrate/fraud-intelligence/evaluation/convert_independent_50_to_native.mjs \
  --output /tmp/glaramara-native-poc \
  --id investment-crypto-liquidity-release \
  --id legitimate-builder-stage-payment \
  --id ambiguous-beneficiary-trading-name
```

Omit `--id` to convert all 50. The conversion manifest retains fraud-specific criteria that the native
journey schema cannot express; the independent harness remains authoritative.

## Bounded live ADK/REST parity

This makes two live development-tenant calls for the named scenario. Live calls are opt-in and must use an
ignored server-side environment file; do not commit its contents.

```sh
set -a
. glaramara-bank/.env.local
set +a
watsonx-orchestrate/.venv/bin/python \
  watsonx-orchestrate/fraud-intelligence/evaluation/run_live_parity.py \
  --scenario investment-influencer-urgent-returns-regression \
  --output-dir /tmp/glaramara-live-parity

node watsonx-orchestrate/fraud-intelligence/evaluation/run_suite.mjs \
  --extraction-results /tmp/glaramara-live-parity \
  --output /tmp/glaramara-evaluation-live.json
```

The runner writes only evidence, transport name and latency. It does not write credentials, agent threads,
payment data, decisions or ledger state.

## Phase A.1 live suite

Load the same ignored environment file, then run the resumable campaign. Existing successful result files
are reused unless `--refresh` is supplied; errors are preserved and can be retried without discarding the
failure observation.

```sh
watsonx-orchestrate/.venv/bin/python \
  watsonx-orchestrate/fraud-intelligence/evaluation/run_live_suite.py \
  --output-dir watsonx-orchestrate/fraud-intelligence/evaluation/results/phase-a1-live

node watsonx-orchestrate/fraud-intelligence/evaluation/run_suite.mjs \
  --extraction-results watsonx-orchestrate/fraud-intelligence/evaluation/results/phase-a1-live \
  --output watsonx-orchestrate/fraud-intelligence/evaluation/results/phase-a1-summary.json

node --test \
  watsonx-orchestrate/fraud-intelligence/evaluation/evaluation-assets.test.mjs
```

`run_suite.mjs` applies exact structured assertions. Its repeat-consistency metric also reports a semantic
comparison that ignores array order and provenance claim wording, but it is not a model-graded assessment.

## Phase A.2 selected and unseen suites

```sh
# Selected 1.1.2 original suite
watsonx-orchestrate/.venv/bin/python \
  watsonx-orchestrate/fraud-intelligence/evaluation/run_live_suite.py \
  --output-dir watsonx-orchestrate/fraud-intelligence/evaluation/results/phase-a2-live

# Deterministically regenerate, then execute the frozen unseen suite once
node watsonx-orchestrate/fraud-intelligence/evaluation/generate_unseen_scenarios.mjs
watsonx-orchestrate/.venv/bin/python \
  watsonx-orchestrate/fraud-intelligence/evaluation/run_live_suite.py \
  --suite watsonx-orchestrate/fraud-intelligence/evaluation/unseen-scenarios.json \
  --no-default-repeats \
  --output-dir watsonx-orchestrate/fraud-intelligence/evaluation/results/phase-a2-unseen-live
```
