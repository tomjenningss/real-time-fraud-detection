"""Opt-in tests against the isolated Part 3 PostgreSQL database; never touch Kafka/Flink."""
from __future__ import annotations

import os
from datetime import UTC, datetime
from uuid import uuid4

import pytest

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_PART3_POSTGRES_TESTS") != "1", reason="requires approved Part 3 PostgreSQL"
)


def test_router_replay_is_durable_and_outbox_claim_is_concurrent_safe(normal_event):
    from fraud_agents.database import FraudStore
    from fraud_agents.events import KafkaPosition, SourcePosition, build_decision
    from fraud_agents.fast_path_policy import decide

    store = FraudStore(os.environ["DATABASE_URL"])
    normal_event.flink.transaction_id = f"pg-replay-{uuid4()}"
    source = SourcePosition(topic="payments.enriched.demo", partition=0, offset=987654321)
    decision, request = build_decision(
        normal_event.flink, decide(normal_event.flink), source, datetime.now(UTC), datetime.now(UTC)
    )
    position = KafkaPosition(source.topic, source.partition, source.offset)
    assert store.record_router_result(
        position=position, payload_sha256="a" * 64, decision=decision, request=request
    )
    assert not store.record_router_result(
        position=position, payload_sha256="a" * 64, decision=decision, request=request
    )
    first = store.claim_outbox("test-worker-a", 10, lease_seconds=60)
    second = store.claim_outbox("test-worker-b", 10, lease_seconds=60)
    first_ids = {item.event_id for item in first}
    assert first_ids.isdisjoint(item.event_id for item in second)
