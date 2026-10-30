from __future__ import annotations

import json
import os
from pathlib import Path

from confluent_kafka import Consumer, KafkaException, Producer

from fraud_agents.events import KafkaPosition
from fraud_agents.kafka_io import await_assignment_and_validate, consumer_config
from fraud_agents.service_config import _offsets

from .inference import ShadowScorer, serialise
from .model import BaselineModel


def _enabled() -> bool:
    return os.getenv("FRAUD_SHADOW_SCORING_ENABLED", "false").lower() == "true"


def main() -> None:
    if not _enabled():
        raise SystemExit("shadow scoring is disabled; set FRAUD_SHADOW_SCORING_ENABLED=true explicitly")
    brokers = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
    input_topic = os.getenv("FRAUD_ML_INPUT_TOPIC", "payments.enriched.demo")
    output_topic = os.getenv("FRAUD_ML_OUTPUT_TOPIC", "fraud.risk.baseline.demo")
    group = os.getenv("FRAUD_ML_GROUP_ID", "fraud-shadow-baseline-v1")
    model = BaselineModel.load(Path(os.getenv("FRAUD_ML_MODEL_DIR", "artifacts/baseline")))
    scorer, producer = (
        ShadowScorer(model),
        Producer({"bootstrap.servers": brokers, "enable.idempotence": True}),
    )
    consumer = Consumer(consumer_config(brokers, group, auto_offset_reset="latest"))
    consumer.subscribe([input_topic])
    buffered_messages = []
    positions = await_assignment_and_validate(
        consumer,
        expected_start_offsets=_offsets(os.getenv("FRAUD_ML_EXPECTED_START_OFFSETS", "")),
        buffered_messages=buffered_messages,
        role="shadow scorer",
        expected_offsets_variable="FRAUD_ML_EXPECTED_START_OFFSETS",
    )
    print(
        json.dumps(
            {
                "event": "shadow_scorer_ready",
                "group": group,
                "model_version": model.metadata["model_version"],
                "positions": positions,
            }
        )
    )
    try:
        pending = list(buffered_messages)
        while True:
            message = pending.pop(0) if pending else consumer.poll(1.0)
            if message is None:
                continue
            if message.error():
                raise KafkaException(message.error())
            try:
                headers = {
                    k: v.decode() if isinstance(v, bytes) else str(v) for k, v in (message.headers() or [])
                }
                event = scorer.score(
                    message.value(),
                    KafkaPosition(message.topic(), message.partition(), message.offset()),
                    headers,
                )
                errors = []

                def delivered(error, _record, delivery_errors=errors):
                    if error:
                        delivery_errors.append(error)

                producer.produce(
                    output_topic,
                    key=event["event_id"],
                    value=serialise(event),
                    headers={"event_id": event["event_id"], "schema_version": event["schema_version"]},
                    on_delivery=delivered,
                )
                if producer.flush(10) or errors:
                    raise RuntimeError("risk event Kafka acknowledgement failed")
                consumer.commit(message=message, asynchronous=False)
            except (ValueError, json.JSONDecodeError) as error:
                # Poison records are logged and committed; scoring remains isolated from authorisation.
                print(
                    json.dumps(
                        {
                            "event": "shadow_score_rejected",
                            "partition": message.partition(),
                            "offset": message.offset(),
                            "error": type(error).__name__,
                        }
                    )
                )
                consumer.commit(message=message, asynchronous=False)
    except KeyboardInterrupt:
        pass
    finally:
        producer.flush(10)
        consumer.close()
