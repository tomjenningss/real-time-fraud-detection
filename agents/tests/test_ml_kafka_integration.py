"""Opt-in test using dedicated topics; it never reads or writes the live demo topics."""

from __future__ import annotations

import json
import os
import time
from uuid import uuid4

import pytest
from confluent_kafka import Consumer, Producer


@pytest.mark.skipif(os.getenv("RUN_ML_KAFKA_INTEGRATION") != "1", reason="Kafka integration is opt-in")
def test_dedicated_shadow_risk_topic_round_trip():
    brokers = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
    topic = f"fraud.risk.baseline.test.{uuid4().hex}"
    event_id = str(uuid4())
    producer = Producer({"bootstrap.servers": brokers})
    producer.produce(topic, key=event_id, value=json.dumps({"event_id": event_id}).encode())
    assert producer.flush(10) == 0
    consumer = Consumer(
        {"bootstrap.servers": brokers, "group.id": f"ml-test-{uuid4().hex}", "auto.offset.reset": "earliest"}
    )
    consumer.subscribe([topic])
    deadline = time.monotonic() + 10
    received = None
    while time.monotonic() < deadline and received is None:
        message = consumer.poll(0.5)
        if message is not None and not message.error():
            received = json.loads(message.value())
    consumer.close()
    assert received == {"event_id": event_id}
