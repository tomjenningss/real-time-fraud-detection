"""Versioned evidence-driven customer reassessment traces."""

from alembic import op

revision = "0014_evidence_reassessment"
down_revision = "0013_fraud_intel_view"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      ALTER TABLE customer_fraud_reassessments
      DROP CONSTRAINT customer_fraud_reassessments_outcome_check
    """)
    op.execute("""
      ALTER TABLE customer_fraud_reassessments
      ADD CONSTRAINT customer_fraud_reassessments_outcome_check
      CHECK (outcome IN (
        'CLEARED', 'REQUIRES_FURTHER_REVIEW', 'DECLINED',
        'ADDITIONAL_VERIFICATION', 'REFER_TO_ANALYST'
      ))
    """)
    op.execute("""
      ALTER TABLE customer_fraud_reassessments
      ADD COLUMN policy_trace jsonb NOT NULL DEFAULT '[]'::jsonb
      CHECK (jsonb_typeof(policy_trace) = 'array')
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE customer_fraud_reassessments DROP COLUMN policy_trace")
    op.execute("""
      ALTER TABLE customer_fraud_reassessments
      DROP CONSTRAINT customer_fraud_reassessments_outcome_check
    """)
    op.execute("""
      ALTER TABLE customer_fraud_reassessments
      ADD CONSTRAINT customer_fraud_reassessments_outcome_check
      CHECK (outcome IN ('CLEARED','REQUIRES_FURTHER_REVIEW','DECLINED'))
    """)
