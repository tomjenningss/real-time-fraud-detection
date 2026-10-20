from __future__ import annotations

import os
from dataclasses import dataclass


def _positive_int(name: str, default: int) -> int:
    value = int(os.getenv(name, str(default)))
    if value < 1:
        raise ValueError(f"{name} must be positive")
    return value


@dataclass(frozen=True)
class ServiceConfig:
    database_url: str
    brokers: str
    router_group: str
    worker_group: str
    live_enabled: bool
    live_approved: bool
    max_investigations_per_run: int
    max_investigation_attempts: int
    worker_concurrency: int
    normal_sample_rate: float
    router_auto_offset_reset: str
    router_expected_start_offsets: dict[int, int]
    worker_auto_offset_reset: str
    worker_expected_start_offsets: dict[int, int]

    @classmethod
    def from_env(cls) -> ServiceConfig:
        database_url = os.getenv("DATABASE_URL")
        if not database_url:
            raise ValueError("DATABASE_URL is required")
        sample_rate = float(os.getenv("NORMAL_INVESTIGATION_SAMPLE_RATE", "0"))
        if not 0 <= sample_rate <= 1:
            raise ValueError("NORMAL_INVESTIGATION_SAMPLE_RATE must be between 0 and 1")
        auto_offset_reset = os.getenv("ROUTER_AUTO_OFFSET_RESET", "latest")
        if auto_offset_reset not in {"earliest", "latest"}:
            raise ValueError("ROUTER_AUTO_OFFSET_RESET must be earliest or latest")
        expected_offsets = _offsets(os.getenv("ROUTER_EXPECTED_START_OFFSETS", ""))
        worker_auto_offset_reset = os.getenv("INVESTIGATION_AUTO_OFFSET_RESET", "latest")
        if worker_auto_offset_reset not in {"earliest", "latest"}:
            raise ValueError("INVESTIGATION_AUTO_OFFSET_RESET must be earliest or latest")
        return cls(
            database_url=database_url,
            brokers=os.getenv("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092"),
            router_group=os.getenv("ROUTER_GROUP_ID", "fraud-decision-router-v1"),
            worker_group=os.getenv("INVESTIGATION_GROUP_ID", "fraud-investigation-worker-v1"),
            live_enabled=os.getenv("LIVE_INVESTIGATIONS_ENABLED", "false").lower() == "true",
            live_approved=os.getenv("LIVE_INVESTIGATIONS_APPROVED", "false").lower() == "true",
            max_investigations_per_run=_positive_int("MAX_INVESTIGATIONS_PER_RUN", 1),
            max_investigation_attempts=_positive_int("MAX_INVESTIGATION_ATTEMPTS", 3),
            worker_concurrency=_positive_int("INVESTIGATION_CONCURRENCY", 1),
            normal_sample_rate=sample_rate,
            router_auto_offset_reset=auto_offset_reset,
            router_expected_start_offsets=expected_offsets,
            worker_auto_offset_reset=worker_auto_offset_reset,
            worker_expected_start_offsets=_offsets(
                os.getenv("INVESTIGATION_EXPECTED_START_OFFSETS", "")
            ),
        )

    @property
    def agent_mode(self) -> str:
        if self.live_enabled and self.live_approved:
            return "live"
        if self.live_enabled != self.live_approved:
            raise ValueError(
                "live mode requires both LIVE_INVESTIGATIONS_ENABLED and LIVE_INVESTIGATIONS_APPROVED"
            )
        return "dry-run"


def _offsets(value: str) -> dict[int, int]:
    if not value:
        return {}
    result = {}
    for item in value.split(","):
        partition, offset = item.split(":", 1)
        partition_number, offset_number = int(partition), int(offset)
        if partition_number < 0 or offset_number < 0 or partition_number in result:
            raise ValueError("Kafka expected-start offsets are invalid")
        result[partition_number] = offset_number
    return result
