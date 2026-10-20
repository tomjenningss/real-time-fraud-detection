#!/usr/bin/env python3
"""Bounded real Kafka/Flink/PostgreSQL Part 3 dry-run acceptance scenario."""

from __future__ import annotations

import asyncio
import json
import os
import statistics
import time
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import psycopg
from confluent_kafka import Consumer, Producer

from fraud_agents.config import load_settings
from fraud_agents.database import FraudStore
from fraud_agents.events import KafkaPosition
from fraud_agents.kafka_io import OutboxPublisher, consumer_config
from fraud_agents.router import DecisionRouter
from fraud_agents.worker import InvestigationWorker


def event(tx: str, user: str, merchant: str, amount: float, at: datetime) -> dict:
    return {
        "transaction_id": tx,
        "user_id": user,
        "merchant_id": merchant,
        "amount": amount,
        "device_id": f"device-{user}",
        "payment_channel": "CARD_PRESENT",
        "event_time": at.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
    }


def enriched_event(row: dict, count: int, distinct_merchants: int) -> dict:
    velocity = count >= 5
    hopping = velocity and distinct_merchants >= 4
    signals = []
    if velocity:
        signals.append("HIGH_VELOCITY")
    if hopping:
        signals.append("MERCHANT_HOPPING")
    tx = row["transaction_id"]
    timestamp = (
        datetime.strptime(row["event_time"], "%Y-%m-%d %H:%M:%S.%f")
        .replace(tzinfo=UTC)
        .isoformat()
        .replace("+00:00", "Z")
    )
    return {
        "assessment_type": "transaction",
        "transaction_id": tx,
        "user_id": row["user_id"],
        "amount": row["amount"],
        "merchant_id": row["merchant_id"],
        "transaction_timestamp": timestamp,
        "transactions_1m": count,
        "transactions_2m": count,
        "transactions_10m": count,
        "distinct_merchants_2m": distinct_merchants,
        "total_amount_2m": row["amount"] * count,
        "signals": signals,
        "signal_ids": [f"txn:{tx}:{signal}" for signal in signals],
        "risk_level": "HIGH" if signals else "LOW",
        "assessment_timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "evidence_source": "flink",
    }


def establish(topic: str, brokers: str, run_id: str) -> Consumer:
    config = consumer_config(brokers, f"part3-e2e-{run_id}-{topic}")
    config["auto.offset.reset"] = "latest"
    consumer = Consumer(config)
    consumer.subscribe([topic])
    consumer.poll(1)
    return consumer


def collect(consumer: Consumer, prefix: str, expected: int, timeout: float = 45) -> list:
    records = []
    deadline = time.monotonic() + timeout
    while len(records) < expected and time.monotonic() < deadline:
        message = consumer.poll(1)
        if message is None or message.error():
            continue
        value = json.loads(message.value())
        if value.get("transaction_id", "").startswith(prefix):
            records.append((message, value))
    if len(records) != expected:
        raise AssertionError(
            f"expected {expected} matching {consumer.list_topics().orig_broker_name}, got {len(records)}"
        )
    return records


def percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    return round(ordered[max(0, int(len(ordered) * quantile + 0.999999) - 1)], 3)


async def run() -> dict:
    if os.getenv("LIVE_INVESTIGATIONS_ENABLED", "false").lower() != "false":
        raise RuntimeError("live investigations must be disabled")
    brokers = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
    run_id = uuid4().hex[:12]
    prefix = f"part3-{run_id}-"
    base = datetime.now(UTC).replace(tzinfo=None, microsecond=0)
    rows = []
    for index in range(3):
        rows.append(
            event(
                f"{prefix}normal-{index}",
                f"{prefix}normal",
                f"normal-{index}",
                20 + index,
                base + timedelta(seconds=index),
            )
        )
    for index in range(6):
        rows.append(
            event(
                f"{prefix}velocity-{index}",
                f"{prefix}velocity",
                "repeat",
                10 + index,
                base + timedelta(seconds=index),
            )
        )
    for index in range(7):
        rows.append(
            event(
                f"{prefix}hopping-{index}",
                f"{prefix}hopping",
                f"hop-{index}",
                30 + index,
                base + timedelta(seconds=index),
            )
        )
    enriched_consumer = establish("payments.enriched.demo", brokers, run_id)
    producer = Producer({"bootstrap.servers": brokers})
    canonical = []
    for row in rows:
        index = int(row["transaction_id"].rsplit("-", 1)[1]) + 1
        merchants = index if "hopping" in row["transaction_id"] else 1
        canonical.append(enriched_event(row, index, merchants))
    for row in canonical:
        producer.produce("payments.enriched.demo", key=row["transaction_id"], value=json.dumps(row).encode())
    if producer.flush(10):
        raise TimeoutError("enriched payment publication was not acknowledged")
    enriched = collect(enriched_consumer, prefix, 16)
    enriched_consumer.close()

    store = FraudStore(os.environ["DATABASE_URL"])
    router = DecisionRouter(store)
    latencies = []
    for message, _value in enriched:
        started = time.perf_counter()
        assert router.process(
            message.value(), KafkaPosition(message.topic(), message.partition(), message.offset())
        )
        latencies.append((time.perf_counter() - started) * 1000)
    replay_message = enriched[0][0]
    replay_created = router.process(
        replay_message.value(),
        KafkaPosition(
            replay_message.topic(), replay_message.partition(), replay_message.offset() + 1_000_000
        ),
    )
    assert replay_created is False

    request_consumer = establish("fraud.investigations.requested", brokers, run_id)
    completed_consumer = establish("fraud.investigations.completed", brokers, run_id)
    publisher = OutboxPublisher(store, Producer({"bootstrap.servers": brokers}), f"e2e-{run_id}")
    while publisher.publish_batch(50):
        pass
    requests = collect(request_consumer, prefix, 5)
    request_consumer.close()

    settings = load_settings(mode_override="dry-run")
    worker = InvestigationWorker(store, settings, max_attempts=3)
    for message, _value in requests:
        assert await worker.process(
            message.value(), KafkaPosition(message.topic(), message.partition(), message.offset())
        )
    while publisher.publish_batch(50):
        pass
    completed = collect(completed_consumer, prefix, 5)
    completed_consumer.close()

    with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
        counts = dict(
            connection.execute(
                """SELECT payment_verdict, count(*) FROM payment_decisions
               WHERE transaction_id LIKE %s GROUP BY payment_verdict""",
                (prefix + "%",),
            ).fetchall()
        )
        original = connection.execute(
            "SELECT payment_verdict FROM payment_decisions WHERE transaction_id=%s",
            (f"{prefix}hopping-6",),
        ).fetchone()[0]
        immutable = False
        try:
            with connection.transaction():
                connection.execute(
                    "UPDATE payment_decisions SET payment_verdict='APPROVED' WHERE transaction_id=%s",
                    (f"{prefix}hopping-6",),
                )
        except psycopg.errors.RaiseException:
            immutable = True
        after = connection.execute(
            "SELECT payment_verdict FROM payment_decisions WHERE transaction_id=%s",
            (f"{prefix}hopping-6",),
        ).fetchone()[0]
    assert immutable and original == after == "BLOCKED"
    assert counts == {"APPROVED": 11, "BLOCKED": 3, "CHALLENGED": 2}
    assert all(item[1]["mode"] == "dry-run" for item in completed)
    return {
        "run_id": run_id,
        "transactions_processed": 16,
        "decision_counts": counts,
        "investigations_requested": len(requests),
        "investigations_completed": len(completed),
        "normal_bypassed_investigation": 11,
        "duplicate_replay_created_decision": replay_created,
        "immutable_overwrite_rejected": immutable,
        "router_latency_ms": {
            "p50": percentile(latencies, 0.50),
            "p95": percentile(latencies, 0.95),
            "p99": percentile(latencies, 0.99),
            "mean": round(statistics.mean(latencies), 3),
        },
    }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(run()), sort_keys=True))
