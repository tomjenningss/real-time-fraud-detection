from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

MIGRATION_PATH = (
    Path(__file__).parents[1] / "migrations" / "versions" / "0008_raw_event_time_clock.py"
)


def load_migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("raw_event_time_clock_migration", MIGRATION_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_clock_is_single_stream_and_additive(monkeypatch) -> None:
    migration = load_migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)

    migration.upgrade()

    ddl = "\n".join(statements)
    assert migration.down_revision == "0007_glaramara_phase_b"
    assert "CREATE TABLE raw_event_time_clock" in ddl
    assert "stream_name text PRIMARY KEY" in ddl
    assert "stream_name = 'payments.raw.demo'" in ddl
    assert "last_event_time timestamptz NOT NULL" in ddl


def test_clock_downgrade_is_scoped(monkeypatch) -> None:
    migration = load_migration()
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)

    migration.downgrade()

    assert statements == ["DROP TABLE raw_event_time_clock"]
