from __future__ import annotations

from collections import defaultdict

from fraud_agents.fraud_lab.agentic import (
    AgenticWaveSpec,
    agentic_wave_summary,
    generate_agentic_wave,
)


def test_agentic_wave_is_reproducible_and_group_safe() -> None:
    spec = AgenticWaveSpec(rows=600, customers=30)
    first, first_digest = generate_agentic_wave(spec)
    second, second_digest = generate_agentic_wave(spec)
    assert first == second
    assert first_digest == second_digest
    summary = agentic_wave_summary(spec, first, first_digest)
    assert summary["discovery_count"] == 360
    assert summary["validation_count"] == 120
    assert summary["final_holdout_count"] == 120

    partitions: dict[str, set[str]] = defaultdict(set)
    for row in first:
        partitions[row.scenario_group_id].add(row.partition)
    assert all(len(values) == 1 for values in partitions.values())


def test_final_holdout_cannot_be_selected_by_agent_accessible_partitions() -> None:
    rows, _ = generate_agentic_wave(AgenticWaveSpec(rows=600, customers=30))
    accessible = [row for row in rows if row.partition in {"DISCOVERY", "VALIDATION"}]
    assert accessible
    assert all(row.partition != "FINAL_HOLDOUT" for row in accessible)
    assert any(row.partition == "FINAL_HOLDOUT" for row in rows)
