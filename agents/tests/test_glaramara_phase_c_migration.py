from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

MIGRATION_PATH = Path(__file__).parents[1] / "migrations" / "versions" / "0010_glaramara_phase_c.py"


def load_migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("glaramara_phase_c_migration", MIGRATION_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_phase_c_schema_is_additive_auditable_and_conservative(monkeypatch) -> None:
    migration = load_migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)

    migration.upgrade()

    ddl = "\n".join(statements)
    assert migration.down_revision == "0009_release_banking_watermarks"
    for table in (
        "customer_fraud_investigations",
        "customer_fraud_investigation_events",
        "customer_questionnaire_answers",
        "fraud_intelligence_extractions",
        "customer_fraud_reassessments",
    ):
        assert f"CREATE TABLE {table}" in ddl

    assert "original_payment_verdict = 'CHALLENGED'" in ddl
    assert "agent_invocation_count BETWEEN 0 AND 2" in ddl
    assert "outcome IN ('CLEARED','REQUIRES_FURTHER_REVIEW','DECLINED')" in ddl
    assert "ledger_effect = 'NONE'" in ddl
    assert "CHECK (is_simulated)" in ddl
    assert "UPDATE payment_decisions" not in ddl
    assert "UPDATE banking_accounts" not in ddl


def test_phase_c_evidence_and_history_are_immutable(monkeypatch) -> None:
    migration = load_migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)

    migration.upgrade()
    ddl = "\n".join(statements)

    for table in (
        "customer_fraud_investigation_events",
        "customer_questionnaire_answers",
        "fraud_intelligence_extractions",
        "customer_fraud_reassessments",
    ):
        assert f"CREATE TRIGGER {table}_immutable" in ddl
    assert "customer investigation identity and provenance are immutable" in ddl
