#!/usr/bin/env python3
"""Run the checked-in suite through Glaramara's REST-compatible Orchestrate path."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
AGENT_DIR = HERE.parent
sys.path.insert(0, str(AGENT_DIR))

from evaluate_live import iam_token, invoke_rest  # noqa: E402
from run_live_parity import build_context  # noqa: E402

DEFAULT_REPEAT_SCENARIOS = [
    "investment-influencer-urgent-returns-regression",
    "investment-crypto-remote-access",
    "bank-safe-account-call",
    "family-daughter-urgent-new-number",
    "romance-new-partner-emergency",
    "adversarial-invent-bank-impersonation",
]


def request_sha256(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--agent-id", required=True)
    parser.add_argument("--agent-name", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument(
        "--suite",
        type=Path,
        default=HERE / "scenarios.json",
        help="Scenario dataset; defaults to the original 30-scenario suite.",
    )
    parser.add_argument(
        "--repeat-scenario",
        action="append",
        dest="repeat_scenarios",
        help="Scenario to execute three times total; repeat for more scenarios.",
    )
    parser.add_argument(
        "--no-default-repeats",
        action="store_true",
        help="Run every scenario once without the representative repeated subset.",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Ignore cached result files and invoke the live agent again.",
    )
    args = parser.parse_args()

    if not os.getenv("WATSONX_ORCHESTRATE_API_KEY") or not os.getenv("WATSONX_ORCHESTRATE_URL"):
        raise RuntimeError("live suite requires WATSONX_ORCHESTRATE_API_KEY and WATSONX_ORCHESTRATE_URL")

    suite = json.loads(args.suite.read_text())
    scenarios = suite["scenarios"]
    scenario_ids = {scenario["id"] for scenario in scenarios}
    repeat_scenarios = args.repeat_scenarios
    if repeat_scenarios is None:
        repeat_scenarios = [] if args.no_default_repeats else DEFAULT_REPEAT_SCENARIOS
    unknown = sorted(set(repeat_scenarios) - scenario_ids)
    if unknown:
        raise SystemExit(f"unknown repeat scenarios: {', '.join(unknown)}")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    plan = []
    for scenario in scenarios:
        runs = 3 if scenario["id"] in repeat_scenarios else 1
        plan.extend((scenario, run_number) for run_number in range(1, runs + 1))

    uncached = []
    for scenario, run_number in plan:
        target = args.output_dir / f"{scenario['id']}-rest-run-{run_number}.json"
        if args.refresh or not target.exists():
            uncached.append((scenario, run_number, target))

    access_token = iam_token() if uncached else None
    executed = 0
    failed = 0
    cached = len(plan) - len(uncached)
    for index, (scenario, run_number, target) in enumerate(uncached, start=1):
        payload = build_context(scenario)
        try:
            result = invoke_rest(payload, access_token, args.agent_id)
        except Exception as error:
            prior_errors = sorted(args.output_dir.glob(f"{scenario['id']}-rest-run-{run_number}-error-*.json"))
            error_target = args.output_dir / (
                f"{scenario['id']}-rest-run-{run_number}-error-{len(prior_errors) + 1}.json"
            )
            error_record = {
                "scenarioId": scenario["id"],
                "run": run_number,
                "transport": "watsonx-orchestrate-rest-chat-completions",
                "agent": args.agent_name,
                "agentVersion": "1.1.2",
                "model": args.model,
                "schemaVersion": "fraud-intelligence-evidence/1.1.0",
                "requestSha256": request_sha256(payload),
                "executionError": str(error),
            }
            error_target.write_text(json.dumps(error_record, indent=2) + "\n")
            executed += 1
            failed += 1
            print(
                f"[{index}/{len(uncached)}] {scenario['id']} run {run_number}: "
                f"ERROR {type(error).__name__}: {error}",
                flush=True,
            )
            continue
        if result["evidence"] is None:
            prior_errors = sorted(args.output_dir.glob(f"{scenario['id']}-rest-run-{run_number}-error-*.json"))
            error_target = args.output_dir / (
                f"{scenario['id']}-rest-run-{run_number}-error-{len(prior_errors) + 1}.json"
            )
            error_record = {
                "scenarioId": scenario["id"],
                "run": run_number,
                "transport": "watsonx-orchestrate-rest-chat-completions",
                "agent": args.agent_name,
                "agentVersion": "1.1.2",
                "model": args.model,
                "schemaVersion": "fraud-intelligence-evidence/1.1.0",
                "requestSha256": request_sha256(payload),
                "latencyMs": result["latencyMs"],
                "executionError": "REST response contained no schema-versioned evidence",
                "rawResponse": result["rawResponse"],
            }
            error_target.write_text(json.dumps(error_record, indent=2, ensure_ascii=False) + "\n")
            executed += 1
            failed += 1
            print(
                f"[{index}/{len(uncached)}] {scenario['id']} run {run_number}: "
                "ERROR no schema-versioned evidence",
                flush=True,
            )
            continue
        record = {
            "scenarioId": scenario["id"],
            "run": run_number,
            "transport": "watsonx-orchestrate-rest-chat-completions",
            "agent": args.agent_name,
            "agentVersion": "1.1.2",
            "model": args.model,
            "schemaVersion": "fraud-intelligence-evidence/1.1.0",
            "requestSha256": request_sha256(payload),
            "latencyMs": result["latencyMs"],
            "evidence": result["evidence"],
            "rawResponse": result["rawResponse"],
        }
        target.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
        executed += 1
        print(
            f"[{index}/{len(uncached)}] {scenario['id']} run {run_number}: "
            f"{result['latencyMs']} ms",
            flush=True,
        )

    error_files = list(args.output_dir.glob("*-error-*.json"))
    success_files = [
        path for path in args.output_dir.glob("*-rest-run-*.json") if "-error-" not in path.name
    ]
    manifest = {
        "suiteVersion": suite["suiteVersion"],
        "agent": args.agent_name,
        "agentVersion": "1.1.2",
        "model": args.model,
        "transport": "watsonx-orchestrate-rest-chat-completions",
        "schemaVersion": "fraud-intelligence-evidence/1.1.0",
        "scenarioCount": len(scenarios),
        "plannedInvocationCount": len(plan),
        "executedInvocationCount": executed,
        "cachedInvocationCount": cached,
        "successfulResultCount": len(success_files),
        "failedInvocationCount": len(error_files),
        "actualLiveCallCount": len(success_files) + len(error_files),
        "failedInvocationCountThisRun": failed,
        "repeatScenarios": repeat_scenarios,
    }
    (args.output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
