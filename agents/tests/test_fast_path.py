from __future__ import annotations

from datetime import UTC, datetime

from conftest import make_signal_event

from fraud_agents.database import IdentityConflict
from fraud_agents.events import (
    KafkaPosition,
    SourcePosition,
    build_decision,
    evidence_sha256,
)
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


def test_new_beneficiary_high_value_is_challenged_with_versioned_rule(normal_dict):
    evidence = make_signal_event(normal_dict, "new-beneficiary", ["NEW_BENEFICIARY_HIGH_VALUE"]).flink
    result = decide(evidence)

    assert result.payment_verdict == Verdict.CHALLENGED
    assert result.investigation_required is True
    assert result.investigation_reason == "NEW_BENEFICIARY_HIGH_VALUE"
    assert result.triggered_rule_ids == ("FP-CHALLENGE-NEW-BENEFICIARY-HIGH-VALUE/1.0.0",)
    assert result.policy_version == "fast-path-policy/1.1.0"


def test_existing_hard_block_precedes_new_beneficiary_challenge(normal_dict):
    evidence = make_signal_event(
        normal_dict,
        "combined-new-beneficiary",
        ["HIGH_VELOCITY", "MERCHANT_HOPPING", "NEW_BENEFICIARY_HIGH_VALUE"],
        7,
    ).flink
    result = decide(evidence)

    assert result.payment_verdict == Verdict.BLOCKED
    assert result.triggered_rule_ids == ("FP-BLOCK-VELOCITY-HOPPING",)


def slow_building_evidence(normal_dict: dict, stream: str = "slow-building-replay") -> FlinkEvidence:
    payload = dict(normal_dict["flink"])
    payload.update({
        "transaction_id": "slow-building-week-5",
        "assessment_stream": stream,
        "signals": ["SLOW_BUILDING_BENEFICIARY_RISK"],
        "signal_ids": ["txn:slow-building-week-5:SLOW_BUILDING_BENEFICIARY_RISK"],
        "risk_level": "HIGH",
        "slow_building_beneficiary_evidence": {
            "beneficiary_id": "stable-beneficiary",
            "window_days": 30,
            "payments_30d": 5,
            "cumulative_amount_30d": 5850,
            "successive_growth_count": 4,
            "successive_pair_count": 4,
            "current_to_first_amount_ratio": 15,
            "observed_relationship_age_days": 28,
            "window_start": "2026-09-01T12:00:00Z",
            "window_end": "2026-09-29T12:00:00Z",
            "thresholds": {
                "minimum_payments": 4,
                "minimum_cumulative_amount": 4000,
                "minimum_successive_growth_count": 3,
                "minimum_current_to_first_amount_ratio": 4,
                "minimum_observed_relationship_age_days": 21,
            },
        },
    })
    return FlinkEvidence.model_validate(payload)


def test_slow_building_signal_is_observation_only_without_demo_gate(normal_dict):
    result = decide(slow_building_evidence(normal_dict))

    assert result.payment_verdict == Verdict.APPROVED
    assert result.investigation_required is False
    assert result.policy_version == "fast-path-policy/1.1.0"


def test_slow_building_signal_challenges_only_isolated_replay_when_gated(normal_dict):
    evidence = slow_building_evidence(normal_dict)
    result = decide(evidence, slow_building_demo_policy_enabled=True)

    assert result.payment_verdict == Verdict.CHALLENGED
    assert result.investigation_reason == "SLOW_BUILDING_BENEFICIARY_RISK"
    assert result.triggered_rule_ids == (
        "FP-DEMO-CHALLENGE-SLOW-BUILDING-BENEFICIARY/1.0.0",
    )
    assert result.policy_version == "fast-path-policy/1.2.0-slow-building-demo"
    assert result.baseline_policy_version == "fast-path-policy/1.1.0"
    assert result.baseline_payment_verdict == Verdict.APPROVED
    now = datetime.now(UTC)
    decision, _ = build_decision(
        evidence,
        result,
        SourcePosition(topic="payments.enriched.slow-building-replay", partition=0, offset=4),
        now,
        now,
    )
    assert decision.baseline_policy_version == "fast-path-policy/1.1.0"
    assert decision.baseline_payment_verdict == Verdict.APPROVED


def test_demo_gate_cannot_enable_slow_building_policy_on_live_stream(normal_dict):
    result = decide(
        slow_building_evidence(normal_dict, stream="live"),
        slow_building_demo_policy_enabled=True,
    )

    assert result.payment_verdict == Verdict.APPROVED
    assert result.policy_version == "fast-path-policy/1.1.0"


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


def test_assessment_timestamp_is_not_part_of_canonical_evidence_identity(normal_event):
    first = normal_event.flink
    second = first.model_copy(update={"assessment_timestamp": datetime(2030, 1, 1, tzinfo=UTC)})
    assert evidence_sha256(first) == evidence_sha256(second)


def test_identity_conflict_is_durable_dlq_not_router_crash(normal_event):
    class ConflictingStore(RecordingStore):
        def record_router_result(self, **values):
            raise IdentityConflict("transaction_id was reused with different evidence")

    store = ConflictingStore()
    router = DecisionRouter(store, dlq_topic="fraud.decisions.slow-building-replay.dlq")
    assert router.process(
        normal_event.flink.model_dump_json().encode(),
        KafkaPosition("payments.enriched.slow-building-replay", 0, 9),
    ) is False
    assert store.dlqs[0]["topic"] == "fraud.decisions.slow-building-replay.dlq"
    assert store.dlqs[0]["key"] == normal_event.flink.transaction_id


def test_router_passes_decision_and_request_atomically_to_store(normal_dict):
    store = RecordingStore()
    router = DecisionRouter(store)
    event: FlinkEvidence = make_signal_event(normal_dict, "v-atomic", ["HIGH_VELOCITY"]).flink
    assert router.process(event.model_dump_json().encode(), KafkaPosition("payments.enriched.demo", 0, 2))
    assert len(store.results) == 1
    assert store.results[0]["decision"].payment_verdict == Verdict.CHALLENGED
    assert store.results[0]["request"].transaction_id == "v-atomic"
    assert store.results[0]["enrichment_evidence"] == event
