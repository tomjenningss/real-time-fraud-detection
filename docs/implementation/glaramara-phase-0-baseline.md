# Glaramara Phase 0 baseline evidence

Captured on 31 October 2026 before Phase A implementation. The baseline passed its read-only protection
gate, with the limitations below. It records the existing platform and the approved Glaramara visual
reference; it is not evidence of a fresh live end-to-end payment run.

## Safety boundary

This capture did not start, stop or restart any existing service. It did not publish Kafka records, reset
consumer offsets, recreate or clear volumes, run database migrations, change Flink state, or modify an
immutable decision. The golden environment and its stateful data were left in place.

The IBM TechZone tenant was not accessed. No Orchestrate agent or tool was imported, deployed, changed or
deleted, and the remaining AskOrchestrate agent was left untouched.

The approved [clickable prototype](../designs/glaramara-clickable-prototype.html) was opened only to capture
visual baselines. It was not edited. At capture time, `docs/designs/` was an untracked supplied artifact, so
the checksum below is the durable identity until that artifact is committed.

## Environment

| Tool | Captured environment | Note |
|---|---|---|
| System Python | 3.11.11 | Repository target interpreter |
| `agents/.venv` Python | 3.14.3 | Existing virtual environment; see limitations |
| Node.js / npm | 22.22.2 / 10.9.7 | Available for the subsequent banking UI work |
| Google Chrome | 156.0.8078.74 | Used headlessly for the prototype screenshots |
| Maven / Java | Maven 3.9.9 with Eclipse Temurin 11 | Cached container toolchain; Maven was absent on the host |
| Go | 1.24.13 | Cached container toolchain; Go was absent on the host |

## Existing test baseline

All commands below exited successfully unless a limitation is stated explicitly.

| Area | Command | Result |
|---|---|---|
| Python agents | `cd agents && .venv/bin/pytest -q` | 78 passed, 2 skipped, 334 `pytest-asyncio` warnings |
| Python style | `cd agents && .venv/bin/ruff check .` | All checks passed |
| Flink/Python support | `cd confluent-flink && python3 -m unittest discover -s tests -v` | 21 run: 15 passed and 6 skipped because `RUN_ENRICHMENT_INTEGRATION` was not enabled |
| Flink Java build | `cd confluent-flink && scripts/build_enrichment.sh` | Maven `clean verify` completed with `BUILD SUCCESS`; 4 Java sources compiled and no Java tests were present |
| Deployment tests | `python3 -m unittest discover -s deployment/tests -v` | 22 passed |
| Compose rendering | `make config` | Compose configuration rendered successfully; no services were changed |
| Assessment correlator | `cd fraud-assessment-correlator && go test ./...` | 6 top-level tests passed; 3 PostgreSQL integration tests skipped |
| Assessment correlator vet | `cd fraud-assessment-correlator && go vet ./...` | Passed |
| Decision engine | `cd fraud-decision-engine && go test ./...` | 9 top-level tests passed; 1 PostgreSQL integration test skipped |
| Decision engine vet | `cd fraud-decision-engine && go vet ./...` | Passed |

The Go commands were executed in cached Go 1.24.13 containers with the component source mounted read-only.
The Flink build script used its checked-in cached-container path (`maven:3.9.9-eclipse-temurin-11`) and reused
the existing Maven dependency-cache volume. No runtime Flink job was submitted. The build emitted existing
shade and deprecated-API warnings but succeeded.

## Controlled 16-payment reference

The recorded reference distribution is:

| Shadow action | Count |
|---|---:|
| `APPROVED` | 11 |
| `CHALLENGED` | 2 |
| `BLOCKED` | 3 |
| **Total** | **16** |

Three independent checked-in sources establish this reference:

1. The [controlled-scenario generator](../../confluent-flink/scripts/generate_controlled_scenario.py)
   declares `expected_payment_verdicts` as 11 approved, 2 challenged and 3 blocked.
2. The bounded [deployment smoke test](../../deployment/smoke_test.py) asserts exactly the same distribution.
3. The checked-in [shadow-v1 evaluation report](../../fraud-decision-engine/evaluation/shadowv1-20261028T1605Z.md)
   records totals of 11 approved, 2 challenged and 3 blocked for the controlled run.

This Phase 0 capture deliberately did **not** execute the live smoke test. The table therefore preserves the
controlled reference and its prior observed evidence; it does not claim that the currently running Kafka,
Flink, PostgreSQL and Go services were exercised again.

## Approved visual baseline

Prototype identity:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `docs/designs/glaramara-clickable-prototype.html` | 41,947 | `b4d80db36500936eb4a4d7cc1597881b52815af8551d8d6fb7955258e9d45374` |

Headless Chrome captured the initial prototype view at the two approved reference sizes. The PNGs are
temporary evidence files rather than application source.

| View | Dimensions | Bytes | Temporary file | SHA-256 |
|---|---:|---:|---|---|
| Mobile | 390 × 844 | 98,092 | `/private/tmp/glaramara-prototype-mobile-390x844.png` | `e39d8ce610bde3fb05912b170d7c954207f8804e1d597b2b90aea3e3c5625ea7` |
| Desktop | 1440 × 1000 | 249,271 | `/private/tmp/glaramara-prototype-desktop-1440x1000.png` | `9bccc4f6b0232e5d93fce20257ccdb412658480ec3003248a838da0bf0eb96fc` |

The captures preserve the prototype's forest-green palette, `glaramara.` wordmark, mountain artwork,
desktop rail and mobile-first layout as the Phase A comparison point.

## Limitations and follow-up

- Live Kafka, PostgreSQL, Flink and end-to-end smoke tests were intentionally not run. Their opt-in tests
  account for the recorded Python, Flink and Go skips.
- The existing `agents/.venv` runs Python 3.14.3 while the repository targets Python 3.11. The suite is green
  in that environment, but a release gate should also run it in the pinned 3.11 environment.
- Host Go and Maven were unavailable, so cached container toolchains supplied those checks. Their versions
  are recorded above; no image was pulled or upgraded as part of this capture.
- The Java build contains no Java unit tests. Its successful compile/package check does not replace the
  isolated watermark and state-compatibility work reserved for Phase B0.
- Existing Maven shade and deprecated-API warnings, and the 334 `pytest-asyncio` warnings, are non-blocking
  baseline noise rather than Phase A regressions.

Subject to those explicit constraints, there were no unexplained baseline failures and Phase A could proceed
without changing the existing fraud platform.
