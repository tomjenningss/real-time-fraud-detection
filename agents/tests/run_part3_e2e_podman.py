#!/usr/bin/env python3
"""Bounded Part 3 test using Kafka CLI inside the broker container."""

from __future__ import annotations

import asyncio
import json
import os
import statistics
import subprocess
import time
from datetime import UTC, datetime
from uuid import uuid4

import psycopg

from fraud_agents.config import load_settings
from fraud_agents.database import FraudStore
from fraud_agents.events import KafkaPosition
from fraud_agents.router import DecisionRouter
from fraud_agents.worker import InvestigationWorker

KAFKA_CONTAINER = "confluent-flink-kafka-1"


def kafka_produce(topic: str, records: list[tuple[str, dict]]) -> None:
    payload = "".join(
        f"{key}\t{json.dumps(value, separators=(',', ':'), sort_keys=True)}\n" for key, value in records
    )
    subprocess.run(
        [
            "podman",
            "exec",
            "-i",
            KAFKA_CONTAINER,
            "kafka-console-producer",
            "--bootstrap-server",
            "kafka:29092",
            "--topic",
            topic,
            "--property",
            "parse.key=true",
            "--property",
            "key.separator=\t",
        ],
        input=payload,
        text=True,
        check=True,
        timeout=15,
    )


def kafka_collect(topic: str, prefix: str, expected: int, group: str) -> list[dict]:
    result = subprocess.run(
        [
            "podman",
            "exec",
            KAFKA_CONTAINER,
            "kafka-console-consumer",
            "--bootstrap-server",
            "kafka:29092",
            "--topic",
            topic,
            "--group",
            group,
            "--from-beginning",
            "--timeout-ms",
            "15000",
        ],
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    values = []
    for line in result.stdout.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if value.get("transaction_id", "").startswith(prefix):
            values.append(value)
    if len(values) != expected:
        raise AssertionError(f"expected {expected} records from {topic}, got {len(values)}")
    return values


def canonical(tx: str, user: str, merchant: str, amount: float, count: int, merchants: int) -> dict:
    velocity = count >= 5
    hopping = velocity and merchants >= 4
    signals = (["HIGH_VELOCITY"] if velocity else []) + (["MERCHANT_HOPPING"] if hopping else [])
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    return {
        "assessment_type": "transaction",
        "transaction_id": tx,
        "user_id": user,
        "amount": amount,
        "merchant_id": merchant,
        "transaction_timestamp": now,
        "transactions_1m": count,
        "transactions_2m": count,
        "transactions_10m": count,
        "distinct_merchants_2m": merchants,
        "total_amount_2m": amount * count,
        "signals": signals,
        "signal_ids": [f"txn:{tx}:{signal}" for signal in signals],
        "risk_level": "HIGH" if signals else "LOW",
        "assessment_timestamp": now,
        "evidence_source": "flink",
    }


def publish_outbox(store: FraudStore, worker_id: str) -> int:
    count = 0
    while True:
        batch = store.claim_outbox(worker_id, 50)
        if not batch:
            return count
        for message in batch:
            kafka_produce(message.topic, [(message.key, message.payload)])
            store.mark_published(message.event_id, worker_id)
            count += 1


def pct(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return round(ordered[max(0, int(len(ordered) * q + 0.999999) - 1)], 3)


async def main() -> dict:
    assert os.getenv("LIVE_INVESTIGATIONS_ENABLED", "false") == "false"
    run_id = uuid4().hex[:12]
    prefix = f"part3-{run_id}-"
    events = []
    for index in range(3):
        events.append(
            canonical(
                f"{prefix}normal-{index}",
                f"{prefix}normal",
                f"normal-{index}",
                20 + index,
                index + 1,
                index + 1,
            )
        )
    for index in range(6):
        events.append(
            canonical(f"{prefix}velocity-{index}", f"{prefix}velocity", "repeat", 10 + index, index + 1, 1)
        )
    for index in range(7):
        events.append(
            canonical(
                f"{prefix}hopping-{index}",
                f"{prefix}hopping",
                f"hop-{index}",
                30 + index,
                index + 1,
                index + 1,
            )
        )
    kafka_produce("payments.enriched.demo", [(row["transaction_id"], row) for row in events])
    enriched = kafka_collect("payments.enriched.demo", prefix, 16, f"part3-e2e-{run_id}-enriched")

    store = FraudStore(os.environ["DATABASE_URL"])
    router = DecisionRouter(store)
    offset_base = int(run_id[:8], 16) * 100
    latencies = []
    for index, row in enumerate(enriched):
        raw = json.dumps(row, separators=(",", ":")).encode()
        started = time.perf_counter()
        assert router.process(raw, KafkaPosition("payments.enriched.demo", 0, offset_base + index))
        latencies.append((time.perf_counter() - started) * 1000)
    replay = json.dumps(enriched[0], separators=(",", ":")).encode()
    replay_created = router.process(replay, KafkaPosition("payments.enriched.demo", 0, offset_base + 99))
    assert replay_created is False
    publish_outbox(store, f"e2e-{run_id}-router")
    requests = kafka_collect("fraud.investigations.requested", prefix, 5, f"part3-e2e-{run_id}-requests")

    worker = InvestigationWorker(store, load_settings(mode_override="dry-run"), max_attempts=3)
    for index, request in enumerate(requests):
        raw = json.dumps(request, separators=(",", ":")).encode()
        assert await worker.process(
            raw, KafkaPosition("fraud.investigations.requested", 0, offset_base + 200 + index)
        )
    publish_outbox(store, f"e2e-{run_id}-worker")
    completed = kafka_collect("fraud.investigations.completed", prefix, 5, f"part3-e2e-{run_id}-completed")

    with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
        counts = dict(
            connection.execute(
                """SELECT payment_verdict, count(*) FROM payment_decisions
                   WHERE transaction_id LIKE %s GROUP BY payment_verdict""",
                (prefix + "%",),
            ).fetchall()
        )
        immutable = False
        try:
            with connection.transaction():
                connection.execute(
                    "UPDATE payment_decisions SET payment_verdict='APPROVED' WHERE transaction_id=%s",
                    (f"{prefix}hopping-6",),
                )
        except psycopg.errors.RaiseException:
            immutable = True
        preserved = connection.execute(
            "SELECT payment_verdict FROM payment_decisions WHERE transaction_id=%s",
            (f"{prefix}hopping-6",),
        ).fetchone()[0]
    assert counts == {"APPROVED": 11, "BLOCKED": 3, "CHALLENGED": 2}
    assert immutable and preserved == "BLOCKED"
    assert all(row["mode"] == "dry-run" for row in completed)
    return {
        "run_id": run_id,
        "transactions_processed": 16,
        "decision_counts": counts,
        "investigations_requested": len(requests),
        "investigations_completed": len(completed),
        "normal_bypassed_claude": 11,
        "duplicate_replay_created_decision": replay_created,
        "immutable_overwrite_rejected": immutable,
        "router_latency_ms": {
            "p50": pct(latencies, 0.50),
            "p95": pct(latencies, 0.95),
            "p99": pct(latencies, 0.99),
            "mean": round(statistics.mean(latencies), 3),
        },
    }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main()), sort_keys=True))
