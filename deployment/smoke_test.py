#!/usr/bin/env python3
"""Bounded 16-payment acceptance test for the isolated Compose deployment."""

from __future__ import annotations

import json
import os
import time
from collections import Counter
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from confluent_kafka import Consumer, KafkaException, Producer, TopicPartition

RAW_TOPIC = "payments.raw.demo"
OUTPUT_TOPICS = (
    "payments.enriched.demo",
    "fraud.decisions.demo",
    "fraud.risk.baseline.demo",
    "fraud.assessments.correlated.demo",
    "fraud.decisions.shadow.demo",
)
SIGNALS_TOPIC = "fraud.signals.demo"


def payment(tx: str, user: str, merchant: str, amount: float, at: datetime) -> dict:
    return {
        "transaction_id": tx,
        "user_id": user,
        "merchant_id": merchant,
        "amount": round(amount, 2),
        "device_id": f"device-{user}",
        "payment_channel": "CARD_PRESENT",
        "event_time": at.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
    }


def last_raw_event_time(brokers: str) -> datetime | None:
    consumer = Consumer(
        {
            "bootstrap.servers": brokers,
            "group.id": f"smoke-boundary-{uuid4().hex}",
            "enable.auto.commit": False,
        }
    )
    try:
        partition = TopicPartition(RAW_TOPIC, 0)
        _low, high = consumer.get_watermark_offsets(partition, timeout=10)
        if high == 0:
            return None
        consumer.assign([TopicPartition(RAW_TOPIC, 0, high - 1)])
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            message = consumer.poll(1)
            if message is None:
                continue
            if message.error():
                raise KafkaException(message.error())
            value = json.loads(message.value())
            raw = value.get("event_time")
            return datetime.strptime(raw, "%Y-%m-%d %H:%M:%S.%f") if raw else None
        raise TimeoutError("could not read the latest raw-topic event-time boundary")
    finally:
        consumer.close()


def fixture(run_id: str, base: datetime) -> list[dict]:
    prefix = f"smoke-{run_id}"
    rows = [
        payment(
            f"{prefix}-normal-{index}",
            f"{prefix}-normal-user",
            f"normal-shop-{index}",
            amount,
            base + timedelta(milliseconds=index * 300),
        )
        for index, amount in enumerate((20.0, 30.0, 40.0))
    ]
    rows.extend(
        payment(
            f"{prefix}-velocity-{index}",
            f"{prefix}-velocity-user",
            "repeat-shop",
            10 + index,
            base + timedelta(seconds=1, milliseconds=index * 200),
        )
        for index in range(6)
    )
    rows.extend(
        payment(
            f"{prefix}-hopping-{index}",
            f"{prefix}-hopping-user",
            f"hop-shop-{index}",
            30 + index,
            base + timedelta(seconds=3, milliseconds=index * 200),
        )
        for index in range(7)
    )
    rows.append(
        payment(
            f"{prefix}-watermark",
            "__watermark__",
            "__none__",
            0,
            base + timedelta(minutes=3),
        )
    )
    return rows


def consumer_at_end(brokers: str, topic: str, run_id: str) -> Consumer:
    consumer = Consumer(
        {
            "bootstrap.servers": brokers,
            "group.id": f"smoke-observer-{run_id}-{topic}",
            "enable.auto.commit": False,
            "auto.offset.reset": "latest",
            "isolation.level": "read_committed",
        }
    )
    partition = TopicPartition(topic, 0)
    _low, high = consumer.get_watermark_offsets(partition, timeout=10)
    consumer.assign([TopicPartition(topic, 0, high)])
    return consumer


def publish(brokers: str, rows: list[dict]) -> None:
    producer = Producer({"bootstrap.servers": brokers, "enable.idempotence": True})
    errors = []

    def delivered(error, _message):
        if error:
            errors.append(error)

    for row in rows:
        producer.produce(
            RAW_TOPIC,
            key=row["transaction_id"],
            value=json.dumps(row, separators=(",", ":")).encode(),
            on_delivery=delivered,
        )
    remaining = producer.flush(15)
    if remaining or errors:
        raise RuntimeError(f"raw payment publication failed: remaining={remaining}, errors={errors}")


def main() -> None:
    brokers = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:29092")
    run_id = uuid4().hex[:12]
    prefix = f"smoke-{run_id}"
    now = datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=2)
    previous = last_raw_event_time(brokers)
    base = max(now, previous + timedelta(seconds=5)) if previous else now
    rows = fixture(run_id, base)
    payments = rows[:-1]
    expected_ids = {row["transaction_id"] for row in payments}
    consumers = {
        topic: consumer_at_end(brokers, topic, run_id) for topic in (*OUTPUT_TOPICS, SIGNALS_TOPIC)
    }
    seen: dict[str, set[str]] = {topic: set() for topic in OUTPUT_TOPICS}
    decisions: dict[str, str] = {}
    sql_rules: set[str] = set()
    velocity_user = f"{prefix}-velocity-user"
    hopping_user = f"{prefix}-hopping-user"

    try:
        publish(brokers, rows)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            for topic, consumer in consumers.items():
                message = consumer.poll(0.2)
                if message is None:
                    continue
                if message.error():
                    raise KafkaException(message.error())
                value = json.loads(message.value())
                if topic == SIGNALS_TOPIC:
                    if value.get("user_id") == velocity_user and value.get("signal_type") == "HIGH_VELOCITY":
                        sql_rules.add("HIGH_VELOCITY")
                    if value.get("user_id") == hopping_user and value.get("signal_type") == "MERCHANT_HOPPING":
                        sql_rules.add("MERCHANT_HOPPING")
                    continue
                transaction_id = value.get("transaction_id", "")
                if transaction_id in expected_ids:
                    seen[topic].add(transaction_id)
                    if topic == "fraud.decisions.demo":
                        decisions[transaction_id] = value["payment_verdict"]
            if all(ids == expected_ids for ids in seen.values()) and sql_rules == {
                "HIGH_VELOCITY",
                "MERCHANT_HOPPING",
            }:
                break
        missing = {topic: sorted(expected_ids - ids) for topic, ids in seen.items() if ids != expected_ids}
        if missing:
            counts = {topic: len(ids) for topic, ids in seen.items()}
            raise AssertionError(f"16/16 downstream verification failed: counts={counts}, missing={missing}")
        if sql_rules != {"HIGH_VELOCITY", "MERCHANT_HOPPING"}:
            raise AssertionError(f"SQL rule verification failed: observed={sorted(sql_rules)}")
        verdicts = Counter(decisions.values())
        expected_verdicts = {"APPROVED": 11, "CHALLENGED": 2, "BLOCKED": 3}
        if dict(verdicts) != expected_verdicts:
            raise AssertionError(
                f"deterministic verdicts changed: expected={expected_verdicts}, actual={dict(verdicts)}"
            )
        print(
            json.dumps(
                {
                    "run_id": run_id,
                    "transactions": 16,
                    "downstream_unique_transactions": {topic: len(ids) for topic, ids in seen.items()},
                    "deterministic_verdicts": dict(verdicts),
                    "sql_rules": sorted(sql_rules),
                    "watermark_event_time": rows[-1]["event_time"],
                },
                sort_keys=True,
            )
        )
    finally:
        for consumer in consumers.values():
            consumer.close()


if __name__ == "__main__":
    main()
