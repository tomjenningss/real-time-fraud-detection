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
REPORT_JSON = ROOT / "evaluation" / "reports" / "live-opus-baseline-v1.json"
REPORT_MD = ROOT / "evaluation" / "reports" / "live-opus-baseline-v1.md"
CHECKPOINT = ROOT / "evaluation" / "reports" / "live-opus-baseline-v1.checkpoint.json"
EXPERIMENT_ID = "part4b-live-opus-baseline-001"
SELECTED_CASES = (
    "eval-v1-suspicious-combined",
    "eval-v1-geo-combined",
    "eval-v1-history-missing",
    "eval-v1-history-unknown",
    "eval-v1-history-conflicting",
    "eval-v1-injection-fake-tool",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the approved six-case live Opus pilot")
    parser.add_argument("--approve-six-case-live-pilot", action="store_true")
    return parser.parse_args()


def selected_dataset() -> EvaluationDataset:
    dataset = load_dataset(DATASET_DIR)
    by_id = {case.case_id: case for case in dataset.cases}
    cases = [by_id[case_id] for case_id in SELECTED_CASES]
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
            "live_budget_usd": 2.0,
            "live_baseline_cost_usd": 0.0,
            "live_max_investigations": 6,
            "live_investigation_reserve_usd": 0.20,
            "live_max_model_calls": 12,
            "otel_enabled": True,
            "otel_capture_synthetic_content": False,
        }
    )


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
            any("supervisor agent" == name for name in names)
            and any(name.startswith("anthropic.messages") for name in names)
            and any(name.startswith("tool ") for name in names)
        ):
            return len(spans)
        time.sleep(0.25)
    raise RuntimeError("Phoenix trace is missing agent, model, or tool spans")


def _resume_disposition(state: dict[str, object] | None) -> str:
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


async def run() -> None:
    args = parse_args()
    if not args.approve_six_case_live_pilot:
        raise SystemExit("explicit --approve-six-case-live-pilot is required")
    load_dotenv(ROOT.parent / "fraud-decisioning" / ".env", override=False)
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is required")

    dataset = selected_dataset()
    settings = live_settings()
    store = FraudStore(database_url)
    phoenix_client = Client(base_url="http://127.0.0.1:6006")
    checkpoints: list[dict[str, object]] = []

    budget = store.live_budget_status(EXPERIMENT_ID)
    if budget["investigation_count"] != 1:
        raise RuntimeError("resume requires exactly one existing pilot allocation")
    if Decimal(str(budget["accounted_total_cost_usd"])) != Decimal("0.03763200"):
        raise RuntimeError("existing pilot cost does not match the settled first case")

    async def execute(
        base_settings: Settings,
        original_case: EvaluationCase,
        _suggested_investigation_id,
        scenario_id: str,
    ):
        case = _case_for_experiment(original_case, scenario_id)
        case_settings = base_settings.model_copy(update={"evaluation_scenario_id": scenario_id})
        offset = SELECTED_CASES.index(original_case.case_id)
        source = SourcePosition(
            topic=f"evaluation.{EXPERIMENT_ID}",
            partition=0,
            offset=offset,
            ingested_at=datetime.now(UTC),
        )
        now = datetime.now(UTC)
        decision, request = build_decision(
            case.input.flink,
            decide(case.input.flink, sample_normal=True),
            source,
            now,
            now,
        )
        if request is None:
            raise RuntimeError("selected evaluation case was not routed")
        resume_state = store.inspect_live_investigation(request.investigation_id)
        disposition = _resume_disposition(resume_state)
        if disposition == "REUSE_COMPLETED":
            outcome = store.load_completed_result(request.investigation_id)
            ledger = store.verify_live_investigation(request.investigation_id, EXPERIMENT_ID)
            if not outcome.audit.trace_id:
                raise RuntimeError("completed investigation has no trace ID")
            span_count = _verify_phoenix_trace(
                phoenix_client, case_settings, outcome.audit.trace_id
            )
            grades = grade_result(
                original_case, dataset.ground_truth[original_case.case_id], outcome
            )
            if any(not grade.passed and grade.hard_failure for grade in grades):
                raise RuntimeError("reused investigation has a hard safety grader failure")
            checkpoints.append(
                {
                    "case_id": original_case.case_id,
                    "scenario_id": scenario_id,
                    "investigation_id": str(request.investigation_id),
                    "trace_id": outcome.audit.trace_id,
                    "execution_status": "reused_completed",
                    "ledger": {key: str(value) for key, value in ledger.items()},
                    "budget_accounted_total_cost_usd": str(
                        store.live_budget_status(EXPERIMENT_ID)["accounted_total_cost_usd"]
                    ),
                    "phoenix_span_count": span_count,
                }
            )
            CHECKPOINT.write_text(json.dumps(checkpoints, indent=2) + "\n")
            return LiveCaseExecution(outcome=outcome, reused=True)
        if disposition != "NEW":
            raise RuntimeError(
                f"live investigation cannot be resumed automatically: {disposition}"
            )
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
        ledger = store.verify_live_investigation(request.investigation_id, EXPERIMENT_ID)
        budget = store.live_budget_status(EXPERIMENT_ID)
        if Decimal(str(budget["accounted_total_cost_usd"])) > Decimal("2.00"):
            raise RuntimeError("live pilot exceeded its USD budget")
        if not outcome.audit.trace_id:
            raise RuntimeError("completed investigation has no trace ID")
        span_count = _verify_phoenix_trace(phoenix_client, case_settings, outcome.audit.trace_id)
        grades = grade_result(original_case, dataset.ground_truth[original_case.case_id], outcome)
        if any(not grade.passed and grade.hard_failure for grade in grades):
            raise RuntimeError("hard safety grader failed; live pilot stopped")
        checkpoints.append(
            {
                "case_id": original_case.case_id,
                "scenario_id": scenario_id,
                "investigation_id": str(request.investigation_id),
                "trace_id": outcome.audit.trace_id,
                "execution_status": "executed",
                "ledger": {key: str(value) for key, value in ledger.items()},
                "budget_accounted_total_cost_usd": str(budget["accounted_total_cost_usd"]),
                "phoenix_span_count": span_count,
            }
        )
        CHECKPOINT.write_text(json.dumps(checkpoints, indent=2) + "\n")
        return LiveCaseExecution(outcome=outcome)

    runner = EvaluationRunner(
        settings,
        mode=EvaluationMode.LIVE,
        live_authorized=True,
        live_case_executor=execute,
        protected_experiment_ids={"part3-live-eval-001"},
        phoenix=PhoenixPublisher(),
    )
    report = await runner.run(
        dataset,
        experiment_id=EXPERIMENT_ID,
        repetitions=1,
        output_path=REPORT_JSON,
    )
    write_markdown_report(report, REPORT_MD)
    print(json.dumps(report.aggregate, sort_keys=True))


if __name__ == "__main__":
    asyncio.run(run())
