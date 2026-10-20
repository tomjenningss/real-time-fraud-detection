from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from fraud_agents.anthropic_runtime import AnthropicToolRuntime, CostController
from fraud_agents.config import Settings
from fraud_agents.events import InvestigationRequestEvent, KafkaPosition
from fraud_agents.schemas import Verdict
from fraud_agents.supervisor import Supervisor
from fraud_agents.telemetry import Telemetry, redact
from fraud_agents.worker import InvestigationWorker


class FakeBlock:
    def __init__(self, value):
        self.value = value

    def model_dump(self, mode="json"):
        return self.value


class FakeMessages:
    def __init__(self):
        self.responses = [
            SimpleNamespace(
                usage=SimpleNamespace(input_tokens=100, output_tokens=20),
                content=[
                    FakeBlock(
                        {
                            "type": "tool_use",
                            "id": "tool-1",
                            "name": "lookup",
                            "input": {"transaction_id": "synthetic-tx"},
                        }
                    )
                ],
            ),
            SimpleNamespace(
                usage=SimpleNamespace(input_tokens=130, output_tokens=15),
                content=[FakeBlock({"type": "text", "text": "Synthetic evidence reviewed."})],
            ),
        ]

    async def create(self, **_kwargs):
        return self.responses.pop(0)


def traced_settings(**updates) -> Settings:
    return Settings(
        otel_enabled=True,
        otel_service_name="fraud-test",
        phoenix_project_name="fraud-tests",
        **updates,
    )


def telemetry_for(settings: Settings) -> tuple[Telemetry, InMemorySpanExporter]:
    exporter = InMemorySpanExporter()
    return Telemetry.from_settings(settings, exporter=exporter), exporter


class FakeWorkerStore:
    def __init__(self, event, attempt_id):
        self.event = event
        self.attempt_id = attempt_id
        self.completed = None
        self.failure = None

    def prepare_investigation_attempt(self, *_args):
        return self.attempt_id, 2

    def mark_attempt_running(self, attempt_id):
        assert attempt_id == self.attempt_id

    def load_investigation_input(self, _request):
        return self.event

    def complete_investigation(self, attempt_id, completed, audit, estimated_cost):
        self.completed = (attempt_id, completed, audit, estimated_cost)

    def fail_attempt(self, attempt_id, retryable, error_type):
        self.failure = (attempt_id, retryable, error_type)


def investigation_request(event) -> InvestigationRequestEvent:
    return InvestigationRequestEvent(
        event_id=uuid4(),
        investigation_id=uuid4(),
        decision_id=uuid4(),
        transaction_id=event.flink.transaction_id,
        correlation_id=uuid4(),
        original_payment_verdict=Verdict.CHALLENGED,
        routing_reason="SYNTHETIC_TEST",
        fast_path_policy_version="fast-path/test",
        evidence=event.flink,
        source_evidence_references=["fixture:synthetic"],
        requested_at=event.flink.assessment_timestamp,
    )


@pytest.mark.asyncio
async def test_investigation_agent_and_tool_hierarchy_has_safe_correlation(
    normal_event, monkeypatch
):
    settings = traced_settings(agent_mode="dry-run")
    telemetry, exporter = telemetry_for(settings)
    investigation_id, attempt_id = uuid4(), uuid4()
    supervisor = Supervisor(settings, telemetry=telemetry)

    original_geo = supervisor.geo.investigate

    async def failed_geo(event):
        await original_geo(event)
        raise RuntimeError("synthetic specialist failure")

    monkeypatch.setattr(supervisor.geo, "investigate", failed_geo)
    with telemetry.bind({"fraud.attempt.id": str(attempt_id)}):
        result = await supervisor.investigate(normal_event, investigation_id=investigation_id)

    spans = list(exporter.get_finished_spans())
    by_name = {span.name: span for span in spans}
    root = by_name["fraud investigation"]
    assert root.attributes["fraud.investigation.id"] == str(investigation_id)
    assert root.attributes["fraud.attempt.id"] == str(attempt_id)
    assert by_name["geo agent"].parent.span_id == root.context.span_id
    assert by_name["behaviour agent"].parent.span_id == root.context.span_id
    assert by_name["action agent"].parent.span_id == root.context.span_id
    assert by_name["tool check_geo_distance"].parent.span_id == by_name["geo agent"].context.span_id
    assert by_name["tool get_canonical_behaviour_evidence"].parent.span_id == (
        by_name["behaviour agent"].context.span_id
    )
    assert by_name["tool apply_decision_rules"].parent.span_id == (
        by_name["action agent"].context.span_id
    )
    assert by_name["geo agent"].status.status_code is StatusCode.ERROR
    assert result.audit.failures == ["geo:RuntimeError"]


@pytest.mark.asyncio
async def test_worker_correlates_attempt_and_preserves_original_verdict(normal_event):
    settings = traced_settings(agent_mode="dry-run")
    telemetry, exporter = telemetry_for(settings)
    attempt_id = uuid4()
    store = FakeWorkerStore(normal_event, attempt_id)
    worker = InvestigationWorker(store, settings)
    worker.telemetry = telemetry
    request = investigation_request(normal_event)

    assert await worker.process(
        request.model_dump_json().encode(), KafkaPosition("requests", 0, 42)
    )
    assert store.completed is not None
    completed = store.completed[1]
    assert completed.original_payment_verdict is Verdict.CHALLENGED
    root = next(span for span in exporter.get_finished_spans() if span.name == "fraud investigation")
    assert root.attributes["fraud.attempt.id"] == str(attempt_id)
    assert root.attributes["fraud.attempt.number"] == 2
    assert root.attributes["fraud.correlation.id"] == str(request.correlation_id)
    assert root.attributes["fraud.original_payment_verdict"] == "CHALLENGED"
    persistence = next(
        span for span in exporter.get_finished_spans() if span.name == "investigation persisted"
    )
    assert any(event.name == "completion event durably enqueued" for event in persistence.events)


@pytest.mark.asyncio
async def test_worker_failure_is_traced_and_durable_failure_path_runs(
    normal_event, monkeypatch
):
    settings = traced_settings(agent_mode="dry-run")
    telemetry, exporter = telemetry_for(settings)
    attempt_id = uuid4()
    store = FakeWorkerStore(normal_event, attempt_id)
    worker = InvestigationWorker(store, settings)
    worker.telemetry = telemetry
    request = investigation_request(normal_event)

    async def fail(*_args, **_kwargs):
        raise ConnectionError("synthetic storage-independent failure")

    monkeypatch.setattr(Supervisor, "investigate", fail)
    with pytest.raises(ConnectionError):
        await worker.process(
            request.model_dump_json().encode(), KafkaPosition("requests", 0, 43)
        )
    assert store.failure == (attempt_id, True, "ConnectionError")
    worker_span = next(
        span for span in exporter.get_finished_spans() if span.name == "investigation worker"
    )
    assert worker_span.status.status_code is StatusCode.ERROR


@pytest.mark.asyncio
async def test_model_tokens_cost_sequence_and_tool_attributes_are_exported():
    settings = traced_settings(
        agent_mode="live", api_key="offline-only", max_output_tokens=64
    )
    telemetry, exporter = telemetry_for(settings)
    runtime = AnthropicToolRuntime(settings, CostController(1.0, settings.pricing), telemetry)
    runtime.client = SimpleNamespace(messages=FakeMessages())

    async def handler(_arguments):
        return {"status": "AVAILABLE", "_audit_source": "synthetic_fixture"}

    result = await runtime.run(
        agent="geo",
        model=settings.geo_model,
        system="Synthetic test prompt.",
        user_content="Investigate synthetic-tx.",
        tools=[{"name": "lookup", "input_schema": {"type": "object"}}],
        handlers={"lookup": handler},
    )

    spans = list(exporter.get_finished_spans())
    model_spans = [span for span in spans if span.attributes["openinference.span.kind"] == "LLM"]
    assert [span.attributes["fraud.model_call.sequence"] for span in model_spans] == [1, 2]
    assert model_spans[0].attributes["llm.token_count.prompt"] == 100
    assert model_spans[0].attributes["llm.token_count.completion"] == 20
    assert model_spans[0].attributes["llm.token_count.total"] == 120
    assert model_spans[0].attributes["fraud.model_call.estimated_cost_usd"] > 0
    tool_span = next(span for span in spans if span.name == "tool lookup")
    assert tool_span.attributes["tool.name"] == "lookup"
    assert tool_span.attributes["fraud.evidence.source"] == "synthetic_fixture"
    assert len(result.usages) == 2


@pytest.mark.asyncio
async def test_ambiguous_anthropic_outcome_is_marked_without_retry():
    settings = traced_settings(
        agent_mode="live", api_key="offline-only", max_output_tokens=64
    )
    telemetry, exporter = telemetry_for(settings)
    runtime = AnthropicToolRuntime(settings, CostController(1.0, settings.pricing), telemetry)
    calls = 0

    class FailingMessages:
        async def create(self, **_kwargs):
            nonlocal calls
            calls += 1
            raise TimeoutError("synthetic ambiguous outcome")

    runtime.client = SimpleNamespace(messages=FailingMessages())
    with pytest.raises(TimeoutError):
        await runtime.run(
            agent="supervisor",
            model=settings.supervisor_model,
            system="synthetic",
            user_content="synthetic",
            tools=[],
            handlers={},
        )
    span = exporter.get_finished_spans()[0]
    assert calls == 1
    assert span.attributes["fraud.api_outcome_ambiguous"] is True
    assert span.status.status_code is StatusCode.ERROR


def test_sensitive_content_is_redacted_and_capture_requires_explicit_opt_in():
    payload = {
        "api_key": "sk-secret",
        "nested": {
            "anthropic_api_key": "second-secret",
            "database_url": "postgres://secret",
            "device_lat": 51.5,
        },
        "safe": "synthetic",
    }
    assert redact(payload) == {
        "api_key": "[REDACTED]",
        "nested": {
            "anthropic_api_key": "[REDACTED]",
            "database_url": "[REDACTED]",
            "device_lat": "[REDACTED]",
        },
        "safe": "synthetic",
    }
    disabled_capture = Telemetry(enabled=True, capture_synthetic_content=False)
    assert disabled_capture.content_attributes(input_value=payload) == {}

    enabled_capture = Telemetry(enabled=True, capture_synthetic_content=True)
    attributes = enabled_capture.content_attributes(input_value=payload)
    assert "sk-secret" not in attributes["input.value"]
    assert "postgres://secret" not in attributes["input.value"]
    assert "51.5" not in attributes["input.value"]


def test_tracing_disabled_creates_no_provider_or_spans():
    telemetry = Telemetry.from_settings(Settings(otel_enabled=False))
    with telemetry.span("not exported", "CHAIN") as span:
        span.set("api_key", "must-not-appear")
    assert telemetry.enabled is False
    assert telemetry.provider is None


class FailingExporter(SpanExporter):
    def export(self, spans):
        raise ConnectionError("collector unavailable")

    def shutdown(self):
        return None


def test_exporter_unavailable_does_not_fail_application_work():
    telemetry = Telemetry.from_settings(traced_settings(), exporter=FailingExporter())
    completed = False
    with telemetry.span("still runs", "CHAIN"):
        completed = True
    assert completed


def test_exporter_contract_constant_is_valid():
    # Keeps the test exporter API import exercised across OpenTelemetry minor upgrades.
    assert SpanExportResult.SUCCESS.value == 0
