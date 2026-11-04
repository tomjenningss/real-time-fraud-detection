from __future__ import annotations

import os

import psycopg


def main() -> None:
    database_url = os.environ["DATABASE_URL"]
    environment_id = os.getenv("FRAUD_LAB_ENVIRONMENT", "glaramara-local")
    with psycopg.connect(database_url, connect_timeout=3) as connection:
        row = connection.execute(
            """SELECT to_regclass('fraud_lab_datasets') IS NOT NULL,
                      count(*) FILTER (WHERE environment_id = %s)
               FROM fraud_lab_active_datasets""",
            (environment_id,),
        ).fetchone()
    if not row or not row[0] or row[1] != 1:
        raise RuntimeError("Fraud Lab requires exactly one active dataset for this environment")


if __name__ == "__main__":
    main()
