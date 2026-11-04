from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import astuple

import psycopg
from psycopg.rows import dict_row

from .datasets import build_dataset_spec
from .synthetic import generate_wave, wave_summary

POLL_SECONDS = 1.0
STALE_GENERATION_MINUTES = 10


def claim_next_dataset(connection: psycopg.Connection) -> dict[str, object] | None:
    with connection.transaction(), connection.cursor(row_factory=dict_row) as cursor:
        cursor.execute(
            """UPDATE fraud_lab_datasets
               SET status = 'FAILED', failure_code = 'WORKER_INTERRUPTED'
               WHERE status = 'GENERATING'
                 AND generation_started_at < now() - make_interval(mins => %s)""",
            (STALE_GENERATION_MINUTES,),
        )
        cursor.execute(
            """SELECT dataset_id, requested_transaction_count, seed, fraud_scenario_id
               FROM fraud_lab_datasets
               WHERE status = 'PENDING'
               ORDER BY requested_at, dataset_id
               FOR UPDATE SKIP LOCKED LIMIT 1"""
        )
        dataset = cursor.fetchone()
        if not dataset:
            return None
        cursor.execute(
            """UPDATE fraud_lab_datasets
               SET status = 'GENERATING', generation_started_at = now()
               WHERE dataset_id = %s""",
            (dataset["dataset_id"],),
        )
        return dict(dataset)


def _persist_generated_dataset(
    connection: psycopg.Connection,
    dataset_id: uuid.UUID,
    rows: list,
    summary: dict[str, object],
) -> None:
    with connection.transaction(), connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"fraud-lab-dataset:{dataset_id}",),
        )
        cursor.execute(
            """INSERT INTO fraud_lab_waves
               (wave_id, dataset_schema_version, generator_version, seed, period_start, period_end,
                row_count, discovery_count, evaluation_count, content_sha256)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            tuple(summary.values()),
        )
        cursor.executemany(
            """INSERT INTO fraud_lab_transactions
               (transaction_id, wave_id, partition, scenario_group_id, event_time, customer_id,
                beneficiary_id, merchant_id, amount, ground_truth_fraud,
                beneficiary_payment_count_before, transactions_1m, transactions_2m, transactions_10m,
                distinct_merchants_2m, total_amount_2m, distinct_new_beneficiaries_24h,
                new_beneficiary_payments_24h, new_beneficiary_total_24h,
                beneficiary_distinct_customers_24h, baseline_signals, baseline_action)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                       %s, %s, %s, %s, %s::jsonb, %s)""",
            [(*astuple(row)[:-2], json.dumps(row.baseline_signals), row.baseline_action) for row in rows],
        )
        cursor.execute(
            """INSERT INTO fraud_lab_dataset_waves (dataset_id, wave_id, ordinal)
               VALUES (%s, %s, 1)""",
            (dataset_id, summary["wave_id"]),
        )
        cursor.execute(
            """UPDATE fraud_lab_datasets
               SET status = 'READY', actual_transaction_count = %s, content_sha256 = %s,
                   generated_at = now(), failure_code = NULL
               WHERE dataset_id = %s AND status = 'GENERATING'""",
            (summary["row_count"], summary["content_sha256"], dataset_id),
        )
        if cursor.rowcount != 1:
            raise RuntimeError("fraud lab dataset generation claim was lost")


def generate_claimed_dataset(connection: psycopg.Connection, dataset: dict[str, object]) -> None:
    dataset_id = dataset["dataset_id"]
    if not isinstance(dataset_id, uuid.UUID):
        dataset_id = uuid.UUID(str(dataset_id))
    try:
        spec = build_dataset_spec(
            dataset_id,
            int(dataset["requested_transaction_count"]),
            int(dataset["seed"]),
        )
        if dataset["fraud_scenario_id"] != spec.pattern:
            raise ValueError("unsupported fraud lab scenario")
        rows, digest = generate_wave(spec)
        summary = wave_summary(spec, rows, digest)
        _persist_generated_dataset(connection, dataset_id, rows, summary)
        print(
            json.dumps(
                {"event": "fraud_lab_dataset_ready", "dataset_id": str(dataset_id), **summary},
                default=str,
            )
        )
    except Exception as error:
        with connection.transaction():
            connection.execute(
                """UPDATE fraud_lab_datasets
                   SET status = 'FAILED', failure_code = %s
                   WHERE dataset_id = %s AND status = 'GENERATING'""",
                (type(error).__name__[:80].upper(), dataset_id),
            )
        raise


def run_once(connection: psycopg.Connection) -> bool:
    dataset = claim_next_dataset(connection)
    if not dataset:
        return False
    generate_claimed_dataset(connection, dataset)
    return True


def main() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")
    with psycopg.connect(database_url) as connection:
        connection.execute("SET statement_timeout = '120s'")
        connection.execute("SET lock_timeout = '5s'")
        connection.commit()
        print(json.dumps({"event": "fraud_lab_dataset_worker_ready"}))
        while True:
            try:
                if not run_once(connection):
                    time.sleep(POLL_SECONDS)
            except Exception as error:
                print(json.dumps({"event": "fraud_lab_dataset_failed", "error_type": type(error).__name__}))
                time.sleep(POLL_SECONDS)
