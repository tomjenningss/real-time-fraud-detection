#!/usr/bin/env python3
"""Create the ignored local database environment without emitting credentials."""
from __future__ import annotations

import secrets
from pathlib import Path


def main() -> None:
    target = Path(__file__).resolve().parents[1] / ".env"
    if target.exists():
        raise SystemExit("fraud-decisioning/.env already exists; refusing to overwrite it")
    password = secrets.token_hex(32)
    target.write_text(
        "POSTGRES_DB=fraud_demo\n"
        "POSTGRES_USER=fraud_app\n"
        f"POSTGRES_PASSWORD={password}\n"
        "POSTGRES_PORT=5433\n"
        f"DATABASE_URL=postgresql://fraud_app:{password}@localhost:5433/fraud_demo\n"
        "LIVE_INVESTIGATIONS_ENABLED=false\n"
        "LIVE_INVESTIGATIONS_APPROVED=false\n"
    )
    target.chmod(0o600)
    print("Created fraud-decisioning/.env with mode 0600; credential value was not printed.")


if __name__ == "__main__":
    main()
