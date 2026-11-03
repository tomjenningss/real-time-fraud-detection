from __future__ import annotations

import importlib.util
from pathlib import Path

MIGRATION_PATH = Path(__file__).parents[1] / "migrations" / "versions" / "0011_glaramara_phase_d.py"
SUPERSESSION_MIGRATION_PATH = (
    Path(__file__).parents[1] / "migrations" / "versions" / "0012_fraud_lab_wave_supersession.py"
)


def _migration():
    spec = importlib.util.spec_from_file_location("phase_d", MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _supersession_migration():
    spec = importlib.util.spec_from_file_location("phase_d_supersession", SUPERSESSION_MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_phase_d_schema_is_additive_immutable_and_non_authoritative(monkeypatch) -> None:
    migration = _migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)
    migration.upgrade()
    ddl = "\n".join(statements)
    assert migration.down_revision == "0010_glaramara_phase_c"
    for table in (
        "fraud_lab_waves",
        "fraud_lab_transactions",
        "fraud_discovery_runs",
        "fraud_rule_candidates",
        "fraud_rule_backtests",
        "fraud_rule_reviews",
    ):
        assert f"CREATE TABLE {table}" in ddl
    assert "fraud discovery snapshot identity is immutable" in ddl
    assert "APPROVED_FOR_IMPLEMENTATION" in ddl
    assert "UPDATE payment_decisions" not in ddl
    assert "UPDATE banking_accounts" not in ddl


def test_wave_corrections_are_append_only_and_audited(monkeypatch) -> None:
    migration = _supersession_migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)
    migration.upgrade()
    ddl = "\n".join(statements)
    assert migration.down_revision == "0011_glaramara_phase_d"
    assert "CREATE TABLE fraud_lab_wave_supersessions" in ddl
    assert "CREATE TRIGGER fraud_lab_wave_supersessions_immutable" in ddl
    assert "BEFORE UPDATE OR DELETE ON fraud_lab_wave_supersessions" in ddl
    assert "DELETE FROM fraud_lab_waves" not in ddl

