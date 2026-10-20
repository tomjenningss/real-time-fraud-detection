from __future__ import annotations

import asyncio
import json

from confluent_kafka import Consumer

from .config import load_settings
from .database import FraudStore
from .events import KafkaPosition
from .kafka_io import await_assignment_and_validate, consume_forever, consumer_config
from .service_config import ServiceConfig
from .worker import InvestigationWorker


def main() -> None:
    config = ServiceConfig.from_env()
    mode = config.agent_mode
    settings = load_settings(mode_override=mode)
    worker = InvestigationWorker(
        FraudStore(config.database_url), settings, max_attempts=config.max_investigation_attempts
    )
    consumer = Consumer(
        consumer_config(
            config.brokers,
            config.worker_group,
            auto_offset_reset=config.worker_auto_offset_reset,
        )
    )
    consumer.subscribe(["fraud.investigations.requested"])
    buffered_messages = []
    positions = await_assignment_and_validate(
        consumer,
        expected_start_offsets=config.worker_expected_start_offsets,
        buffered_messages=buffered_messages,
        role="investigation worker",
        expected_offsets_variable="INVESTIGATION_EXPECTED_START_OFFSETS",
    )
    print(
        json.dumps(
            {
                "event": "worker_ready",
                "consumer_group": config.worker_group,
                "positions": positions,
                "mode": mode,
            },
            separators=(",", ":"),
        )
    )
    completed = 0

    def handle(message) -> None:
        nonlocal completed
        if completed >= config.max_investigations_per_run:
            raise KeyboardInterrupt
        processed = asyncio.run(
            worker.process(
                message.value(), KafkaPosition(message.topic(), message.partition(), message.offset())
            )
        )
        completed += int(processed)

    consume_forever(consumer, handle, initial_messages=buffered_messages)
