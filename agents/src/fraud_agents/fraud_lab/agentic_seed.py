"""Idempotently seed the isolated agentic investigation laboratory."""

from __future__ import annotations

import json
import os

import psycopg

from .agentic import DEFAULT_AGENTIC_SPEC, AgenticWaveSpec, agentic_wave_summary, generate_agentic_wave


def seed_agentic_wave(
    connection: psycopg.Connection, spec: AgenticWaveSpec = DEFAULT_AGENTIC_SPEC
) -> dict[str, object]:
    rows, digest = generate_agentic_wave(spec)
    summary = agentic_wave_summary(spec, rows, digest)
    with connection.transaction(), connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"agentic-lab:{spec.wave_id}",)
        )
        cursor.execute(
            "SELECT content_sha256, row_count FROM fraud_investigation_waves WHERE wave_id = %s",
            (spec.wave_id,),
        )
        existing = cursor.fetchone()
        if existing:
            if tuple(existing) != (digest, spec.rows):
                raise RuntimeError("existing immutable agentic investigation wave does not match generator")
            return {**summary, "replayed": True}
        cursor.execute(
            """INSERT INTO fraud_investigation_waves
               (wave_id, dataset_schema_version, generator_version, seed, period_start, period_end, row_count,
                discovery_count, validation_count, final_holdout_count, content_sha256)
               VALUES (%(wave_id)s, %(dataset_schema_version)s, %(generator_version)s, %(seed)s,
                       %(period_start)s, %(period_end)s, %(row_count)s, %(discovery_count)s,
                       %(validation_count)s, %(final_holdout_count)s, %(content_sha256)s)""",
            summary,
        )
        cursor.executemany(
            """INSERT INTO fraud_investigation_transactions
               (transaction_id, wave_id, partition, scenario_group_id, event_time, customer_id,
                beneficiary_id,
                merchant_id, amount, ground_truth_fraud, baseline_action, features)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)""",
            [
                (
                    row.transaction_id, row.wave_id, row.partition, row.scenario_group_id, row.event_time,
                    row.customer_id, row.beneficiary_id, row.merchant_id, row.amount, row.ground_truth_fraud,
                    row.baseline_action, json.dumps(row.features, sort_keys=True),
                )
                for row in rows
            ],
        )
    return {**summary, "replayed": False}


def main() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")
    with psycopg.connect(database_url) as connection:
        print(json.dumps(seed_agentic_wave(connection), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
