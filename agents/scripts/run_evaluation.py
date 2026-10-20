#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from fraud_agents.config import Settings
from fraud_agents.evaluation import (
    EvaluationMode,
    EvaluationRunner,
    PhoenixPublisher,
    ReplayStore,
    load_dataset,
    write_markdown_report,
)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET = ROOT / "evaluation" / "datasets" / "fraud-investigations-v1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run reproducible fraud-agent evaluations")
    parser.add_argument("--mode", choices=["offline", "replay"], default="offline")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--replay-fixture", type=Path)
    parser.add_argument("--experiment-id", default="part4b-offline-baseline-v1")
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--output", type=Path, default=ROOT / "evaluation" / "reports" / "latest.json")
    parser.add_argument("--markdown", type=Path, default=ROOT / "evaluation" / "reports" / "latest.md")
    parser.add_argument("--publish-phoenix", action="store_true")
    parser.add_argument("--phoenix-url", default="http://127.0.0.1:6006")
    return parser.parse_args()


async def run(args: argparse.Namespace) -> None:
    mode = EvaluationMode.OFFLINE if args.mode == "offline" else EvaluationMode.REPLAY
    if mode == EvaluationMode.REPLAY and args.replay_fixture is None:
        raise SystemExit("--replay-fixture is required in replay mode")
    dataset = load_dataset(args.dataset)
    runner = EvaluationRunner(
        Settings(agent_mode="dry-run", otel_enabled=False, audit_enabled=False),
        mode=mode,
        replay=ReplayStore(args.replay_fixture) if args.replay_fixture else None,
        phoenix=PhoenixPublisher(args.phoenix_url) if args.publish_phoenix else None,
    )
    report = await runner.run(
        dataset,
        experiment_id=args.experiment_id,
        repetitions=args.repetitions,
        output_path=args.output,
    )
    write_markdown_report(report, args.markdown)
    print(
        f"mode={report.mode.value} cases={report.aggregate['case_runs']} "
        f"passed={report.aggregate['passed']} failed={report.aggregate['failed']} "
        f"cost_usd={report.aggregate['estimated_cost_usd']:.8f}"
    )


def main() -> None:
    asyncio.run(run(parse_args()))


if __name__ == "__main__":
    main()
