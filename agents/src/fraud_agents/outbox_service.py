from __future__ import annotations

import os
import time
from datetime import datetime

from confluent_kafka import Producer

from .database import FraudStore
from .kafka_io import OutboxPublisher
from .service_config import ServiceConfig


def main() -> None:
    config = ServiceConfig.from_env()
    created_after_value = os.getenv("OUTBOX_CREATED_AFTER")
    created_after = datetime.fromisoformat(created_after_value) if created_after_value else None
    publisher = OutboxPublisher(
        FraudStore(config.database_url),
        Producer({"bootstrap.servers": config.brokers}),
        created_after=created_after,
    )
    try:
        while True:
            if publisher.publish_batch() == 0:
                time.sleep(0.5)
    except KeyboardInterrupt:
        return
