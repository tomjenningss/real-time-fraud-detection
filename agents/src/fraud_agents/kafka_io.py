from __future__ import annotations

import json
import socket
import time
from collections.abc import Callable

from confluent_kafka import Consumer, KafkaError, KafkaException, Producer, TopicPartition

from .database import FraudStore


def consumer_config(
    brokers: str, group_id: str, *, auto_offset_reset: str = "earliest"
) -> dict[str, object]:
    return {
        "bootstrap.servers": brokers,
        "group.id": group_id,
        "enable.auto.commit": False,
        "auto.offset.reset": auto_offset_reset,
        "isolation.level": "read_committed",
    }


def await_assignment_and_validate(
    consumer: Consumer,
    *,
    expected_start_offsets: dict[int, int],
    buffered_messages: list | None = None,
    role: str = "router",
    expected_offsets_variable: str = "ROUTER_EXPECTED_START_OFFSETS",
    timeout_seconds: float = 60,
) -> dict[int, int]:
    """Wait for assignment; validate only a brand-new group's initial latest boundary."""
    deadline = time.monotonic() + timeout_seconds
    assignment = []
    while time.monotonic() < deadline:
        message = consumer.poll(0.25)
        if message is not None and buffered_messages is not None:
            buffered_messages.append(message)
        assignment = consumer.assignment()
        if assignment:
            break
    if not assignment:
        raise TimeoutError(f"{role} did not receive Kafka partition assignments")
    committed = consumer.committed(assignment, timeout=5)
    valid_committed = [item for item in committed if item.offset >= 0]
    if valid_committed:
        if len(valid_committed) != len(assignment):
            raise RuntimeError(f"{role} group has only partially committed partition offsets")
        return {item.partition: item.offset for item in valid_committed}
    if not expected_start_offsets:
        raise RuntimeError(f"new {role} group requires {expected_offsets_variable}")
    assigned_partitions = {item.partition for item in assignment}
    if set(expected_start_offsets) != assigned_partitions:
        raise RuntimeError(
            f"{role} assigned partitions {sorted(assigned_partitions)} do not match intended "
            f"boundary partitions {sorted(expected_start_offsets)}"
        )
    for item in assignment:
        _low, high = consumer.get_watermark_offsets(item, timeout=5)
        expected = expected_start_offsets[item.partition]
        if high != expected:
            raise RuntimeError(
                f"{role} partition {item.partition} end offset {high} does not match intended "
                f"boundary {expected}"
            )
        consumer.seek(TopicPartition(item.topic, item.partition, expected))
    return dict(expected_start_offsets)


def consume_forever(
    consumer: Consumer,
    handler: Callable,
    poll_seconds: float = 1.0,
    initial_messages: list | None = None,
) -> None:
    try:
        pending = list(initial_messages or [])
        while True:
            message = pending.pop(0) if pending else consumer.poll(poll_seconds)
            if message is None:
                continue
            if message.error():
                if message.error().code() == KafkaError._PARTITION_EOF:
                    continue
                raise KafkaException(message.error())
            handler(message)
            consumer.commit(message=message, asynchronous=False)
    except KeyboardInterrupt:
        pass
    finally:
        consumer.close()


class OutboxPublisher:
    def __init__(
        self,
        store: FraudStore,
        producer: Producer,
        worker_id: str | None = None,
        created_after=None,
    ):
        self.store = store
        self.producer = producer
        self.worker_id = worker_id or f"{socket.gethostname()}-{id(self)}"
        self.created_after = created_after

    def publish_batch(self, limit: int = 50) -> int:
        messages = self.store.claim_outbox(
            self.worker_id, limit, created_after=self.created_after
        )
        published = 0
        for message in messages:
            delivery_error: list[Exception] = []

            def delivered(error, _record, errors=delivery_error):
                if error:
                    errors.append(KafkaException(error))

            try:
                self.producer.produce(
                    message.topic,
                    key=message.key,
                    value=json.dumps(message.payload, separators=(",", ":"), sort_keys=True).encode(),
                    headers={"event_id": str(message.event_id), "schema_version": "1.0.0"},
                    on_delivery=delivered,
                )
                remaining = self.producer.flush(10)
                if remaining or delivery_error:
                    raise (
                        delivery_error[0]
                        if delivery_error
                        else TimeoutError("Kafka acknowledgement timed out")
                    )
                self.store.mark_published(message.event_id, self.worker_id)
                published += 1
            except Exception as error:
                self.store.release_outbox(message.event_id, self.worker_id, type(error).__name__, 5)
        return published
