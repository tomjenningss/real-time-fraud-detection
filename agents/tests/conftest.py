from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest

from fraud_agents.config import Settings
from fraud_agents.schemas import InvestigationInput


@pytest.fixture
def normal_dict() -> dict:
    path = Path(__file__).parents[1] / "fixtures" / "normal.json"
    return json.loads(path.read_text())


@pytest.fixture
def normal_event(normal_dict: dict) -> InvestigationInput:
    return InvestigationInput.model_validate(deepcopy(normal_dict))


@pytest.fixture
def dry_settings(tmp_path: Path) -> Settings:
    return Settings(agent_mode="dry-run", audit_directory=tmp_path / "audit")


def make_signal_event(normal_dict: dict, tx: str, signals: list[str], merchants: int = 1):
    value = deepcopy(normal_dict)
    value["flink"].update(
        {
            "transaction_id": tx,
            "transactions_1m": 6,
            "transactions_2m": 6,
            "transactions_10m": 6,
            "distinct_merchants_2m": merchants,
            "signals": signals,
            "signal_ids": [f"txn:{tx}:{signal}" for signal in signals],
            "risk_level": "HIGH",
        }
    )
    return InvestigationInput.model_validate(value)
