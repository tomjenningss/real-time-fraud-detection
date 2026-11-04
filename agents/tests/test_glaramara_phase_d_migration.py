from __future__ import annotations

import importlib.util
from pathlib import Path

MIGRATION_PATH = Path(__file__).parents[1] / "migrations" / "versions" / "0011_glaramara_phase_d.py"
SUPERSESSION_MIGRATION_PATH = (
    Path(__file__).parents[1] / "migrations" / "versions" / "0012_fraud_lab_wave_supersession.py"
)
DATASET_MIGRATION_PATH = (
    Path(__file__).parents[1] / "migrations" / "versions" / "0017_configurable_fraud_lab_datasets.py"
)
DATASET_BACKFILL_MIGRATION_PATH = (
    Path(__file__).parents[1] / "migrations" / "versions" / "0018_backfill_fraud_lab_dataset_runs.py"
)
DATASET_INTEGRITY_MIGRATION_PATH = (
    Path(__file__).parents[1] / "migrations" / "versions" / "0019_fraud_lab_active_dataset_integrity.py"
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


def _dataset_migration():
    spec = importlib.util.spec_from_file_location("phase_d_datasets", DATASET_MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _dataset_backfill_migration():
    spec = importlib.util.spec_from_file_location("phase_d_dataset_backfill", DATASET_BACKFILL_MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _dataset_integrity_migration():
    spec = importlib.util.spec_from_file_location(
        "phase_d_dataset_integrity", DATASET_INTEGRITY_MIGRATION_PATH
    )
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


def test_configurable_datasets_are_additive_activated_and_snapshot_safe(monkeypatch) -> None:
    migration = _dataset_migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)
    migration.upgrade()
    ddl = "\n".join(statements)
    assert migration.down_revision == "0016_agentic_lab"
    for table in (
        "fraud_lab_datasets",
        "fraud_lab_dataset_waves",
        "fraud_lab_active_datasets",
        "fraud_lab_dataset_activation_events",
    ):
        assert f"CREATE TABLE {table}" in ddl
    assert "requested_transaction_count IN (8000, 10000, 20000)" in ddl
    assert "fraud_lab_one_generation_per_environment" in ddl
    assert "terminal fraud lab dataset is immutable" in ddl
    assert "only a completed fraud lab dataset can be activated" in ddl
    assert "NEW.dataset_id IS DISTINCT FROM OLD.dataset_id" in ddl
    assert "backfill-existing-8000" in ddl
    assert "DELETE FROM fraud_lab_waves" not in ddl
    assert "UPDATE fraud_rule_backtests" not in ddl


def test_legacy_run_association_matches_exact_immutable_wave_and_count(monkeypatch) -> None:
    migration = _dataset_backfill_migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)
    migration.upgrade()
    ddl = "\n".join(statements)
    assert migration.down_revision == "0017_fraud_lab_datasets"
    assert "run.snapshot_wave_ids = jsonb_build_array(member.wave_id)" in ddl
    assert "run.snapshot_row_count = dataset.actual_transaction_count" in ddl
    assert "NEW.dataset_id IS DISTINCT FROM OLD.dataset_id" in ddl
    assert "UPDATE fraud_rule_backtests" not in ddl
    assert "UPDATE fraud_rule_candidates" not in ddl


def test_active_dataset_is_ready_same_environment_and_cannot_be_deleted(monkeypatch) -> None:
    migration = _dataset_integrity_migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)
    migration.upgrade()
    ddl = "\n".join(statements)
    assert migration.down_revision == "0018_dataset_run_backfill"
    assert "dataset_environment IS DISTINCT FROM NEW.environment_id" in ddl
    assert "fraud_lab_active_dataset_no_delete" in ddl
    assert "BEFORE DELETE ON fraud_lab_active_datasets" in ddl

