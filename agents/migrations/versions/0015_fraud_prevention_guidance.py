"""Persist versioned deterministic customer fraud-prevention guidance."""

from alembic import op

revision = "0015_fraud_guidance"
down_revision = "0014_evidence_reassessment"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      ALTER TABLE customer_fraud_reassessments
      ADD COLUMN guidance_contract_version text,
      ADD COLUMN guidance_payload jsonb,
      ADD CONSTRAINT customer_fraud_reassessments_guidance_check CHECK (
        (guidance_contract_version IS NULL AND guidance_payload IS NULL)
        OR (
          guidance_contract_version = 'fraud-prevention-guidance/1.0.0'
          AND jsonb_typeof(guidance_payload) = 'object'
          AND guidance_payload->>'contractVersion' = guidance_contract_version
        )
      )
    """)


def downgrade() -> None:
    op.execute("""
      ALTER TABLE customer_fraud_reassessments
      DROP CONSTRAINT customer_fraud_reassessments_guidance_check,
      DROP COLUMN guidance_payload,
      DROP COLUMN guidance_contract_version
    """)
