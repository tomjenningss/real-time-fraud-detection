from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from fraud_agents.config import Settings
from fraud_agents.evaluation import (
    DATASET_VERSION,
    EvaluationDataset,
    EvaluationMode,
    EvaluationRunner,
    PhoenixPublisher,
    ReplayStore,
    grade_result,
    load_dataset,
)
from fraud_agents.schemas import Verdict
from fraud_agents.supervisor import Supervisor

DATASET_DIR = Path(__file__).parents[1] / "evaluation" / "datasets" / "fraud-investigations-v1"


@pytest.fixture(scope="module")
def evaluation_dataset() -> EvaluationDataset:
    return load_dataset(DATASET_DIR)


def test_versioned_dataset_has_30_unique_cases_and_isolated_ground_truth(evaluation_dataset):
    assert evaluation_dataset.version == DATASET_VERSION
    assert len(evaluation_dataset.cases) == 30
    assert len({case.case_id for case in evaluation_dataset.cases}) == 30
    visible = json.dumps(evaluation_dataset.agent_inputs()).casefold()
    assert "acceptable_outcomes" not in visible
    assert "ground-truth rationale" not in visible
    assert "expected_rule_ids" not in visible


def test_duplicate_case_ids_are_rejected(evaluation_dataset):
    with pytest.raises(ValidationError, match="duplicate evaluation case ID"):
        EvaluationDataset(
            version=evaluation_dataset.version,
            cases=[evaluation_dataset.cases[0], evaluation_dataset.cases[0]],
            ground_truth={
                evaluation_dataset.cases[0].case_id: evaluation_dataset.ground_truth[
                    evaluation_dataset.cases[0].case_id
                ]
            },
        )


@pytest.mark.asyncio
async def test_offline_baseline_is_reproducible_and_free(evaluation_dataset):
    settings = Settings(agent_mode="dry-run", otel_enabled=False, audit_enabled=False)
    report = await EvaluationRunner(settings).run(
        evaluation_dataset, experiment_id="test-offline", repetitions=2
    )
    assert report.aggregate["case_runs"] == 60
    assert report.aggregate["passed"] == 60
    assert report.aggregate["model_calls"] == 540
    assert report.aggregate["estimated_cost_usd"] > 0
    assert report.aggregate["incurred_api_cost_usd"] == 0
    first = {result.case_id: result for result in report.cases[:30]}
    second = {result.case_id: result for result in report.cases[30:]}
    for case_id in first:
        assert first[case_id].recommendation == second[case_id].recommendation
        assert first[case_id].grades == second[case_id].grades


@pytest.mark.asyncio
async def test_original_three_historical_failures_are_regressions(evaluation_dataset):
    case_ids = {
        "eval-v1-history-missing",
        "eval-v1-history-unknown",
        "eval-v1-history-conflicting",
    }
    cases = [case for case in evaluation_dataset.cases if case.case_id in case_ids]
    subset = EvaluationDataset(
        version=evaluation_dataset.version,
        cases=cases,
        ground_truth={case.case_id: evaluation_dataset.ground_truth[case.case_id] for case in cases},
    )
    report = await EvaluationRunner(Settings(agent_mode="dry-run")).run(
        subset, experiment_id="historical-status-regression"
    )
    assert report.aggregate["passed"] == 3
    assert report.aggregate["hard_safety_failures"] == 0
    assert {result.recommendation for result in report.cases} == {Verdict.CHALLENGED.value}


@pytest.mark.asyncio
async def test_graders_accept_positive_and_explain_negative(evaluation_dataset):
    case = next(case for case in evaluation_dataset.cases if case.case_id == "eval-v1-low-risk-complete")
    truth = evaluation_dataset.ground_truth[case.case_id]
    outcome = await Supervisor(Settings(agent_mode="dry-run")).investigate(case.input)
    assert all(grade.passed for grade in grade_result(case, truth, outcome))

    invalid = outcome.model_copy(deep=True)
    invalid.recommendation.verdict = Verdict.BLOCKED
    grades = grade_result(case, truth, invalid)
    failures = {grade.name: grade for grade in grades if not grade.passed}
    assert "factual_accuracy" in failures
    assert "policy_compliance" not in failures  # BLOCKED is not separately prohibited in this case.
    assert "structured_output_validity" in failures
    assert failures["structured_output_validity"].hard_failure

    invalid.audit.mode = "live"
    invalid.audit.supervisor_summary = ""
    quality = {grade.name: grade for grade in grade_result(case, truth, invalid)}
    assert not quality["model_evidence_grounding"].passed


@pytest.mark.asyncio
async def test_structured_grader_accepts_only_the_live_harness_transaction_suffix(
    evaluation_dataset,
):
    case = evaluation_dataset.cases[0]
    truth = evaluation_dataset.ground_truth[case.case_id]
    outcome = await Supervisor(Settings(agent_mode="dry-run")).investigate(case.input)

    valid = outcome.model_copy(deep=True)
    valid_id = f"{case.input.flink.transaction_id}-0123456789"
    valid.recommendation.transaction_id = valid_id
    valid.audit.transaction_id = valid_id
    valid_grade = {grade.name: grade for grade in grade_result(case, truth, valid)}
    assert valid_grade["structured_output_validity"].passed

    invalid = outcome.model_copy(deep=True)
    invalid_id = f"{case.input.flink.transaction_id}-not-a-live-run"
    invalid.recommendation.transaction_id = invalid_id
    invalid.audit.transaction_id = invalid_id
    invalid_grade = {grade.name: grade for grade in grade_result(case, truth, invalid)}
    assert not invalid_grade["structured_output_validity"].passed


def test_usd_live_budget_requires_explicit_ceiling_and_allows_six_allocations():
    with pytest.raises(ValidationError, match="BUDGET_USD"):
        Settings(live_budget_currency="USD")
    settings = Settings(
        live_budget_currency="USD",
        live_budget_usd=2.0,
        live_max_investigations=6,
    )
    assert settings.live_budget_usd == 2.0
    assert settings.live_max_investigations == 6


def test_live_mode_is_disabled_without_explicit_authorisation():
    settings = Settings(agent_mode="live", api_key="offline-placeholder")
    with pytest.raises(RuntimeError, match="explicit authorisation"):
        EvaluationRunner(settings, mode=EvaluationMode.LIVE)


@pytest.mark.asyncio
async def test_live_budget_failure_stops_without_calling_supervisor_again(evaluation_dataset):
    settings = Settings(
        agent_mode="live",
        api_key="offline-placeholder",
        live_experiment_id="new-comparison-experiment",
    )
    factory_calls = 0

    def exhausted_factory(_settings, _investigation_id):
        nonlocal factory_calls
        factory_calls += 1
        raise RuntimeError("cumulative live experiment budget exhausted")

    runner = EvaluationRunner(
        settings,
        mode=EvaluationMode.LIVE,
        live_authorized=True,
        live_supervisor_factory=exhausted_factory,
        protected_experiment_ids={"previous-five-case-experiment"},
    )
    single = EvaluationDataset(
        version=evaluation_dataset.version,
        cases=evaluation_dataset.cases[:1],
        ground_truth={
            evaluation_dataset.cases[0].case_id: evaluation_dataset.ground_truth[
                evaluation_dataset.cases[0].case_id
            ]
        },
    )
    with pytest.raises(RuntimeError, match="budget exhausted"):
        await runner.run(single, experiment_id="new-comparison-experiment")
    assert factory_calls == 1


@pytest.mark.asyncio
async def test_previous_live_experiment_id_cannot_be_reused(evaluation_dataset):
    settings = Settings(
        agent_mode="live",
        api_key="offline-placeholder",
        live_experiment_id="protected-experiment",
    )
    runner = EvaluationRunner(
        settings,
        mode=EvaluationMode.LIVE,
        live_authorized=True,
        live_supervisor_factory=lambda *_args: None,
        protected_experiment_ids={"protected-experiment"},
    )
    with pytest.raises(RuntimeError, match="protected earlier experiment"):
        await runner.run(evaluation_dataset, experiment_id="protected-experiment")


@pytest.mark.asyncio
async def test_phoenix_failure_preserves_durable_local_report(tmp_path, evaluation_dataset):
    class FailedPhoenix:
        def publish(self, _dataset, _report):
            raise ConnectionError("offline")

    output = tmp_path / "report.json"
    report = await EvaluationRunner(
        Settings(agent_mode="dry-run"), phoenix=FailedPhoenix()
    ).run(evaluation_dataset, experiment_id="phoenix-failure", output_path=output)
    assert output.exists()
    assert json.loads(output.read_text())["experiment_id"] == "phoenix-failure"
    assert "Phoenix publication failed: ConnectionError" in report.limitations


@pytest.mark.asyncio
async def test_replay_requires_sanitised_fixture(tmp_path, evaluation_dataset):
    fixture = tmp_path / "replay.json"
    fixture.write_text(json.dumps({"sanitised": False, "responses": []}))
    with pytest.raises(ValueError, match="sanitised"):
        ReplayStore(fixture)

    case = evaluation_dataset.cases[0]
    result = await Supervisor(Settings(agent_mode="dry-run")).investigate(case.input)
    fixture.write_text(
        json.dumps(
            {
                "sanitised": True,
                "responses": [
                    {"case_id": case.case_id, "result": result.model_dump(mode="json")}
                ],
            }
        )
    )
    replay = ReplayStore(fixture)
    assert replay.get(case.case_id).recommendation == result.recommendation


def test_phoenix_client_is_optional_until_publication():
    publisher = PhoenixPublisher()
    assert publisher.base_url == "http://127.0.0.1:6006"
