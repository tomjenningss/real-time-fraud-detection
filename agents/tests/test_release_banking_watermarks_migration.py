from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

MIGRATION_PATH = (
    Path(__file__).parents[1] / "migrations" / "versions" / "0009_release_banking_watermarks.py"
)


def load_migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("release_banking_watermarks", MIGRATION_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_upgrade_releases_only_pending_banking_markers(monkeypatch) -> None:
    migration = load_migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)

    migration.upgrade()

    ddl = "\n".join(statements)
    assert migration.down_revision == "0008_raw_event_time_clock"
    assert "UPDATE outbox_events" in ddl
    assert "aggregate_type = 'banking_payment_watermark'" in ddl
    assert "status = 'PENDING'" in ddl
    assert "created_at + interval '3 seconds'" in ddl
    assert "banking_payment_raw" not in ddl


def test_downgrade_does_not_delay_operational_rows(monkeypatch) -> None:
    migration = load_migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)

    migration.downgrade()

    assert statements == []
