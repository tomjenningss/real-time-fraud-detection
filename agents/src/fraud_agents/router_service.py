from __future__ import annotations

import json
import time

from confluent_kafka import Consumer

from .database import FraudStore
from .events import KafkaPosition
from .kafka_io import await_assignment_and_validate, consume_forever, consumer_config
from .metrics import LatencyWindow
from .router import DecisionRouter
from .service_config import ServiceConfig


def main() -> None:
    config = ServiceConfig.from_env()
    store = FraudStore(config.database_url)
    router = DecisionRouter(store, normal_sample_rate=config.normal_sample_rate)
    consumer = Consumer(
        consumer_config(
            config.brokers,
            config.router_group,
            auto_offset_reset=config.router_auto_offset_reset,
        )
    )
    consumer.subscribe(["payments.enriched.demo"])
    buffered_messages = []
    positions = await_assignment_and_validate(
        consumer,
        expected_start_offsets=config.router_expected_start_offsets,
        buffered_messages=buffered_messages,
    )
    print(
        json.dumps(
            {
                "event": "router_ready",
                "consumer_group": config.router_group,
                "positions": positions,
            },
            separators=(",", ":"),
        )
    )
    latencies = LatencyWindow()

    def handle(message) -> None:
        started = time.perf_counter()
        router.process(
            message.value(),
            KafkaPosition(message.topic(), message.partition(), message.offset()),
        )
        latencies.observe((time.perf_counter() - started) * 1000)
        print(json.dumps({"event": "router_latency", **latencies.snapshot()}, separators=(",", ":")))

    consume_forever(consumer, handle, initial_messages=buffered_messages)
