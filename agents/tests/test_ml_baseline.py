from __future__ import annotations

import json
from pathlib import Path

import pytest

from fraud_agents.events import KafkaPosition
from fraud_agents.ml.features import FEATURE_NAMES, from_enriched
from fraud_agents.ml.inference import ShadowScorer, serialise
from fraud_agents.ml.model import BaselineModel, train
from fraud_agents.ml.synthetic import generate


def _event() -> dict:
    return {
        "assessment_type": "transaction",
        "transaction_id": "tx-1",
        "user_id": "u-1",
        "amount": 10,
        "merchant_id": "m-1",
        "transaction_timestamp": "2025-01-01T00:00:00Z",
        "transactions_1m": 1,
        "transactions_2m": 2,
        "transactions_10m": 3,
        "distinct_merchants_2m": 1,
        "total_amount_2m": 25,
        "signals": [],
        "signal_ids": [],
        "risk_level": "LOW",
        "assessment_timestamp": "2025-01-01T00:00:01Z",
        "evidence_source": "flink",
    }


def test_feature_order_and_derived_values():
    vector = from_enriched(_event())
    assert len(vector.values) == len(FEATURE_NAMES)
    assert vector.values[FEATURE_NAMES.index("mean_amount_2m")] == 12.5
    assert vector.values[FEATURE_NAMES.index("merchant_diversity_2m")] == 0.5


def test_invalid_contract_is_rejected():
    event = _event()
    del event["transactions_2m"]
    with pytest.raises(ValueError, match="invalid payments"):
        from_enriched(event)


def test_generation_is_reproducible_and_split_has_no_customer_leakage(tmp_path: Path):
    first, second = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    generate(first, 500, 7)
    generate(second, 500, 7)
    assert first.read_bytes() == second.read_bytes()
    owners = {}
    for line in first.read_text().splitlines():
        row = json.loads(line)
        owners.setdefault(row["customer_id"], set()).add(row["split"])
        assert "signals" not in row and "risk_level" not in row and "transaction_id" not in row
    assert all(len(splits) == 1 for splits in owners.values())


def test_training_loading_scoring_serialisation_and_idempotency(tmp_path: Path):
    dataset, artifact = tmp_path / "data.jsonl", tmp_path / "model"
    generate(dataset, 1500, 9)
    metadata = train(dataset, artifact, seed=9, threads=1)
    model = BaselineModel.load(artifact)
    scorer = ShadowScorer(model)
    position = KafkaPosition("payments.enriched.demo", 0, 5)
    first, duplicate = (
        scorer.score(json.dumps(_event()).encode(), position),
        scorer.score(json.dumps(_event()).encode(), position),
    )
    assert 0 <= first["fraud_probability"] <= 1
    assert first["event_id"] == duplicate["event_id"]
    assert json.loads(serialise(first))["model_version"] == metadata["model_version"]


def test_model_feature_mismatch_fails_closed(tmp_path: Path):
    dataset, artifact = tmp_path / "data.jsonl", tmp_path / "model"
    generate(dataset, 1000, 11)
    train(dataset, artifact, seed=11, threads=1)
    metadata_path = artifact / "metadata.json"
    metadata = json.loads(metadata_path.read_text())
    metadata["feature_names"] = ["wrong"]
    metadata_path.write_text(json.dumps(metadata))
    with pytest.raises(ValueError, match="feature order"):
        BaselineModel.load(artifact)


def test_training_is_reproducible(tmp_path: Path):
    dataset = tmp_path / "data.jsonl"
    first_artifact, second_artifact = tmp_path / "first", tmp_path / "second"
    generate(dataset, 1000, 13)
    train(dataset, first_artifact, seed=13, threads=1)
    train(dataset, second_artifact, seed=13, threads=1)
    vector = from_enriched(_event())
    assert BaselineModel.load(first_artifact).score(vector) == pytest.approx(
        BaselineModel.load(second_artifact).score(vector), abs=1e-12
    )
