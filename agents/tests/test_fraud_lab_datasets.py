from __future__ import annotations

import uuid
from collections import defaultdict
from contextlib import nullcontext

import pytest

from fraud_agents.fraud_lab import dataset_worker
from fraud_agents.fraud_lab.datasets import (
    ALLOWED_TRANSACTION_COUNTS,
    build_dataset_spec,
    dataset_wave_id,
    deterministic_seed,
)
from fraud_agents.fraud_lab.synthetic import generate_wave, wave_summary


@pytest.mark.parametrize("transaction_count", sorted(ALLOWED_TRANSACTION_COUNTS))
def test_supported_dataset_sizes_are_exact_deterministic_and_group_safe(
    transaction_count: int,
) -> None:
    dataset_id = uuid.uuid5(uuid.NAMESPACE_URL, f"fraud-lab-test:{transaction_count}")
    seed = deterministic_seed(dataset_id)
    spec = build_dataset_spec(dataset_id, transaction_count, seed)
    first, first_digest = generate_wave(spec)
    second, second_digest = generate_wave(spec)

    assert first == second
    assert first_digest == second_digest
    assert len(first_digest) == 64
    assert spec.wave_id == dataset_wave_id(dataset_id)
    summary = wave_summary(spec, first, first_digest)
    assert summary["row_count"] == transaction_count
    assert summary["discovery_count"] == transaction_count * 7 // 10
    assert summary["evaluation_count"] == transaction_count * 3 // 10

    group_partitions: dict[str, set[str]] = defaultdict(set)
    for row in first:
        group_partitions[row.scenario_group_id].add(row.partition)
    assert all(len(partitions) == 1 for partitions in group_partitions.values())


def test_dataset_spec_rejects_unbounded_sizes_and_invalid_seeds() -> None:
    dataset_id = uuid.uuid4()
    with pytest.raises(ValueError, match="unsupported"):
        build_dataset_spec(dataset_id, 9_000, 1)
    with pytest.raises(ValueError, match="seed"):
        build_dataset_spec(dataset_id, 8_000, -1)


def test_generation_failure_marks_claim_failed_without_partial_persistence(monkeypatch) -> None:
    class FakeConnection:
        def __init__(self) -> None:
            self.executed: list[tuple[str, tuple[object, ...]]] = []

        def transaction(self):
            return nullcontext()

        def execute(self, statement: str, parameters: tuple[object, ...]):
            self.executed.append((statement, parameters))

    connection = FakeConnection()
    dataset_id = uuid.uuid4()
    monkeypatch.setattr(
        dataset_worker,
        "generate_wave",
        lambda _spec: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    monkeypatch.setattr(
        dataset_worker,
        "_persist_generated_dataset",
        lambda *_args: pytest.fail("failed generation must not persist a wave"),
    )
    with pytest.raises(RuntimeError, match="boom"):
        dataset_worker.generate_claimed_dataset(
            connection,  # type: ignore[arg-type]
            {
                "dataset_id": dataset_id,
                "requested_transaction_count": 8_000,
                "seed": 42,
                "fraud_scenario_id": "multi_new_beneficiary",
            },
        )
    assert len(connection.executed) == 1
    statement, parameters = connection.executed[0]
    assert "SET status = 'FAILED'" in statement
    assert parameters == ("RUNTIMEERROR", dataset_id)
