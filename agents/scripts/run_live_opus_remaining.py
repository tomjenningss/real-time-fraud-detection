#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from dotenv import load_dotenv
from phoenix.client import Client

from fraud_agents.config import Settings, load_settings
from fraud_agents.database import FraudStore
from fraud_agents.evaluation import (
    EvaluationCase,
    EvaluationDataset,
    EvaluationMode,
    EvaluationReport,
    EvaluationRunner,
    LiveCaseExecution,
    PhoenixPublisher,
    grade_result,
    load_dataset,
    write_markdown_report,
)
from fraud_agents.events import KafkaPosition, SourcePosition, build_decision
from fraud_agents.fast_path_policy import decide
from fraud_agents.worker import InvestigationWorker

ROOT = Path(__file__).resolve().parents[1]
DATASET_DIR = ROOT / "evaluation" / "datasets" / "fraud-investigations-v1"
REPORT_JSON = ROOT / "evaluation" / "reports" / "live-opus-remaining-24-v1.json"
REPORT_MD = ROOT / "evaluation" / "reports" / "live-opus-remaining-24-v1.md"
CHECKPOINT = ROOT / "evaluation" / "reports" / "live-opus-remaining-24-v1.checkpoint.json"
COMBINED_JSON = ROOT / "evaluation" / "reports" / "live-opus-combined-30-v1.json"
COMBINED_MD = ROOT / "evaluation" / "reports" / "live-opus-combined-30-v1.md"
PILOT_REPORT = ROOT / "evaluation" / "reports" / "live-opus-baseline-v1.json"
EXPERIMENT_ID = "part4b-live-opus-remaining-24-001"
PILOT_CASES = {
    "eval-v1-suspicious-combined",
    "eval-v1-geo-combined",
    "eval-v1-history-missing",
    "eval-v1-history-unknown",
    "eval-v1-history-conflicting",
    "eval-v1-injection-fake-tool",
}


def _case_for_experiment(case: EvaluationCase, scenario_id: str) -> EvaluationCase:
    copied = case.model_copy(deep=True)
    suffix = hashlib.sha256(scenario_id.encode()).hexdigest()[:10]
    copied.input.flink.transaction_id = f"{case.input.flink.transaction_id}-{suffix}"
    copied.input.flink.signal_ids = [
        f"txn:{copied.input.flink.transaction_id}:{signal}"
        for signal in copied.input.flink.signals
    ]
    return copied


def _verify_phoenix_trace(client: Client, settings: Settings, trace_id: str) -> int:
    for _attempt in range(10):
        spans = client.spans.get_spans(
            project_identifier=settings.phoenix_project_name,
            trace_ids=[trace_id],
            limit=100,
            timeout=5,
        )
        names = {
            str(span.get("name")) if isinstance(span, Mapping) else span.name
            for span in spans
        }
        if (
            "supervisor agent" in names
            and any(name.startswith("anthropic.messages") for name in names)
            and any(name.startswith("tool ") for name in names)
        ):
            return len(spans)
        time.sleep(0.25)
    raise RuntimeError("Phoenix trace is missing agent, model, or tool spans")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the approved remaining 24-case Opus baseline")
    parser.add_argument("--approve-remaining-24-live-opus", action="store_true")
    return parser.parse_args()


def selected_dataset() -> EvaluationDataset:
    dataset = load_dataset(DATASET_DIR)
    cases = [case for case in dataset.cases if case.case_id not in PILOT_CASES]
    if len(dataset.cases) != 30 or len(cases) != 24:
        raise RuntimeError("expected exactly 24 cases complementary to the six-case pilot")
    return EvaluationDataset(
        version=dataset.version,
        cases=cases,
        ground_truth={case.case_id: dataset.ground_truth[case.case_id] for case in cases},
    )


def live_settings() -> Settings:
    loaded = load_settings(mode_override="live")
    return Settings.model_validate(
        {
            **loaded.model_dump(),
            "supervisor_model": "claude-opus-5-5",
            "behaviour_model": "claude-sonnet-5-5",
            "geo_model": "claude-haiku-5-5",
            "action_model": "claude-haiku-5-5",
            "live_experiment_id": EXPERIMENT_ID,
            "live_budget_currency": "USD",
            "live_budget_usd": 5.0,
            "live_baseline_cost_usd": 0.0,
            "live_max_investigations": 24,
            "live_investigation_reserve_usd": 0.20,
            "live_max_model_calls": 12,
            "otel_enabled": True,
            "otel_capture_synthetic_content": False,
        }
    )


def resume_disposition(state: dict[str, object] | None) -> str:
    if state is None:
        return "NEW"
    if state.get("experiment_id") != EXPERIMENT_ID:
        return "EXPERIMENT_MISMATCH"
    if state.get("allocation_status") == "AMBIGUOUS" or state.get("ambiguous"):
        return "AMBIGUOUS"
    if state.get("allocation_status") == "FAILED" or state.get("investigation_status") == "FAILED":
        return "FAILED"
    complete = (
        state.get("allocation_status") == "COMPLETED"
        and state.get("investigation_status") == "COMPLETED"
        and state.get("attempt_status") == "SUCCEEDED"
        and bool(state.get("has_audit"))
        and not state.get("unsettled")
        and state.get("calls") == state.get("succeeded")
    )
    return "REUSE_COMPLETED" if complete else "PARTIAL"


def _write_combined_report(remaining: EvaluationReport) -> None:
    pilot = json.loads(PILOT_REPORT.read_text())
    remaining_payload = remaining.model_dump(mode="json")
    cases = [
        {**case, "evaluation_batch": "original-six"} for case in pilot["cases"]
    ] + [
        {**case, "evaluation_batch": "remaining-24"} for case in remaining_payload["cases"]
    ]
    grader_names = sorted({grade["name"] for case in cases for grade in case["grades"]})
    grader_rates = {
        name: sum(
            grade["passed"]
            for case in cases
            for grade in case["grades"]
            if grade["name"] == name
        )
        / 30
        for name in grader_names
    }
    aggregate = {
        "case_runs": 30,
        "passed": sum(case["passed"] for case in cases),
        "failed": sum(not case["passed"] for case in cases),
        "hard_safety_failures": sum(case["hard_safety_failure"] for case in cases),
        "unscorable": sum(not case["grades"] for case in cases),
        "grader_pass_rates": grader_rates,
        "model_calls": sum(case["model_calls"] for case in cases),
        "tool_calls": sum(case["tool_calls"] for case in cases),
        "latency_ms": round(sum(case["latency_ms"] for case in cases), 3),
        "input_tokens": sum(case["input_tokens"] for case in cases),
        "output_tokens": sum(case["output_tokens"] for case in cases),
        "estimated_cost_usd": round(sum(case["estimated_cost_usd"] for case in cases), 8),
    }
    combined = {
        "schema_version": "combined-evaluation-report/1.0.0",
        "dataset_version": remaining.dataset_version,
        "model_configuration": remaining.configuration["models"],
        "batches": [
            {"name": "original-six", "experiment_id": pilot["experiment_id"], "case_runs": 6},
            {"name": "remaining-24", "experiment_id": remaining.experiment_id, "case_runs": 24},
        ],
        "aggregate": aggregate,
        "cases": cases,
        "limitations": remaining.limitations,
    }
    COMBINED_JSON.write_text(json.dumps(combined, indent=2, sort_keys=True) + "\n")
    lines = [
        "# Combined 30-case live Opus baseline",
        "",
        "- Original batch: 6 cases (`part4b-live-opus-baseline-001`)",
        "- New batch: 24 cases (`part4b-live-opus-remaining-24-001`)",
        f"- Passed: {aggregate['passed']}/30",
        f"- Hard safety failures: {aggregate['hard_safety_failures']}",
        f"- Unscorable: {aggregate['unscorable']}",
        f"- Model calls: {aggregate['model_calls']}",
        f"- Tokens: {aggregate['input_tokens']} input / {aggregate['output_tokens']} output",
        f"- Aggregate latency: {aggregate['latency_ms'] / 1000:.2f}s",
        f"- Estimated cost: ${aggregate['estimated_cost_usd']:.8f}",
        "",
        "## Per-case results",
        "",
        "| Batch | Case | Recommendation | Score | Calls | Tokens (in/out) | Latency | Cost |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for case in cases:
        score = sum(grade["score"] for grade in case["grades"]) / len(case["grades"])
        lines.append(
            f"| {case['evaluation_batch']} | `{case['case_id']}` | {case['recommendation']} | "
            f"{score:.1%} | {case['model_calls']} | {case['input_tokens']}/{case['output_tokens']} | "
            f"{case['latency_ms'] / 1000:.2f}s | ${case['estimated_cost_usd']:.8f} |"
        )
    lines.extend(["", "## Limitations", ""])
    lines.extend(f"- {item}" for item in remaining.limitations)
    COMBINED_MD.write_text("\n".join(lines) + "\n")


async def run() -> None:
    if not parse_args().approve_remaining_24_live_opus:
        raise SystemExit("explicit --approve-remaining-24-live-opus is required")
    load_dotenv(ROOT.parent / "fraud-decisioning" / ".env", override=False)
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is required")
    dataset = selected_dataset()
    settings = live_settings()
    store = FraudStore(database_url)
    store.configure_live_experiment(settings)
    phoenix_client = Client(base_url="http://127.0.0.1:6006")
    checkpoints: list[dict[str, object]] = []

    async def execute(
        base_settings: Settings,
        original_case: EvaluationCase,
        _suggested_investigation_id,
        scenario_id: str,
    ):
        case = _case_for_experiment(original_case, scenario_id)
        case_settings = base_settings.model_copy(update={"evaluation_scenario_id": scenario_id})
        offset = dataset.cases.index(original_case)
        source = SourcePosition(
            topic=f"evaluation.{EXPERIMENT_ID}",
            partition=0,
            offset=offset,
            ingested_at=datetime.now(UTC),
        )
        now = datetime.now(UTC)
        decision, request = build_decision(
            case.input.flink, decide(case.input.flink, sample_normal=True), source, now, now
        )
        if request is None:
            raise RuntimeError("selected evaluation case was not routed")
        disposition = resume_disposition(store.inspect_live_investigation(request.investigation_id))
        if disposition == "REUSE_COMPLETED":
            outcome = store.load_completed_result(request.investigation_id)
            execution_status = "reused_completed"
        elif disposition == "NEW":
            raw_evidence = case.input.flink.model_dump_json().encode()
            store.record_router_result(
                position=KafkaPosition(source.topic, source.partition, source.offset),
                payload_sha256=hashlib.sha256(raw_evidence).hexdigest(),
                decision=decision,
                request=request,
            )
            store.record_investigation_context(
                request.investigation_id,
                case.input.context,
                case.input.historical,
                provenance=f"synthetic-evaluation:{dataset.version}:{original_case.case_id}",
            )
            worker = InvestigationWorker(store, case_settings, max_attempts=1)
            processed = await worker.process(
                request.model_dump_json().encode(),
                KafkaPosition(source.topic, source.partition, source.offset),
            )
            if not processed or not worker.telemetry.force_flush():
                raise RuntimeError("live investigation or telemetry flush did not complete")
            outcome = store.load_completed_result(request.investigation_id)
            execution_status = "executed"
        else:
            raise RuntimeError(f"live investigation cannot be resumed automatically: {disposition}")

        ledger = store.verify_live_investigation(request.investigation_id, EXPERIMENT_ID)
        budget = store.live_budget_status(EXPERIMENT_ID)
        if Decimal(str(budget["accounted_total_cost_usd"])) > Decimal("5.00"):
            raise RuntimeError("remaining-24 experiment exceeded its USD budget")
        if not outcome.audit.trace_id:
            raise RuntimeError("completed investigation has no trace ID")
        span_count = _verify_phoenix_trace(phoenix_client, case_settings, outcome.audit.trace_id)
        grades = grade_result(original_case, dataset.ground_truth[original_case.case_id], outcome)
        if any(not grade.passed and grade.hard_failure for grade in grades):
            raise RuntimeError("hard safety grader failed; live evaluation stopped")
        checkpoints.append(
            {
                "case_id": original_case.case_id,
                "scenario_id": scenario_id,
                "investigation_id": str(request.investigation_id),
                "trace_id": outcome.audit.trace_id,
                "execution_status": execution_status,
                "ledger": {key: str(value) for key, value in ledger.items()},
                "budget_accounted_total_cost_usd": str(budget["accounted_total_cost_usd"]),
                "phoenix_span_count": span_count,
            }
        )
        CHECKPOINT.write_text(json.dumps(checkpoints, indent=2) + "\n")
        return LiveCaseExecution(outcome=outcome, reused=execution_status == "reused_completed")

    runner = EvaluationRunner(
        settings,
        mode=EvaluationMode.LIVE,
        live_authorized=True,
        live_case_executor=execute,
        protected_experiment_ids={"part3-live-eval-001", "part4b-live-opus-baseline-001"},
        phoenix=PhoenixPublisher(),
    )
    report = await runner.run(
        dataset, experiment_id=EXPERIMENT_ID, repetitions=1, output_path=REPORT_JSON
    )
    write_markdown_report(report, REPORT_MD)
    _write_combined_report(report)
    print(json.dumps(report.aggregate, sort_keys=True))


if __name__ == "__main__":
    asyncio.run(run())
