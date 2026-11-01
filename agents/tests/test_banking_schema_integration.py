"""Opt-in tests for the isolated Glaramara PostgreSQL schema."""

from __future__ import annotations

import importlib.util
import os
from decimal import Decimal
from pathlib import Path
from types import ModuleType
from uuid import uuid4

import pytest

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_PART3_POSTGRES_TESTS") != "1",
    reason="requires the approved isolated PostgreSQL database at Alembic head",
)

MIGRATION_PATH = (
    Path(__file__).parents[1] / "migrations" / "versions" / "0006_glaramara_banking.py"
)


def load_migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("glaramara_banking_integration_migration", MIGRATION_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_seed_can_be_replayed_without_duplicates() -> None:
    import psycopg

    migration = load_migration()
    with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
        with connection.transaction(force_rollback=True):
            for statement in migration.SEED_STATEMENTS:
                connection.execute(statement)
            first_counts = tuple(
                connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]  # noqa: S608
                for table in (
                    "banking_customers",
                    "banking_accounts",
                    "banking_beneficiaries",
                    "banking_demo_locations",
                    "banking_transactions",
                )
            )

            for statement in migration.SEED_STATEMENTS:
                connection.execute(statement)
            second_counts = tuple(
                connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]  # noqa: S608
                for table in (
                    "banking_customers",
                    "banking_accounts",
                    "banking_beneficiaries",
                    "banking_demo_locations",
                    "banking_transactions",
                )
            )

            assert first_counts == second_counts
            alex = connection.execute(
                """
                SELECT c.first_name, c.last_name, a.available_balance, a.sort_code,
                       a.account_number, a.card_last_four
                FROM banking_customers c
                JOIN banking_accounts a USING (customer_id)
                WHERE c.demo_slug = 'alex-morgan'
                """
            ).fetchone()
            assert alex == (
                "Alex",
                "Morgan",
                Decimal("24862.80"),
                "041120",
                "00007281",
                "7281",
            )


def test_booked_transactions_and_payment_attempts_are_immutable() -> None:
    import psycopg

    with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
        with pytest.raises(psycopg.Error) as transaction_error, connection.transaction():
            connection.execute(
                """
                UPDATE banking_transactions SET amount = amount + 1
                WHERE transaction_id = '938b6013-7659-5df4-b288-7e458bb97c92'
                """
            )
        assert transaction_error.value.sqlstate == "55000"

        payment_id = uuid4()
        with pytest.raises(psycopg.Error) as attempt_error, connection.transaction():
            connection.execute(
                """
                INSERT INTO banking_payment_attempts
                  (payment_id, transaction_id, customer_id, account_id, beneficiary_id,
                   demo_location_id, amount, payment_reference, idempotency_key, request_sha256,
                   raw_event_payload, trusted_context_snapshot, event_time)
                VALUES
                  (%s, %s, 'cabcc662-0c08-5a82-b350-847e713ca3b7',
                   'a4af9cb1-1c67-599b-93b6-a0233710941a',
                   '1f8a727f-40f8-5b81-b3d7-a52033395fc6',
                   '45bb3ab3-2b73-5bd7-8c8a-d9b8d2398c74', 10.00, 'Test payment', %s,
                   %s, '{}'::jsonb, '{}'::jsonb, now())
                """,
                (payment_id, str(uuid4()), f"test-{payment_id}", "a" * 64),
            )
            connection.execute(
                "UPDATE banking_payment_attempts SET payment_reference = 'Changed' WHERE payment_id = %s",
                (payment_id,),
            )
        assert attempt_error.value.sqlstate == "55000"


def test_demo_balance_cannot_be_changed() -> None:
    import psycopg

    with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
        with pytest.raises(psycopg.Error) as error, connection.transaction():
            connection.execute(
                """
                UPDATE banking_accounts SET available_balance = available_balance - 1
                WHERE account_id = 'a4af9cb1-1c67-599b-93b6-a0233710941a'
                """
            )
        assert error.value.sqlstate == "55000"


def test_phase_b_status_uses_only_authoritative_decision_and_exposes_outbox_recovery() -> None:
    import psycopg
    from psycopg.types.json import Jsonb

    payment_id = uuid4()
    transaction_id = str(payment_id)
    outbox_id = uuid4()
    decision_id = uuid4()
    correlation_id = uuid4()
    with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
        with connection.transaction(force_rollback=True):
            connection.execute(
                """
                INSERT INTO banking_payment_attempts
                  (payment_id, transaction_id, customer_id, account_id, beneficiary_id,
                   demo_location_id, amount, payment_reference, idempotency_key, request_sha256,
                   raw_event_payload, trusted_context_snapshot, event_time)
                VALUES
                  (%s, %s, 'cabcc662-0c08-5a82-b350-847e713ca3b7',
                   'a4af9cb1-1c67-599b-93b6-a0233710941a',
                   '1f8a727f-40f8-5b81-b3d7-a52033395fc6',
                   '45bb3ab3-2b73-5bd7-8c8a-d9b8d2398c74', 19.95, 'Phase B projection', %s,
                   %s, %s, %s, now())
                """,
                (
                    payment_id,
                    transaction_id,
                    f"phase-b-{payment_id}",
                    "b" * 64,
                    Jsonb({"transaction_id": transaction_id}),
                    Jsonb({"ledgerEffect": "NONE", "simulated": True}),
                ),
            )
            connection.execute(
                """
                INSERT INTO outbox_events
                  (event_id, aggregate_type, aggregate_id, destination_topic, message_key,
                   schema_version, payload, attempts, last_error_type)
                VALUES (%s, 'banking_payment_raw', %s, 'payments.raw.demo', %s,
                        '1.0.0', %s, 2, 'KafkaException')
                """,
                (outbox_id, payment_id, transaction_id, Jsonb({"transaction_id": transaction_id})),
            )
            pending = connection.execute(
                """
                SELECT payment_status, publication_status, publication_attempts,
                       publication_last_error_type
                FROM banking_payment_status WHERE payment_id = %s
                """,
                (payment_id,),
            ).fetchone()
            assert pending == ("PENDING", "PENDING", 2, "KafkaException")

            decision_payload = {
                "triggered_rule_ids": [],
                "investigation_required": False,
                "policy_version": "fast-path-policy/1.0.0",
            }
            connection.execute(
                """
                INSERT INTO payment_decisions
                  (decision_id, transaction_id, correlation_id, payment_verdict,
                   decision_source, policy_version, investigation_required,
                   evidence_sha256, decision_payload, decided_at)
                VALUES (%s, %s, %s, 'APPROVED', 'deterministic_fast_path',
                        'fast-path-policy/1.0.0', false, %s, %s, now())
                """,
                (
                    decision_id,
                    transaction_id,
                    correlation_id,
                    "c" * 64,
                    Jsonb(decision_payload),
                ),
            )
            decided = connection.execute(
                """
                SELECT payment_status, decision_source, policy_version
                FROM banking_payment_status WHERE payment_id = %s
                """,
                (payment_id,),
            ).fetchone()
            assert decided == (
                "APPROVED",
                "deterministic_fast_path",
                "fast-path-policy/1.0.0",
            )


def test_phase_b_payment_attempt_rejects_cross_customer_ownership() -> None:
    import psycopg

    payment_id = uuid4()
    with psycopg.connect(os.environ["DATABASE_URL"]) as connection:
        with pytest.raises(psycopg.Error) as error, connection.transaction():
            connection.execute(
                """
                INSERT INTO banking_payment_attempts
                  (payment_id, transaction_id, customer_id, account_id, beneficiary_id,
                   demo_location_id, amount, payment_reference, idempotency_key, request_sha256,
                   raw_event_payload, trusted_context_snapshot, event_time)
                VALUES
                  (%s, %s, 'cabcc662-0c08-5a82-b350-847e713ca3b7',
                   'a4af9cb1-1c67-599b-93b6-a0233710941a',
                   '13062dbd-38da-5e47-b1d6-c118bd3d16c1',
                   '45bb3ab3-2b73-5bd7-8c8a-d9b8d2398c74', 10.00, 'Wrong owner', %s,
                   %s, '{}'::jsonb, '{}'::jsonb, now())
                """,
                (payment_id, str(payment_id), f"wrong-owner-{payment_id}", "d" * 64),
            )
        assert error.value.sqlstate == "23503"
