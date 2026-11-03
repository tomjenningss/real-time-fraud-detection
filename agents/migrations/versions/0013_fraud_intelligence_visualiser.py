"""Persist validated Flink enrichment evidence for the read-only system view."""

from alembic import op

revision = "0013_fraud_intel_view"
down_revision = "0012_fraud_lab_supersession"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      ALTER TABLE payment_decisions
      ADD COLUMN enrichment_evidence jsonb
      CHECK (
        enrichment_evidence IS NULL
        OR jsonb_typeof(enrichment_evidence) = 'object'
      )
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE payment_decisions DROP COLUMN enrichment_evidence")
