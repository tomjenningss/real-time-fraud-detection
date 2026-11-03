from __future__ import annotations

import importlib.util
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parents[1]
    / "migrations"
    / "versions"
    / "0013_fraud_intelligence_visualiser.py"
)


def _migration():
    spec = importlib.util.spec_from_file_location("fraud_intelligence_visualiser", MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_enrichment_capture_is_additive_to_the_immutable_decision(monkeypatch) -> None:
    migration = _migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)
    migration.upgrade()
    ddl = "\n".join(statements)

    assert migration.down_revision == "0012_fraud_lab_supersession"
    assert len(migration.revision) <= 32
    assert "ALTER TABLE payment_decisions" in ddl
    assert "ADD COLUMN enrichment_evidence jsonb" in ddl
    assert "UPDATE payment_decisions" not in ddl
    assert "banking_accounts" not in ddl


def test_visualiser_migration_downgrade_only_removes_additive_column(monkeypatch) -> None:
    migration = _migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)
    migration.downgrade()

    assert statements == ["ALTER TABLE payment_decisions DROP COLUMN enrichment_evidence"]
