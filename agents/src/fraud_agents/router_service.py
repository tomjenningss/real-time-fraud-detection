from __future__ import annotations

import json
import os
import time

from confluent_kafka import Consumer

from .database import FraudStore
from .events import KafkaPosition
from .kafka_io import await_assignment_and_validate, consume_forever, consumer_config
from .metrics import LatencyWindow
from .router import DecisionRouter
from .service_config import ServiceConfig, _offsets


def main() -> None:
    config = ServiceConfig.from_env()
    decision_topic = os.getenv("ROUTER_DECISION_TOPIC", "fraud.decisions.demo")
    investigation_topic = os.getenv(
        "ROUTER_INVESTIGATION_TOPIC", "fraud.investigations.requested"
    )
    dlq_topic = os.getenv("ROUTER_DLQ_TOPIC", "fraud.decisions.dlq")
    store = FraudStore(
        config.database_url,
        decision_topic=decision_topic,
        investigation_topic=investigation_topic,
    )
    slow_building_demo_policy_enabled = (
        os.getenv("SLOW_BUILDING_DEMO_POLICY_ENABLED", "false").lower() == "true"
    )
    router = DecisionRouter(
        store,
        normal_sample_rate=config.normal_sample_rate,
        slow_building_demo_policy_enabled=slow_building_demo_policy_enabled,
        dlq_topic=dlq_topic,
    )
    consumer = Consumer(
        consumer_config(
            config.brokers,
            config.router_group,
            auto_offset_reset=config.router_auto_offset_reset,
        )
    )
    input_topic = os.getenv("ROUTER_INPUT_TOPIC", "payments.enriched.demo")
    if slow_building_demo_policy_enabled and (
        input_topic != "payments.enriched.slow-building-replay"
        or decision_topic != "fraud.decisions.slow-building-replay"
        or investigation_topic != "fraud.investigations.slow-building-replay"
        or dlq_topic != "fraud.decisions.slow-building-replay.dlq"
    ):
        raise ValueError("slow-building demo policy requires isolated replay topics")
    consumer.subscribe([input_topic])
    buffered_messages = []
    expected_start_offsets = config.router_expected_start_offsets
    expected_offsets_variable = "ROUTER_EXPECTED_START_OFFSETS"
    if slow_building_demo_policy_enabled:
        expected_start_offsets = _offsets(
            os.getenv("SLOW_BUILDING_REPLAY_ROUTER_EXPECTED_START_OFFSETS", "")
        )
        expected_offsets_variable = "SLOW_BUILDING_REPLAY_ROUTER_EXPECTED_START_OFFSETS"
    positions = await_assignment_and_validate(
        consumer,
        expected_start_offsets=expected_start_offsets,
        buffered_messages=buffered_messages,
        expected_offsets_variable=expected_offsets_variable,
    )
    print(
        json.dumps(
            {
                "event": "router_ready",
                "consumer_group": config.router_group,
                "input_topic": input_topic,
                "slow_building_demo_policy_enabled": slow_building_demo_policy_enabled,
                "decision_topic": decision_topic,
                "investigation_topic": investigation_topic,
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
