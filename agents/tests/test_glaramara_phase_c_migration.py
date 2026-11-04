from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

MIGRATION_PATH = Path(__file__).parents[1] / "migrations" / "versions" / "0010_glaramara_phase_c.py"
REASSESSMENT_MIGRATION_PATH = (
    Path(__file__).parents[1]
    / "migrations"
    / "versions"
    / "0014_evidence_driven_reassessment.py"
)
GUIDANCE_MIGRATION_PATH = (
    Path(__file__).parents[1]
    / "migrations"
    / "versions"
    / "0015_fraud_prevention_guidance.py"
)


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


def test_evidence_driven_reassessment_adds_versioned_trace_and_compatible_outcomes(
    monkeypatch,
) -> None:
    spec = importlib.util.spec_from_file_location(
        "evidence_reassessment_migration",
        REASSESSMENT_MIGRATION_PATH,
    )
    assert spec is not None
    assert spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)

    migration.upgrade()

    ddl = "\n".join(statements)
    assert migration.down_revision == "0013_fraud_intel_view"
    assert "ADD COLUMN policy_trace jsonb NOT NULL" in ddl
    assert "ADDITIONAL_VERIFICATION" in ddl
    assert "REFER_TO_ANALYST" in ddl
    assert "'CLEARED', 'REQUIRES_FURTHER_REVIEW', 'DECLINED'" in ddl
    assert "payment_decisions" not in ddl
    assert "banking_accounts" not in ddl


def test_guidance_migration_is_additive_versioned_and_historically_compatible(monkeypatch) -> None:
    spec = importlib.util.spec_from_file_location("fraud_guidance_migration", GUIDANCE_MIGRATION_PATH)
    assert spec is not None
    assert spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)

    migration.upgrade()

    ddl = "\n".join(statements)
    assert migration.down_revision == "0014_evidence_reassessment"
    assert "ADD COLUMN guidance_contract_version text" in ddl
    assert "ADD COLUMN guidance_payload jsonb" in ddl
    assert "fraud-prevention-guidance/1.0.0" in ddl
    assert "guidance_contract_version IS NULL AND guidance_payload IS NULL" in ddl
    assert "payment_decisions" not in ddl
    assert "banking_accounts" not in ddl
