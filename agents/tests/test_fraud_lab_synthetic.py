from __future__ import annotations

from collections import defaultdict
from dataclasses import replace

from fraud_agents.fraud_lab.synthetic import INITIAL_SPEC, NEXT_SPEC, generate_wave, wave_summary


def test_wave_is_reproducible_partitioned_and_contains_a_detection_gap() -> None:
    spec = replace(INITIAL_SPEC, rows=2_000, customers=40)
    first, first_hash = generate_wave(spec)
    second, second_hash = generate_wave(spec)
    assert first == second
    assert first_hash == second_hash
    assert wave_summary(spec, first, first_hash)["row_count"] == 2_000

    group_partitions: dict[str, set[str]] = defaultdict(set)
    for row in first:
        group_partitions[row.scenario_group_id].add(row.partition)
    assert all(len(partitions) == 1 for partitions in group_partitions.values())
    assert any(row.ground_truth_fraud and row.baseline_action == "APPROVED" for row in first)
    assert any(not row.ground_truth_fraud and row.distinct_new_beneficiaries_24h >= 3 for row in first)
    assert any(row.baseline_action in {"CHALLENGED", "BLOCKED"} for row in first)
    for partition in ("DISCOVERY", "EVALUATION"):
        partition_rows = [row for row in first if row.partition == partition]
        assert any(row.ground_truth_fraud and row.baseline_action == "APPROVED" for row in partition_rows)
        assert any(
            not row.ground_truth_fraud and row.distinct_new_beneficiaries_24h >= 3
            for row in partition_rows
        )


def test_next_wave_has_partition_isolated_fan_in_and_legitimate_lookalikes() -> None:
    rows, _ = generate_wave(NEXT_SPEC)
    assert NEXT_SPEC.wave_id == "fraud-lab-wave-2027q1-v2"
    assert NEXT_SPEC.period_start.year == 2027
    assert NEXT_SPEC.generator_version == "fraud-lab-generator/1.0.2"
    group_partitions: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        group_partitions[row.scenario_group_id].add(row.partition)
    assert all(len(partitions) == 1 for partitions in group_partitions.values())
    for partition in ("DISCOVERY", "EVALUATION"):
        partition_rows = [row for row in rows if row.partition == partition]
        assert any(
            row.ground_truth_fraud and row.beneficiary_distinct_customers_24h >= 2
            for row in partition_rows
        )
        assert any(
            not row.ground_truth_fraud and row.beneficiary_distinct_customers_24h >= 3
            for row in partition_rows
        )
