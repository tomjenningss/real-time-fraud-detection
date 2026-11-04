from __future__ import annotations

import argparse
import json
import os
import uuid
from dataclasses import astuple

import psycopg

from .synthetic import (
    INITIAL_SPEC,
    LEGACY_NEXT_WAVE_ID,
    NAMESPACE,
    NEXT_SPEC,
    REPAIR_SPEC,
    WaveSpec,
    generate_wave,
    wave_summary,
)

LEGACY_DATASET_ID = uuid.UUID("a5d67ed2-e42c-5dcb-8e75-765b36d8299a")


def ensure_seed_dataset(
    connection: psycopg.Connection,
    spec: WaveSpec,
    summary: dict[str, object],
) -> None:
    """Create the initial active dataset when migrations ran before the first wave existed."""
    if spec not in (INITIAL_SPEC, REPAIR_SPEC):
        return
    with connection.transaction(), connection.cursor() as cursor:
        cursor.execute("SELECT to_regclass('fraud_lab_datasets')")
        if cursor.fetchone()[0] is None:
            return
        cursor.execute("SELECT 1 FROM fraud_lab_active_datasets WHERE environment_id = 'glaramara-local'")
        if cursor.fetchone():
            return
        dataset_id = (
            LEGACY_DATASET_ID
            if spec == INITIAL_SPEC
            else uuid.uuid5(NAMESPACE, f"dataset:{spec.wave_id}")
        )
        cursor.execute(
            """INSERT INTO fraud_lab_datasets
               (dataset_id, generator_version, seed, requested_transaction_count,
                actual_transaction_count, fraud_scenario_id, status, content_sha256,
                requested_by, idempotency_key, generation_started_at, generated_at)
               VALUES (%s, %s, %s, 8000, 8000, %s, 'READY', %s,
                       'system-seed', %s, now(), now())
               ON CONFLICT (dataset_id) DO NOTHING""",
            (
                dataset_id,
                summary["generator_version"],
                summary["seed"],
                spec.pattern,
                summary["content_sha256"],
                f"seed:{spec.wave_id}",
            ),
        )
        cursor.execute(
            """INSERT INTO fraud_lab_dataset_waves (dataset_id, wave_id, ordinal)
               VALUES (%s, %s, 1) ON CONFLICT DO NOTHING""",
            (dataset_id, spec.wave_id),
        )
        cursor.execute(
            """INSERT INTO fraud_lab_active_datasets
               (environment_id, dataset_id, activated_by)
               VALUES ('glaramara-local', %s, 'system-seed')""",
            (dataset_id,),
        )
        cursor.execute(
            """INSERT INTO fraud_lab_dataset_activation_events
               (activation_id, environment_id, dataset_id, activated_by)
               VALUES (%s, 'glaramara-local', %s, 'system-seed')""",
            (uuid.uuid5(NAMESPACE, f"activation:{dataset_id}"), dataset_id),
        )


def seed_wave(connection: psycopg.Connection, spec: WaveSpec) -> dict[str, object]:
    rows, digest = generate_wave(spec)
    summary = wave_summary(spec, rows, digest)
    with connection.transaction(), connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"fraud-lab:{spec.wave_id}",),
        )
        cursor.execute(
            """SELECT dataset_schema_version, generator_version, seed, row_count, content_sha256
               FROM fraud_lab_waves WHERE wave_id = %s""",
            (spec.wave_id,),
        )
        existing = cursor.fetchone()
        expected = (
            summary["dataset_schema_version"],
            summary["generator_version"],
            summary["seed"],
            summary["row_count"],
            summary["content_sha256"],
        )
        if existing:
            if tuple(existing) != expected:
                cursor.execute(
                    """SELECT replacement_wave_id FROM fraud_lab_wave_supersessions
                       WHERE superseded_wave_id = %s""",
                    (spec.wave_id,),
                )
                replacement = cursor.fetchone()
                if replacement:
                    return {**summary, "replayed": True, "supersededBy": replacement[0]}
                raise RuntimeError(
                    f"existing immutable fraud lab wave {spec.wave_id} does not match generator"
                )
            cursor.execute("SELECT count(*) FROM fraud_lab_transactions WHERE wave_id = %s", (spec.wave_id,))
            if cursor.fetchone()[0] != spec.rows:
                raise RuntimeError(f"existing fraud lab wave {spec.wave_id} is incomplete")
            return {**summary, "replayed": True}

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
    return {**summary, "replayed": False}


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed an immutable synthetic fraud laboratory wave")
    parser.add_argument("--wave", choices=("initial", "next", "repair-initial"), default="initial")
    args = parser.parse_args()
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")
    spec = INITIAL_SPEC if args.wave == "initial" else NEXT_SPEC if args.wave == "next" else REPAIR_SPEC
    with psycopg.connect(database_url) as connection:
        result = seed_wave(connection, spec)
        ensure_seed_dataset(connection, spec, result)
        if args.wave == "repair-initial":
            with connection.transaction():
                connection.execute(
                    """INSERT INTO fraud_lab_wave_supersessions
                         (superseded_wave_id, replacement_wave_id, reason)
                       SELECT %s, %s, %s WHERE EXISTS (
                         SELECT 1 FROM fraud_lab_waves WHERE wave_id = %s
                       ) ON CONFLICT (superseded_wave_id) DO NOTHING""",
                    (
                        INITIAL_SPEC.wave_id,
                        REPAIR_SPEC.wave_id,
                        "Corrected scenario allocation across discovery and evaluation partitions",
                        INITIAL_SPEC.wave_id,
                    ),
                )
        elif args.wave == "next":
            with connection.transaction():
                connection.execute(
                    """INSERT INTO fraud_lab_wave_supersessions
                         (superseded_wave_id, replacement_wave_id, reason)
                       SELECT %s, %s, %s WHERE EXISTS (
                         SELECT 1 FROM fraud_lab_waves WHERE wave_id = %s
                       ) ON CONFLICT (superseded_wave_id) DO NOTHING""",
                    (
                        LEGACY_NEXT_WAVE_ID,
                        NEXT_SPEC.wave_id,
                        "Corrected the versioned wave period to calendar 2027 Q1",
                        LEGACY_NEXT_WAVE_ID,
                    ),
                )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
