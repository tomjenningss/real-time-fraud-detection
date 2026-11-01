"""Glaramara Phase B payment status projection and outbox observability."""

from alembic import op

revision = "0007_glaramara_phase_b"
down_revision = "0006_glaramara_banking"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE INDEX outbox_events_aggregate_idx
      ON outbox_events (aggregate_type, aggregate_id, created_at)
    """)
    op.execute("""
      CREATE VIEW banking_payment_status AS
      SELECT
        attempt.payment_id,
        attempt.transaction_id,
        attempt.customer_id,
        attempt.account_id,
        attempt.beneficiary_id,
        attempt.demo_location_id,
        attempt.amount,
        attempt.currency,
        attempt.payment_reference,
        attempt.event_time,
        attempt.submitted_at,
        CASE
          WHEN decision.payment_verdict IS NULL THEN 'PENDING'
          ELSE decision.payment_verdict
        END AS payment_status,
        decision.decision_id,
        decision.decision_source,
        decision.policy_version,
        decision.decision_payload,
        decision.decided_at,
        publication.status AS publication_status,
        publication.attempts AS publication_attempts,
        publication.last_error_type AS publication_last_error_type,
        publication.published_at
      FROM banking_payment_attempts attempt
      LEFT JOIN payment_decisions decision
        ON decision.transaction_id = attempt.transaction_id
      LEFT JOIN outbox_events publication
        ON publication.aggregate_id = attempt.payment_id
       AND publication.aggregate_type = 'banking_payment_raw'
    """)


def downgrade() -> None:
    op.execute("DROP VIEW banking_payment_status")
    op.execute("DROP INDEX outbox_events_aggregate_idx")
