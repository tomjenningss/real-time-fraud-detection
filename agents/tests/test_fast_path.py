from __future__ import annotations

from datetime import UTC, datetime

from conftest import make_signal_event

from fraud_agents.events import KafkaPosition, SourcePosition, build_decision
from fraud_agents.fast_path_policy import decide
from fraud_agents.router import DecisionRouter
from fraud_agents.schemas import FlinkEvidence, Verdict


class RecordingStore:
    def __init__(self):
        self.results = []
        self.dlqs = []

    def record_router_result(self, **values):
        self.results.append(values)
        return True

    def record_dlq(self, **values):
        self.dlqs.append(values)


def test_normal_fast_path_approves_without_investigation(normal_event):
    result = decide(normal_event.flink)
    assert result.payment_verdict == Verdict.APPROVED
    assert result.investigation_required is False


def test_velocity_and_hopping_are_explicit_routes(normal_dict):
    velocity = make_signal_event(normal_dict, "v-1", ["HIGH_VELOCITY"]).flink
    combined = make_signal_event(normal_dict, "c-1", ["HIGH_VELOCITY", "MERCHANT_HOPPING"], 7).flink
    assert decide(velocity).payment_verdict == Verdict.CHALLENGED
    assert decide(velocity).investigation_required is True
    assert decide(combined).payment_verdict == Verdict.BLOCKED
    assert decide(combined).investigation_required is True


def test_stable_identifiers_and_immutable_original_verdict(normal_event):
    source = SourcePosition(topic="payments.enriched.demo", partition=0, offset=9)
    result = decide(normal_event.flink, sample_normal=True)
    first = build_decision(normal_event.flink, result, source, datetime.now(UTC), datetime.now(UTC))
    second = build_decision(normal_event.flink, result, source, datetime.now(UTC), datetime.now(UTC))
    assert first[0].decision_id == second[0].decision_id
    assert first[1].investigation_id == second[1].investigation_id
    assert first[1].original_payment_verdict == Verdict.APPROVED


def test_invalid_evidence_is_durable_dlq_not_approval():
    store = RecordingStore()
    router = DecisionRouter(store)
    assert router.process(b'{"transaction_id":"bad"}', KafkaPosition("payments.enriched.demo", 0, 1)) is False
    assert not store.results
    assert store.dlqs[0]["topic"] == "fraud.decisions.dlq"


def test_router_passes_decision_and_request_atomically_to_store(normal_dict):
    store = RecordingStore()
    router = DecisionRouter(store)
    event: FlinkEvidence = make_signal_event(normal_dict, "v-atomic", ["HIGH_VELOCITY"]).flink
    assert router.process(event.model_dump_json().encode(), KafkaPosition("payments.enriched.demo", 0, 2))
    assert len(store.results) == 1
    assert store.results[0]["decision"].payment_verdict == Verdict.CHALLENGED
    assert store.results[0]["request"].transaction_id == "v-atomic"
