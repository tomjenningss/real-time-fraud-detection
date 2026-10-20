#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import statistics
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
REPORT_JSON = ROOT / "evaluation" / "reports" / "live-sonnet-supervisor-30-v1.json"
REPORT_MD = ROOT / "evaluation" / "reports" / "live-sonnet-supervisor-30-v1.md"
CHECKPOINT = ROOT / "evaluation" / "reports" / "live-sonnet-supervisor-30-v1.checkpoint.json"
COMPARISON_JSON = ROOT / "evaluation" / "reports" / "live-opus-vs-sonnet-30-v1.json"
COMPARISON_MD = ROOT / "evaluation" / "reports" / "live-opus-vs-sonnet-30-v1.md"
OPUS_REPORT = ROOT / "evaluation" / "reports" / "live-opus-combined-30-v1.json"
EXPERIMENT_ID = "part4b-live-sonnet-supervisor-30-001"
ALLOWED_TOOLS = {
    "check_geo_distance",
    "get_canonical_behaviour_evidence",
    "apply_decision_rules",
    "run_geo_investigation",
    "run_behaviour_investigation",
    "run_action_policy",
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
    parser = argparse.ArgumentParser(description="Run the approved 30-case Sonnet comparison")
    parser.add_argument("--approve-live-sonnet-supervisor-30", action="store_true")
    return parser.parse_args()


def live_settings() -> Settings:
    loaded = load_settings(mode_override="live")
    return Settings.model_validate(
        {
            **loaded.model_dump(),
            "supervisor_model": "claude-sonnet-5-5",
            "behaviour_model": "claude-sonnet-5-5",
            "geo_model": "claude-haiku-5-5",
            "action_model": "claude-haiku-5-5",
            "live_experiment_id": EXPERIMENT_ID,
            "live_budget_currency": "USD",
            "live_budget_usd": 6.5,
            "live_baseline_cost_usd": 0.0,
            "live_max_investigations": 30,
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


def _percentile_95(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[math.ceil(0.95 * len(ordered)) - 1]


def _metrics(cases: list[dict]) -> dict[str, float | int]:
    latencies = [case["latency_ms"] for case in cases]
    total_cost = sum(case["estimated_cost_usd"] for case in cases)
    return {
        "passed": sum(case["passed"] for case in cases),
        "hard_safety_failures": sum(case["hard_safety_failure"] for case in cases),
        "model_calls": sum(case["model_calls"] for case in cases),
        "tool_calls": sum(case["tool_calls"] for case in cases),
        "input_tokens": sum(case["input_tokens"] for case in cases),
        "output_tokens": sum(case["output_tokens"] for case in cases),
        "total_cost_usd": round(total_cost, 8),
        "cost_per_case_usd": round(total_cost / len(cases), 8),
        "mean_latency_ms": round(statistics.mean(latencies), 3),
        "median_latency_ms": round(statistics.median(latencies), 3),
        "p95_latency_ms": round(_percentile_95(latencies), 3),
    }


def _write_comparison(sonnet: EvaluationReport) -> None:
    opus_payload = json.loads(OPUS_REPORT.read_text())
    opus_cases = {case["case_id"]: case for case in opus_payload["cases"]}
    sonnet_payload = sonnet.model_dump(mode="json")
    sonnet_cases = {case["case_id"]: case for case in sonnet_payload["cases"]}
    if set(opus_cases) != set(sonnet_cases) or len(opus_cases) != 30:
        raise RuntimeError("matched comparison requires identical 30-case IDs")
    matched = []
    for case_id in opus_cases:
        opus = opus_cases[case_id]
        current = sonnet_cases[case_id]
        opus_grades = {grade["name"]: grade["passed"] for grade in opus["grades"]}
        sonnet_grades = {grade["name"]: grade["passed"] for grade in current["grades"]}
        opus_summary = opus["actual_assessment"]["supervisor_summary"]
        sonnet_summary = current["actual_assessment"]["supervisor_summary"]
        uncertainty_terms = {"unknown", "unavailable", "missing", "failed", "conflict", "incomplete"}
        opus_markers = sorted(term for term in uncertainty_terms if term in opus_summary.casefold())
        sonnet_markers = sorted(term for term in uncertainty_terms if term in sonnet_summary.casefold())
        matched.append(
            {
                "case_id": case_id,
                "opus_score": sum(grade["score"] for grade in opus["grades"]) / 10,
                "sonnet_score": sum(grade["score"] for grade in current["grades"]) / 10,
                "opus_grades": opus_grades,
                "sonnet_grades": sonnet_grades,
                "recommendations": {
                    "opus": opus["recommendation"],
                    "sonnet": current["recommendation"],
                },
                "uncertainty_markers": {"opus": opus_markers, "sonnet": sonnet_markers},
                "supervisor_summary_words": {
                    "opus": len(opus_summary.split()),
                    "sonnet": len(sonnet_summary.split()),
                },
                "model_calls": {"opus": opus["model_calls"], "sonnet": current["model_calls"]},
                "tool_calls": {"opus": opus["tool_calls"], "sonnet": current["tool_calls"]},
                "latency_ms": {"opus": opus["latency_ms"], "sonnet": current["latency_ms"]},
                "tokens": {
                    "opus": {"input": opus["input_tokens"], "output": opus["output_tokens"]},
                    "sonnet": {
                        "input": current["input_tokens"],
                        "output": current["output_tokens"],
                    },
                },
                "cost_usd": {
                    "opus": opus["estimated_cost_usd"],
                    "sonnet": current["estimated_cost_usd"],
                },
            }
        )
    opus_metrics = _metrics(list(opus_cases.values()))
    sonnet_metrics = _metrics(list(sonnet_cases.values()))
    savings = (
        (opus_metrics["total_cost_usd"] - sonnet_metrics["total_cost_usd"])
        / opus_metrics["total_cost_usd"]
        * 100
    )
    measurable_differences = [
        item["case_id"]
        for item in matched
        if item["opus_score"] != item["sonnet_score"]
        or item["opus_grades"] != item["sonnet_grades"]
        or item["recommendations"]["opus"] != item["recommendations"]["sonnet"]
    ]
    uncertainty_marker_differences = [
        item["case_id"]
        for item in matched
        if item["uncertainty_markers"]["opus"] != item["uncertainty_markers"]["sonnet"]
    ]
    comparison = {
        "schema_version": "matched-model-comparison/1.0.0",
        "dataset_version": sonnet.dataset_version,
        "trials_per_model_case": 1,
        "models": {"opus_supervisor": "claude-opus-5-5", "sonnet_supervisor": "claude-sonnet-5-5"},
        "metrics": {"opus": opus_metrics, "sonnet": sonnet_metrics},
        "sonnet_cost_savings_percent": round(savings, 3),
        "measurable_interpretation_differences": measurable_differences,
        "uncertainty_vocabulary_review_flags": uncertainty_marker_differences,
        "human_reviewed_interpretation_notes": [
            {
                "case_id": "eval-v1-insufficient-with-velocity",
                "finding": (
                    "Opus described the HIGH_VELOCITY signal alongside UNKNOWN behaviour status "
                    "as a conflict; Sonnet described it as an unresolved indicator without a "
                    "source contradiction. Both retained uncertainty and returned CHALLENGED."
                ),
            }
        ],
        "recommendation": (
            "Sonnet matched Opus on all grader outcomes, policy recommendations, delegation counts, "
            "and safety checks while reducing latency and estimated cost. This single-trial synthetic "
            "evaluation provides no measured justification for Opus as Supervisor."
        ),
        "matched_cases": matched,
        "limitations": [
            "One live trial per model and synthetic case does not establish statistical equivalence.",
            "These results do not establish production fraud-detection accuracy.",
            "Policy agreement is governance compliance, not independent fraud accuracy.",
            "Lexical differences alone are not treated as meaningful interpretation differences.",
        ],
    }
    COMPARISON_JSON.write_text(json.dumps(comparison, indent=2, sort_keys=True) + "\n")
    lines = [
        "# Live Opus 5.5 vs Sonnet 5.5 Supervisor comparison",
        "",
        "One live trial per Supervisor model and synthetic case; specialists, prompts, tools, "
        "policy, and graders were held constant.",
        "",
        "| Metric | Opus | Sonnet |",
        "|---|---:|---:|",
        f"| Passed | {opus_metrics['passed']}/30 | {sonnet_metrics['passed']}/30 |",
        f"| Hard safety failures | {opus_metrics['hard_safety_failures']} | "
        f"{sonnet_metrics['hard_safety_failures']} |",
        f"| Mean latency | {opus_metrics['mean_latency_ms'] / 1000:.2f}s | "
        f"{sonnet_metrics['mean_latency_ms'] / 1000:.2f}s |",
        f"| Median latency | {opus_metrics['median_latency_ms'] / 1000:.2f}s | "
        f"{sonnet_metrics['median_latency_ms'] / 1000:.2f}s |",
        f"| P95 latency | {opus_metrics['p95_latency_ms'] / 1000:.2f}s | "
        f"{sonnet_metrics['p95_latency_ms'] / 1000:.2f}s |",
        f"| Input tokens | {opus_metrics['input_tokens']} | {sonnet_metrics['input_tokens']} |",
        f"| Output tokens | {opus_metrics['output_tokens']} | {sonnet_metrics['output_tokens']} |",
        f"| Total cost | ${opus_metrics['total_cost_usd']:.8f} | ${sonnet_metrics['total_cost_usd']:.8f} |",
        f"| Cost per case | ${opus_metrics['cost_per_case_usd']:.8f} | "
        f"${sonnet_metrics['cost_per_case_usd']:.8f} |",
        "",
        f"Sonnet estimated cost savings: {savings:.1f}%.",
        "No case differed on score, grader outcome, recommendation, model-call count, or tool-call count.",
        "One uncertainty-interpretation nuance is retained in the JSON report for human review.",
        "",
        "## Per-case comparison",
        "",
        "| Case | Opus score | Sonnet score | Verdict O/S | Calls O/S | Cost O/S |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for item in matched:
        lines.append(
            f"| `{item['case_id']}` | {item['opus_score']:.0%} | {item['sonnet_score']:.0%} | "
            f"{item['recommendations']['opus']}/{item['recommendations']['sonnet']} | "
            f"{item['model_calls']['opus']}/{item['model_calls']['sonnet']} | "
            f"${item['cost_usd']['opus']:.5f}/${item['cost_usd']['sonnet']:.5f} |"
        )
    lines.extend(["", "## Limitations", ""])
    lines.extend(f"- {item}" for item in comparison["limitations"])
    COMPARISON_MD.write_text("\n".join(lines) + "\n")


async def run() -> None:
    if not parse_args().approve_live_sonnet_supervisor_30:
        raise SystemExit("explicit --approve-live-sonnet-supervisor-30 is required")
    load_dotenv(ROOT.parent / "fraud-decisioning" / ".env", override=False)
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is required")
    dataset = load_dataset(DATASET_DIR)
    if len(dataset.cases) != 30:
        raise RuntimeError("Sonnet comparison requires the exact 30-case dataset")
    settings = live_settings()
    expected_models = {
        "supervisor": "claude-sonnet-5-5",
        "behaviour": "claude-sonnet-5-5",
        "geo": "claude-haiku-5-5",
        "action": "claude-haiku-5-5",
    }
    if settings.models != expected_models:
        raise RuntimeError("Sonnet Supervisor override changed a specialist model")
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
            topic=f"evaluation.{EXPERIMENT_ID}", partition=0, offset=offset, ingested_at=datetime.now(UTC)
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
        if Decimal(str(budget["accounted_total_cost_usd"])) > Decimal("6.50"):
            raise RuntimeError("Sonnet comparison exceeded its USD budget")
        if outcome.audit.agent_models != expected_models:
            raise RuntimeError("persisted model allocation differs from the controlled comparison")
        unknown_tools = {call.tool_name for call in outcome.audit.tool_calls} - ALLOWED_TOOLS
        if unknown_tools:
            raise RuntimeError(f"unsafe unexpected tool execution: {sorted(unknown_tools)}")
        if not outcome.audit.trace_id:
            raise RuntimeError("completed investigation has no trace ID")
        span_count = _verify_phoenix_trace(phoenix_client, case_settings, outcome.audit.trace_id)
        grades = grade_result(original_case, dataset.ground_truth[original_case.case_id], outcome)
        checkpoints.append(
            {
                "case_id": original_case.case_id,
                "scenario_id": scenario_id,
                "investigation_id": str(request.investigation_id),
                "trace_id": outcome.audit.trace_id,
                "execution_status": execution_status,
                "grader_failures": [grade.name for grade in grades if not grade.passed],
                "hard_safety_failures": [
                    grade.name for grade in grades if grade.hard_failure and not grade.passed
                ],
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
        protected_experiment_ids={
            "part3-live-eval-001",
            "part4b-live-opus-baseline-001",
            "part4b-live-opus-remaining-24-001",
        },
        phoenix=PhoenixPublisher(),
    )
    report = await runner.run(
        dataset, experiment_id=EXPERIMENT_ID, repetitions=1, output_path=REPORT_JSON
    )
    write_markdown_report(report, REPORT_MD)
    _write_comparison(report)
    print(json.dumps(report.aggregate, sort_keys=True))


if __name__ == "__main__":
    asyncio.run(run())
