import importlib.util
from pathlib import Path

MIGRATION_PATH = Path(__file__).parents[1] / "migrations" / "versions" / "0016_agentic_investigation_lab.py"


def test_agentic_investigation_migration_is_additive_and_partitioned(monkeypatch) -> None:
    spec = importlib.util.spec_from_file_location("agentic_investigation_migration", MIGRATION_PATH)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    statements: list[str] = []
    monkeypatch.setattr(migration.op, "execute", statements.append)
    migration.upgrade()
    sql = "\n".join(statements)
    assert migration.down_revision == "0015_fraud_guidance"
    assert "fraud_investigation_waves" in sql
    assert "FINAL_HOLDOUT" in sql
    assert "immutable" in sql
