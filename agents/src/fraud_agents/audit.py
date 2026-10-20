from __future__ import annotations

import json
from pathlib import Path

from .schemas import AuditRecord


def persist_audit(record: AuditRecord, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / f"{record.investigation_id}.json"
    target.write_text(json.dumps(record.model_dump(mode="json"), separators=(",", ":")) + "\n")
    target.chmod(0o600)
    return target
