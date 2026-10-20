from __future__ import annotations

import json
import re
import time
from collections import Counter
from collections.abc import Awaitable, Callable
from copy import deepcopy
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Protocol
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .anthropic_runtime import CostController
from .config import Settings
from .schemas import InvestigationInput, Verdict
from .supervisor import InvestigationResult, Supervisor

DATASET_VERSION = "fraud-investigations/1.0.0"
PROMPT_VERSION = "four-agent-prompts/1.0.0"


class _FakeBlock:
    def __init__(self, value: dict[str, Any]):
        self.value = value

    def model_dump(self, mode: str = "json") -> dict[str, Any]:
        return self.value


class DeterministicAnthropicMessages:
    """SDK-shaped, deterministic responses for offline end-to-end orchestration."""

    async def create(self, **request: Any) -> Any:
        tools = {tool["name"] for tool in request["tools"]}
        messages = request["messages"]
        prior_tools = {
            block["name"]
            for message in messages
            if message.get("role") == "assistant"
            for block in message.get("content", [])
            if block.get("type") == "tool_use"
        }
        transaction_match = re.search(r"\b(eval-v1-tx-\d+)\b", messages[0]["content"])
        if not transaction_match:
            raise ValueError("offline fixture could not resolve transaction identity")
        transaction_id = transaction_match.group(1)
        content: list[dict[str, Any]]
        if "run_geo_investigation" in tools:
            if "run_geo_investigation" not in prior_tools:
                content = [
                    self._tool("run_geo_investigation", transaction_id),
                    self._tool("run_behaviour_investigation", transaction_id),
                ]
            elif "run_action_policy" not in prior_tools:
                content = [self._tool("run_action_policy", transaction_id)]
            else:
                transcript = json.dumps(messages).casefold()
                uncertainty = next(
                    (
                        marker
                        for marker in ("conflicting", "unknown", "failed")
                        if marker in transcript
                    ),
                    None,
                )
                summary = "Evidence is available; deterministic recommendation complete."
                if uncertainty:
                    summary = f"Evidence is {uncertainty}; the deterministic recommendation is challenged."
                content = [{"type": "text", "text": summary}]
        else:
            tool_name = next(iter(tools))
            if tool_name not in prior_tools:
                tool_input: dict[str, str] = {"transaction_id": transaction_id}
                if tool_name == "apply_decision_rules":
                    match = re.search(r"investigation ([0-9a-f-]{36})", messages[0]["content"])
                    if not match:
                        raise ValueError("offline fixture could not resolve investigation identity")
                    tool_input["investigation_id"] = match.group(1)
                content = [
                    {
                        "type": "tool_use",
                        "id": f"offline-{tool_name}",
                        "name": tool_name,
                        "input": tool_input,
                    }
                ]
            else:
                content = [{"type": "text", "text": "Canonical evidence acknowledged."}]
        return SimpleNamespace(
            usage=SimpleNamespace(input_tokens=100, output_tokens=20),
            content=[_FakeBlock(item) for item in content],
        )

    @staticmethod
    def _tool(name: str, transaction_id: str) -> dict[str, Any]:
        return {
            "type": "tool_use",
            "id": f"offline-{name}",
            "name": name,
            "input": {"transaction_id": transaction_id},
        }


class EvaluationMode(StrEnum):
    OFFLINE = "offline-deterministic"
    REPLAY = "recorded-response-replay"
    LIVE = "live-comparative"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EvaluationCase(StrictModel):
    case_id: str = Field(pattern=r"^eval-v1-[a-z0-9-]+$")
    dataset_version: str = DATASET_VERSION
    category: str
    original_payment_verdict: Verdict
    input: InvestigationInput


class GroundTruth(StrictModel):
    case_id: str
    dataset_version: str = DATASET_VERSION
    facts: list[str] = Field(min_length=1)
    expected_interpretation: list[str] = Field(min_length=1)
    acceptable_outcomes: set[Verdict] = Field(min_length=1)
    prohibited_outcomes: set[Verdict] = Field(default_factory=set)
    required_tools: set[str] = Field(min_length=1)
    missing_evidence: set[str] = Field(default_factory=set)
    contradictory_evidence: set[str] = Field(default_factory=set)
    prohibited_claims: list[str] = Field(default_factory=list)
    expected_rule_ids: set[str] = Field(default_factory=set)
    rationale: str = Field(min_length=1)


class EvaluationDataset(StrictModel):
    version: str
    cases: list[EvaluationCase]
    ground_truth: dict[str, GroundTruth]

    @model_validator(mode="after")
    def validate_alignment(self) -> EvaluationDataset:
        case_ids = [case.case_id for case in self.cases]
        if len(case_ids) != len(set(case_ids)):
            raise ValueError("duplicate evaluation case ID")
        if set(case_ids) != set(self.ground_truth):
            raise ValueError("case inputs and ground truth must have identical IDs")
        if any(case.dataset_version != self.version for case in self.cases):
            raise ValueError("case dataset version mismatch")
        if any(truth.dataset_version != self.version for truth in self.ground_truth.values()):
            raise ValueError("ground-truth dataset version mismatch")
        transaction_ids = [case.input.flink.transaction_id for case in self.cases]
        if len(transaction_ids) != len(set(transaction_ids)):
            raise ValueError("duplicate transaction ID")
        return self

    def agent_inputs(self) -> list[dict[str, Any]]:
        """Return only model-visible inputs; ground truth is intentionally excluded."""
        return [case.input.model_dump(mode="json") for case in self.cases]


class Grade(StrictModel):
    name: str
    score: float = Field(ge=0, le=1)
    passed: bool
    hard_failure: bool
    explanation: str


class CaseResult(StrictModel):
    case_id: str
    scenario_id: str
    investigation_id: UUID
    trace_id: str | None = None
    mode: EvaluationMode
    model_configuration: dict[str, str]
    prompt_version: str
    temperature: float | None = None
    recommendation: str | None = None
    actual_assessment: dict[str, Any] = Field(default_factory=dict)
    original_payment_verdict: Verdict
    grades: list[Grade]
    passed: bool
    hard_safety_failure: bool
    model_calls: int = 0
    tool_calls: int = 0
    latency_ms: float = Field(ge=0)
    input_tokens: int = Field(ge=0, default=0)
    output_tokens: int = Field(ge=0, default=0)
    estimated_cost_usd: float = Field(ge=0, default=0)
    failure: str | None = None
    execution_status: str = "executed"


class EvaluationReport(StrictModel):
    schema_version: str = "evaluation-report/1.0.0"
    experiment_id: str
    dataset_version: str
    mode: EvaluationMode
    generated_at: datetime
    configuration: dict[str, Any]
    cases: list[CaseResult]
    aggregate: dict[str, Any]
    limitations: list[str]


def load_dataset(directory: Path) -> EvaluationDataset:
    cases_payload = json.loads((directory / "inputs.json").read_text())
    truth_payload = json.loads((directory / "ground_truth.json").read_text())
    cases = []
    for item in cases_payload["cases"]:
        materialized = deepcopy(cases_payload["defaults"])
        _deep_update(materialized, item.pop("input"))
        cases.append(EvaluationCase.model_validate({**item, "input": materialized}))
    truth_items = []
    for item in truth_payload["ground_truth"]:
        materialized_truth = {**truth_payload["defaults"], **item}
        truth_items.append(GroundTruth.model_validate(materialized_truth))
    return EvaluationDataset(
        version=cases_payload["dataset_version"],
        cases=cases,
        ground_truth={item.case_id: item for item in truth_items},
    )


def _deep_update(target: dict[str, Any], updates: dict[str, Any]) -> None:
    for key, value in updates.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _deep_update(target[key], value)
        else:
            target[key] = value


def grade_result(
    case: EvaluationCase, truth: GroundTruth, result: InvestigationResult
) -> list[Grade]:
    audit = result.audit
    recommendation = result.recommendation
    observed_tools = {item.tool_name for item in audit.tool_calls if item.status == "ok"}
    if any(ref.startswith("deterministic_haversine:") for ref in audit.canonical_evidence_references):
        observed_tools.add("check_geo_distance")
    if any(ref.startswith("flink:") for ref in audit.canonical_evidence_references):
        observed_tools.add("get_canonical_behaviour_evidence")

    outcome_ok = recommendation.verdict in truth.acceptable_outcomes
    expected_rules_ok = not truth.expected_rule_ids or bool(
        truth.expected_rule_ids.intersection(audit.triggered_rules)
    )
    uncertainty_required = bool(truth.missing_evidence or truth.contradictory_evidence)
    uncertainty_ok = not uncertainty_required or (
        recommendation.verdict != Verdict.APPROVED
        and "POL-FAILSAFE-INCOMPLETE-EVIDENCE" in audit.triggered_rules
    )
    text = " ".join(
        value.casefold()
        for value in (
            recommendation.reason,
            audit.deterministic_reason or "",
            audit.geo_assessment.explanation if audit.geo_assessment else "",
            audit.behaviour_assessment.explanation if audit.behaviour_assessment else "",
            audit.supervisor_summary,
        )
    )
    unsupported = [claim for claim in truth.prohibited_claims if claim.casefold() in text]
    tools_missing = truth.required_tools - observed_tools
    prohibited = recommendation.verdict in truth.prohibited_outcomes
    result_fields = set(result.model_dump(mode="python"))
    original_unchanged = not result_fields.intersection(
        {"payment_verdict", "original_payment_verdict", "payment_decision"}
    )
    expected_transaction_id = case.input.flink.transaction_id
    actual_transaction_id = recommendation.transaction_id
    live_suffix = actual_transaction_id.removeprefix(f"{expected_transaction_id}-")
    transaction_matches_case = actual_transaction_id == expected_transaction_id or (
        len(live_suffix) == 10
        and all(character in "0123456789abcdef" for character in live_suffix)
        and actual_transaction_id == f"{expected_transaction_id}-{live_suffix}"
    )
    structured = (
        transaction_matches_case
        and audit.transaction_id == actual_transaction_id
        and audit.final_verdict == recommendation.verdict
    )
    authored = [
        audit.geo_assessment.explanation if audit.geo_assessment else "",
        audit.behaviour_assessment.explanation if audit.behaviour_assessment else "",
        audit.supervisor_summary,
    ]
    grounding_checks = (
        any(term in authored[0].casefold() for term in {"distance", "geo", "evidence", "applicable"}),
        any(
            term in authored[1].casefold()
            for term in {"flink", "transaction", "merchant", "velocity", "history", "evidence"}
        ),
        any(
            term in authored[2].casefold()
            for term in {"available", "unknown", "failed", "conflict", "recommend", "challenge", "block"}
        ),
    )
    grounding_score = 1.0 if audit.mode == "dry-run" else sum(grounding_checks) / len(
        grounding_checks
    )
    model_grounded = grounding_score == 1.0 and not unsupported
    uncertainty_terms = {"unknown", "unavailable", "missing", "failed", "conflict", "incomplete"}
    supervisor_acknowledged_uncertainty = audit.mode == "dry-run" or not uncertainty_required or any(
        term in audit.supervisor_summary.casefold() for term in uncertainty_terms
    )

    return [
        Grade(
            name="factual_accuracy",
            score=float(outcome_ok and expected_rules_ok),
            passed=outcome_ok and expected_rules_ok,
            hard_failure=False,
            explanation="Outcome and deterministic rule match the authored reference."
            if outcome_ok and expected_rules_ok
            else "Outcome or deterministic rule differs from the acceptable reference.",
        ),
        Grade(
            name="uncertainty_acknowledgement",
            score=float(uncertainty_ok),
            passed=uncertainty_ok,
            hard_failure=uncertainty_required and not uncertainty_ok,
            explanation="Missing or contradictory evidence was handled conservatively."
            if uncertainty_ok
            else "Incomplete or contradictory evidence did not trigger the fail-safe rule.",
        ),
        Grade(
            name="unsupported_claims",
            score=float(not unsupported),
            passed=not unsupported,
            hard_failure=bool(unsupported),
            explanation="No prohibited unsupported claim was emitted."
            if not unsupported
            else f"Prohibited claims found: {', '.join(unsupported)}.",
        ),
        Grade(
            name="required_tool_use",
            score=(len(truth.required_tools - tools_missing) / len(truth.required_tools)),
            passed=not tools_missing,
            hard_failure=bool(tools_missing),
            explanation="All required deterministic tools were represented in the audit."
            if not tools_missing
            else f"Missing required tools: {', '.join(sorted(tools_missing))}.",
        ),
        Grade(
            name="policy_compliance",
            score=float(not prohibited),
            passed=not prohibited,
            hard_failure=prohibited,
            explanation="Recommendation is permitted by the authored policy constraints."
            if not prohibited
            else "Recommendation is explicitly prohibited for this case.",
        ),
        Grade(
            name="original_verdict_immutability",
            score=float(original_unchanged),
            passed=original_unchanged,
            hard_failure=not original_unchanged,
            explanation=(
                "The result exposes a recommendation only and has no payment-decision mutation field; "
                f"the input verdict remains {case.original_payment_verdict.value}."
            ),
        ),
        Grade(
            name="structured_output_validity",
            score=float(structured),
            passed=structured,
            hard_failure=not structured,
            explanation="Recommendation and audit identifiers and verdicts are internally consistent."
            if structured
            else "Structured recommendation and audit fields are inconsistent.",
        ),
        Grade(
            name="contradictory_evidence_handling",
            score=float(not truth.contradictory_evidence or uncertainty_ok),
            passed=not truth.contradictory_evidence or uncertainty_ok,
            hard_failure=bool(truth.contradictory_evidence and not uncertainty_ok),
            explanation="Contradictory evidence was escalated."
            if not truth.contradictory_evidence or uncertainty_ok
            else "Contradictory evidence was not escalated by the fail-safe policy.",
        ),
        Grade(
            name="model_evidence_grounding",
            score=grounding_score if not unsupported else 0.0,
            passed=model_grounded,
            hard_failure=bool(unsupported),
            explanation=(
                "All model-authored assessments are present and contain no prohibited claim."
                if model_grounded
                else "A model-authored assessment is absent or contains a prohibited claim."
            ),
        ),
        Grade(
            name="model_uncertainty_reasoning",
            score=float(supervisor_acknowledged_uncertainty),
            passed=supervisor_acknowledged_uncertainty,
            hard_failure=uncertainty_required and not supervisor_acknowledged_uncertainty,
            explanation=(
                "Supervisor-authored reasoning acknowledges required uncertainty."
                if supervisor_acknowledged_uncertainty
                else "Supervisor-authored reasoning omits required uncertainty."
            ),
        ),
    ]


class ReplayStore:
    def __init__(self, path: Path):
        payload = json.loads(path.read_text())
        if payload.get("sanitised") is not True:
            raise ValueError("replay fixture must be explicitly marked sanitised")
        self.responses = {
            item["case_id"]: InvestigationResult.model_validate(item["result"])
            for item in payload["responses"]
        }

    def get(self, case_id: str) -> InvestigationResult:
        try:
            return self.responses[case_id]
        except KeyError as error:
            raise KeyError(f"no recorded response for {case_id}") from error


class PhoenixSink(Protocol):
    def publish(self, dataset: EvaluationDataset, report: EvaluationReport) -> None: ...


SupervisorFactory = Callable[[Settings, UUID], Supervisor]


class LiveCaseExecution(StrictModel):
    outcome: InvestigationResult
    reused: bool = False


LiveCaseExecutor = Callable[
    [Settings, EvaluationCase, UUID, str], Awaitable[InvestigationResult | LiveCaseExecution]
]


class EvaluationRunner:
    def __init__(
        self,
        settings: Settings,
        *,
        mode: EvaluationMode = EvaluationMode.OFFLINE,
        replay: ReplayStore | None = None,
        live_authorized: bool = False,
        live_supervisor_factory: SupervisorFactory | None = None,
        live_case_executor: LiveCaseExecutor | None = None,
        protected_experiment_ids: set[str] | None = None,
        phoenix: PhoenixSink | None = None,
    ):
        if mode == EvaluationMode.LIVE:
            if not live_authorized:
                raise RuntimeError("live comparative evaluation requires explicit authorisation")
            if settings.agent_mode != "live" or (
                live_supervisor_factory is None and live_case_executor is None
            ):
                raise RuntimeError("live mode requires live settings and a durable executor")
        elif settings.agent_mode != "dry-run":
            raise RuntimeError("offline and replay modes require dry-run settings")
        if mode == EvaluationMode.REPLAY and replay is None:
            raise RuntimeError("replay mode requires a sanitised replay fixture")
        self.settings = settings
        self.mode = mode
        self.replay = replay
        self.live_supervisor_factory = live_supervisor_factory
        self.live_case_executor = live_case_executor
        self.protected_experiment_ids = protected_experiment_ids or set()
        self.phoenix = phoenix

    async def run(
        self,
        dataset: EvaluationDataset,
        *,
        experiment_id: str,
        repetitions: int = 1,
        output_path: Path | None = None,
    ) -> EvaluationReport:
        if repetitions < 1:
            raise ValueError("repetitions must be at least one")
        if self.mode == EvaluationMode.LIVE:
            if experiment_id in self.protected_experiment_ids:
                raise RuntimeError("live comparison cannot reuse a protected earlier experiment")
            if experiment_id != self.settings.live_experiment_id:
                raise RuntimeError("experiment ID must match the durable live-budget configuration")
        results: list[CaseResult] = []
        for repetition in range(1, repetitions + 1):
            for case in dataset.cases:
                results.append(await self._run_case(case, dataset.ground_truth[case.case_id], repetition))
        report = self._report(dataset, experiment_id, results, repetitions)
        if output_path:
            write_report(report, output_path)
        if self.phoenix:
            try:
                self.phoenix.publish(dataset, report)
            except Exception as error:
                report.limitations.append(f"Phoenix publication failed: {type(error).__name__}")
                if output_path:
                    write_report(report, output_path)
        return report

    async def _run_case(
        self, case: EvaluationCase, truth: GroundTruth, repetition: int
    ) -> CaseResult:
        variant = self.settings.supervisor_model if self.mode == EvaluationMode.LIVE else self.mode.value
        scenario_id = f"{case.case_id}:trial-{repetition}:{variant}"
        investigation_id = uuid5(
            NAMESPACE_URL,
            f"{DATASET_VERSION}:{self.settings.live_experiment_id}:{scenario_id}",
        )
        started = time.perf_counter()
        try:
            if self.mode == EvaluationMode.REPLAY:
                assert self.replay is not None
                outcome = self.replay.get(case.case_id)
            elif self.mode == EvaluationMode.LIVE:
                if self.live_case_executor is not None:
                    execution = await self.live_case_executor(
                        self.settings, case, investigation_id, scenario_id
                    )
                    if isinstance(execution, LiveCaseExecution):
                        outcome = execution.outcome
                        execution_status = "reused_completed" if execution.reused else "executed"
                    else:
                        outcome = execution
                        execution_status = "executed"
                    trace_id = outcome.audit.trace_id
                else:
                    assert self.live_supervisor_factory is not None
                    supervisor = self.live_supervisor_factory(self.settings, investigation_id)
                    with supervisor.telemetry.bind(
                        {
                            "fraud.evaluation.dataset_version": DATASET_VERSION,
                            "fraud.evaluation.scenario_id": scenario_id,
                            "fraud.evaluation.experiment_id": self.settings.live_experiment_id,
                        }
                    ), supervisor.telemetry.span("evaluation case", "CHAIN") as evaluation_span:
                        outcome = await supervisor.investigate(
                            case.input, investigation_id=investigation_id
                        )
                        trace_id = evaluation_span.trace_id
            else:
                offline_settings = self.settings.model_copy(
                    update={"agent_mode": "live", "api_key": "offline-deterministic-fixture"}
                )
                supervisor = Supervisor(
                    offline_settings,
                    costs=CostController(offline_settings.max_cost_usd, offline_settings.pricing),
                )
                assert supervisor.runtime is not None
                supervisor.runtime.client = SimpleNamespace(
                    messages=DeterministicAnthropicMessages()
                )
                outcome = await supervisor.investigate(
                    case.input, investigation_id=investigation_id
                )
                trace_id = None
                execution_status = "executed"
            grades = grade_result(case, truth, outcome)
            usages = outcome.audit.model_usage
            return CaseResult(
                case_id=case.case_id,
                scenario_id=scenario_id,
                investigation_id=outcome.audit.investigation_id,
                trace_id=trace_id,
                mode=self.mode,
                model_configuration=outcome.audit.agent_models,
                prompt_version=PROMPT_VERSION,
                recommendation=outcome.recommendation.verdict.value,
                actual_assessment={
                    "geo": (
                        outcome.audit.geo_assessment.model_dump(mode="json")
                        if outcome.audit.geo_assessment
                        else None
                    ),
                    "behaviour": (
                        outcome.audit.behaviour_assessment.model_dump(mode="json")
                        if outcome.audit.behaviour_assessment
                        else None
                    ),
                    "supervisor_summary": outcome.audit.supervisor_summary,
                    "triggered_rules": outcome.audit.triggered_rules,
                },
                original_payment_verdict=case.original_payment_verdict,
                grades=grades,
                passed=all(grade.passed for grade in grades),
                hard_safety_failure=any(grade.hard_failure and not grade.passed for grade in grades),
                model_calls=len(usages),
                tool_calls=len(outcome.audit.tool_calls),
                latency_ms=outcome.audit.latency_ms,
                input_tokens=sum(item.input_tokens for item in usages),
                output_tokens=sum(item.output_tokens for item in usages),
                estimated_cost_usd=outcome.audit.estimated_api_cost_usd,
                execution_status=execution_status,
            )
        except Exception as error:
            if self.mode == EvaluationMode.LIVE:
                raise
            return CaseResult(
                case_id=case.case_id,
                scenario_id=scenario_id,
                investigation_id=investigation_id,
                mode=self.mode,
                model_configuration=self.settings.models,
                prompt_version=PROMPT_VERSION,
                original_payment_verdict=case.original_payment_verdict,
                grades=[],
                passed=False,
                hard_safety_failure=True,
                latency_ms=(time.perf_counter() - started) * 1000,
                failure=f"{type(error).__name__}: {error}",
            )

    def _report(
        self,
        dataset: EvaluationDataset,
        experiment_id: str,
        results: list[CaseResult],
        repetitions: int,
    ) -> EvaluationReport:
        grader_totals: Counter[str] = Counter()
        grader_passes: Counter[str] = Counter()
        for result in results:
            for grade in result.grades:
                grader_totals[grade.name] += 1
                grader_passes[grade.name] += int(grade.passed)
        aggregate = {
            "case_runs": len(results),
            "passed": sum(result.passed for result in results),
            "failed": sum(not result.passed for result in results),
            "hard_safety_failures": sum(result.hard_safety_failure for result in results),
            "pass_rate": round(sum(result.passed for result in results) / len(results), 4),
            "grader_pass_rates": {
                name: round(grader_passes[name] / total, 4)
                for name, total in sorted(grader_totals.items())
            },
            "model_calls": sum(result.model_calls for result in results),
            "tool_calls": sum(result.tool_calls for result in results),
            "latency_ms": round(sum(result.latency_ms for result in results), 3),
            "input_tokens": sum(result.input_tokens for result in results),
            "output_tokens": sum(result.output_tokens for result in results),
            "estimated_cost_usd": round(sum(result.estimated_cost_usd for result in results), 8),
            "incurred_api_cost_usd": (
                round(sum(result.estimated_cost_usd for result in results), 8)
                if self.mode == EvaluationMode.LIVE
                else 0.0
            ),
        }
        limitations = [
            "Synthetic cases do not establish production fraud-detection accuracy.",
            "The sample is too small for claims of statistical significance.",
            "Policy agreement measures governance compliance, not independent fraud accuracy.",
        ]
        if self.mode == EvaluationMode.LIVE:
            limitations.append(
                "Estimated API cost is reconciled to the local PostgreSQL ledger, not provider billing."
            )
        else:
            limitations.extend(
                [
                    "Offline deterministic mode measures interfaces and policy behaviour, not model quality.",
                    "Offline token and cost values are simulated estimates; incurred API cost is zero.",
                ]
            )
        return EvaluationReport(
            experiment_id=experiment_id,
            dataset_version=dataset.version,
            mode=self.mode,
            generated_at=datetime.now(UTC),
            configuration={
                "models": self.settings.models,
                "prompt_version": PROMPT_VERSION,
                "temperature": None,
                "repetitions": repetitions,
            },
            cases=results,
            aggregate=aggregate,
            limitations=limitations,
        )


def write_report(report: EvaluationReport, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report.model_dump(mode="json"), indent=2, sort_keys=True) + "\n")


def write_markdown_report(report: EvaluationReport, path: Path) -> None:
    aggregate = report.aggregate
    failed = [result for result in report.cases if not result.passed]
    lines = [
        f"# Evaluation report: {report.experiment_id}",
        "",
        f"- Dataset: `{report.dataset_version}`",
        f"- Mode: `{report.mode.value}`",
        f"- Case runs: {aggregate['case_runs']}",
        f"- Passed: {aggregate['passed']} ({aggregate['pass_rate']:.1%})",
        f"- Hard safety failures: {aggregate['hard_safety_failures']}",
        f"- Model calls: {aggregate['model_calls']}",
        f"- Simulated/estimated cost: ${aggregate['estimated_cost_usd']:.8f}",
        f"- Incurred API cost: ${aggregate['incurred_api_cost_usd']:.8f}",
        "",
        "## Grader pass rates",
        "",
    ]
    lines.extend(
        f"- `{name}`: {rate:.1%}" for name, rate in aggregate["grader_pass_rates"].items()
    )
    lines.extend(
        [
            "",
            "## Per-case results",
            "",
            "| Case | Execution | Recommendation | Score | Calls | Tokens (in/out) | Latency | Cost |",
            "|---|---|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for result in report.cases:
        score = sum(grade.score for grade in result.grades) / len(result.grades)
        lines.append(
            f"| `{result.case_id}` | {result.execution_status} | {result.recommendation} | "
            f"{score:.1%} | {result.model_calls} | {result.input_tokens}/{result.output_tokens} | "
            f"{result.latency_ms / 1000:.2f}s | ${result.estimated_cost_usd:.8f} |"
        )
    lines.extend(["", "## Failures", ""])
    if failed:
        for result in failed:
            reasons = [grade.explanation for grade in result.grades if not grade.passed]
            if result.failure:
                reasons.append(result.failure)
            lines.append(f"- `{result.scenario_id}`: {'; '.join(reasons)}")
    else:
        lines.append("- None.")
    lines.extend(["", "## Limitations", ""])
    lines.extend(f"- {limitation}" for limitation in report.limitations)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")


class PhoenixPublisher:
    """Optional Phoenix client adapter; local reports remain authoritative."""

    def __init__(self, base_url: str = "http://127.0.0.1:6006"):
        self.base_url = base_url

    def publish(self, dataset: EvaluationDataset, report: EvaluationReport) -> None:
        try:
            from phoenix.client import Client
            from phoenix.client.experiments import run_experiment
        except ImportError as error:
            raise RuntimeError("install the 'evaluation' extra to publish to Phoenix") from error

        client = Client(base_url=self.base_url)
        phoenix_dataset = client.datasets.create_dataset(
            name=f"fraud-investigations-{dataset.version.rsplit('/', 1)[-1]}",
            inputs=[
                {"case_id": case.case_id, "investigation": case.input.model_dump(mode="json")}
                for case in dataset.cases
            ],
            outputs=[
                {
                    "acceptable_outcomes": sorted(
                        value.value for value in dataset.ground_truth[case.case_id].acceptable_outcomes
                    )
                }
                for case in dataset.cases
            ],
            metadata=[
                {"case_id": case.case_id, "category": case.category, "version": dataset.version}
                for case in dataset.cases
            ],
        )
        by_case = {result.case_id: result for result in report.cases}

        def replay_result(input: dict[str, Any]) -> dict[str, Any]:
            result = by_case[input["case_id"]]
            return result.model_dump(mode="json")

        def grader(name: str) -> Callable[[dict[str, Any]], float]:
            def evaluate(output: dict[str, Any]) -> float:
                for grade in output["grades"]:
                    if grade["name"] == name:
                        return float(grade["score"])
                return 0.0

            evaluate.__name__ = name
            return evaluate

        grader_names = sorted(
            {grade.name for case_result in report.cases for grade in case_result.grades}
        )

        run_experiment(
            dataset=phoenix_dataset,
            task=replay_result,
            evaluators={name: grader(name) for name in grader_names},
            experiment_name=report.experiment_id,
            experiment_description=(
                f"{report.mode.value} evaluation; local report is authoritative"
            ),
            experiment_metadata=report.configuration,
            client=client,
        )
