from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

MIGRATION_PATH = (
    Path(__file__).parents[1] / "migrations" / "versions" / "0007_glaramara_phase_b.py"
)


def load_migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("glaramara_phase_b_migration", MIGRATION_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_phase_b_projection_preserves_deterministic_authority(monkeypatch) -> None:
    migration = load_migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)

    migration.upgrade()

    ddl = "\n".join(statements)
    assert migration.down_revision == "0006_glaramara_banking"
    assert "CREATE VIEW banking_payment_status" in ddl
    assert "LEFT JOIN payment_decisions decision" in ddl
    assert "decision.payment_verdict" in ddl
    assert "'PENDING'" in ddl
    assert "fraud_shadow" not in ddl
    assert "banking_payment_raw" in ddl


def test_phase_b_downgrade_removes_only_additive_projection(monkeypatch) -> None:
    migration = load_migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)

    migration.downgrade()

    assert statements == [
        "DROP VIEW banking_payment_status",
        "DROP INDEX outbox_events_aggregate_idx",
    ]
