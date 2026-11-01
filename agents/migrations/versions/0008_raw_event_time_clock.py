"""Coordinate raw-payment event time across interactive and regression producers."""

from alembic import op

revision = "0008_raw_event_time_clock"
down_revision = "0007_glaramara_phase_b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE TABLE raw_event_time_clock (
        stream_name text PRIMARY KEY CHECK (stream_name = 'payments.raw.demo'),
        last_event_time timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    """)


def downgrade() -> None:
    op.execute("DROP TABLE raw_event_time_clock")
