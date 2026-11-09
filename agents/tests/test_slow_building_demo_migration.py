from pathlib import Path

MIGRATION = (
    Path(__file__).parents[1]
    / "migrations"
    / "versions"
    / "0021_slow_building_demo.py"
).read_text()


def test_replay_manifest_is_additive_immutable_and_isolated() -> None:
    assert 'down_revision = "0020_fraud_discovery_diagnostics"' in MIGRATION
    assert "CREATE TABLE slow_building_demo_runs" in MIGRATION
    assert "payments.raw.slow-building-replay" in MIGRATION
    assert "payments.enriched.slow-building-replay" in MIGRATION
    assert "slow_building_demo_runs_immutable" in MIGRATION
    assert "reject_banking_immutable_mutation" in MIGRATION
    assert "UPDATE payment_decisions" not in MIGRATION
    assert "UPDATE banking_accounts" not in MIGRATION
    assert "DELETE FROM" not in MIGRATION
