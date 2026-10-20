# Repository Guidelines

## Project Structure & Module Organization

- `confluent-flink/` contains Kafka/Flink infrastructure, Compose configuration, Flink SQL, the Java DataStream job, Python generators, and streaming tests.
- `agents/src/fraud_agents/` contains the deterministic router, Claude investigation orchestration, PostgreSQL persistence, budget controls, and Kafka workers. Its tests live in `agents/tests/`; Alembic migrations are in `agents/migrations/`.
- `fraud-decisioning/` owns the PostgreSQL Compose service and operational scripts.
- `docs/architecture.md` documents trust boundaries and decision authority. Update the nearest README when changing setup or operational behavior.

## Build, Test, and Development Commands

Run commands from the component directory unless stated otherwise.

```sh
cd agents && .venv/bin/python -m pip install -e '.[dev]'
cd agents && .venv/bin/pytest
cd agents && .venv/bin/ruff check .
cd confluent-flink && scripts/build_enrichment.sh
cd confluent-flink && python3 -m unittest discover -s tests -v
```

`pytest` covers decisioning and agent behavior; Ruff checks Python style. The build script compiles the Flink Java artifact in Maven. Integration tests are opt-in because they publish to local Kafka; follow each component README before running them. Use `podman compose config` to validate Compose edits without changing running services.

## Coding Style & Naming Conventions

Python targets 3.11, uses four-space indentation, type hints, and a 110-character line limit. Ruff enforces `E`, `F`, `I`, `UP`, `B`, and `ASYNC` rules. Use `snake_case` for modules/functions, `PascalCase` for classes, and explicit versioned names for policies and schemas. Keep Kafka event IDs deterministic and preserve provenance fields. Follow existing Java formatting and Maven package layout under `confluent-flink/src/`.

## Testing Guidelines

Name Python tests `test_*.py` and test functions `test_<behavior>`. Prefer deterministic fixtures, fake Anthropic responses, and isolated identifiers. Never make paid model calls from tests. Changes to routing, persistence, or investigations must cover retries, idempotency, immutable payment verdicts, and budget enforcement where applicable.

## Commit & Pull Request Guidelines

History is small and uses short imperative summaries (for example, `update readme`). Keep commits focused and describe the outcome in the subject. Pull requests should explain the affected data flow, list verification commands and results, link relevant issues, and call out migrations, configuration changes, API costs, or operational risk. Include screenshots only for UI-visible changes.

## Security & Operational Safety

Never commit `.env` files, API keys, database credentials, or sensitive payment data. Keep live investigations disabled unless explicitly approved. Do not reset Kafka offsets, recreate stateful containers, or alter immutable payment decisions as part of routine development.
