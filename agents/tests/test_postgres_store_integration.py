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
        position=position,
        payload_sha256="a" * 64,
        decision=decision,
        request=request,
        enrichment_evidence=normal_event.flink,
    )
    assert not store.record_router_result(
        position=position,
        payload_sha256="a" * 64,
        decision=decision,
        request=request,
        enrichment_evidence=normal_event.flink,
    )
    with store.connection() as connection:
        captured = connection.execute(
            "SELECT enrichment_evidence FROM payment_decisions WHERE decision_id=%s",
            (decision.decision_id,),
        ).fetchone()
        assert captured["enrichment_evidence"]["transaction_id"] == normal_event.flink.transaction_id
        assert connection.execute(
            "SELECT count(*) AS total FROM payment_decisions WHERE decision_id=%s",
            (decision.decision_id,),
        ).fetchone()["total"] == 1
    first = store.claim_outbox("test-worker-a", 10, lease_seconds=60)
    second = store.claim_outbox("test-worker-b", 10, lease_seconds=60)
    first_ids = {item.event_id for item in first}
    assert first_ids.isdisjoint(item.event_id for item in second)


def test_banking_watermark_waits_for_raw_payment_acknowledgement():
    from psycopg.types.json import Jsonb

    from fraud_agents.database import FraudStore

    store = FraudStore(os.environ["DATABASE_URL"])
    aggregate_id = uuid4()
    raw_id = uuid4()
    watermark_id = uuid4()
    created_after = datetime.now(UTC)
    with store.connection() as connection, connection.transaction():
        connection.execute(
            """
            INSERT INTO outbox_events
              (event_id, aggregate_type, aggregate_id, destination_topic, message_key,
               schema_version, payload)
            VALUES
              (%s, 'banking_payment_raw', %s, 'payments.raw.demo', %s, '1.0.0', %s),
              (%s, 'banking_payment_watermark', %s, 'payments.raw.demo', '__watermark__',
               '1.0.0', %s)
            """,
            (
                raw_id,
                aggregate_id,
                str(aggregate_id),
                Jsonb({"transaction_id": str(aggregate_id)}),
                watermark_id,
                aggregate_id,
                Jsonb({"user_id": "__watermark__"}),
            ),
        )
    try:
        first = store.claim_outbox("banking-order-test", 10, created_after=created_after)
        assert [message.event_id for message in first] == [raw_id]
        store.mark_published(raw_id, "banking-order-test")
        second = store.claim_outbox("banking-order-test", 10, created_after=created_after)
        assert [message.event_id for message in second] == [watermark_id]
    finally:
        with store.connection() as connection, connection.transaction():
            connection.execute(
                "DELETE FROM outbox_events WHERE event_id = ANY(%s)",
                ([raw_id, watermark_id],),
            )
