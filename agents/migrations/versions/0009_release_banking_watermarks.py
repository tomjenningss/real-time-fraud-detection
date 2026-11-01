"""Release banking watermark rows scheduled against future event time."""

from alembic import op

revision = "0009_release_banking_watermarks"
down_revision = "0008_raw_event_time_clock"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      UPDATE outbox_events
      SET available_at = created_at + interval '3 seconds'
      WHERE aggregate_type = 'banking_payment_watermark'
        AND status = 'PENDING'
        AND available_at > created_at + interval '3 seconds'
    """)


def downgrade() -> None:
    # Publication scheduling is operational state and cannot be usefully delayed again.
    pass
