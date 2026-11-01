from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

MIGRATION_PATH = (
    Path(__file__).parents[1] / "migrations" / "versions" / "0006_glaramara_banking.py"
)


def load_migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("glaramara_banking_migration", MIGRATION_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_extends_current_head_and_creates_banking_contract(monkeypatch) -> None:
    migration = load_migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)

    migration.upgrade()

    ddl = "\n".join(statements)
    assert migration.down_revision == "0005_shadow_decision_engine"
    for table in (
        "banking_customers",
        "banking_accounts",
        "banking_beneficiaries",
        "banking_demo_locations",
        "banking_transactions",
        "banking_payment_attempts",
    ):
        assert f"CREATE TABLE {table}" in ddl

    assert "CHECK (ledger_effect = 'NONE')" in ddl
    assert "CHECK (is_simulated)" in ddl
    assert "banking_transactions_immutable" in ddl
    assert "banking_payment_attempts_immutable" in ddl
    assert "banking_accounts_balance_immutable" in ddl
    assert "UNIQUE (customer_id, idempotency_key)" in ddl
    assert "jsonb_typeof(raw_event_payload) = 'object'" in ddl
    assert "jsonb_typeof(trusted_context_snapshot) = 'object'" in ddl


def test_seed_is_deterministic_idempotent_and_matches_approved_alex_fixture() -> None:
    migration = load_migration()
    seed_sql = "\n".join(migration.SEED_STATEMENTS)

    assert len(migration.SEED_STATEMENTS) == 5
    assert all("ON CONFLICT" in statement for statement in migration.SEED_STATEMENTS)
    assert seed_sql.count("@example.test") == 3

    assert "'alex-morgan', 'Alex', 'Morgan', 'AM'" in seed_sql
    assert "'Glaramara Current Account', '041120', '00007281', 'GBP', 24862.80, '7281'" in seed_sql
    assert "'Sam Bennett', 'SB', '040941', '82645281'" in seed_sql
    assert "'Chloe Williams', 'CW', '201625', '49018272'" in seed_sql

    for transaction_name in (
        "Whole Foods Market",
        "Pret A Manger",
        "Salary · Fable Studio",
        "South Western Railway",
        "The Coffee Lab",
        "Rent · High Street Homes",
        "Tesco Express",
        "British Gas",
    ):
        assert transaction_name in seed_sql

    assert "'alex-usual-london'" in seed_sql
    assert "'alex-unusual-keswick'" in seed_sql


def test_downgrade_removes_only_banking_objects_in_dependency_order(monkeypatch) -> None:
    migration = load_migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)

    migration.downgrade()

    assert statements[:6] == [
        "DROP TABLE banking_payment_attempts",
        "DROP TABLE banking_transactions",
        "DROP TABLE banking_demo_locations",
        "DROP TABLE banking_beneficiaries",
        "DROP TABLE banking_accounts",
        "DROP TABLE banking_customers",
    ]
    assert not any("fraud_" in statement or "payment_decisions" in statement for statement in statements)
