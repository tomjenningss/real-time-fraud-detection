"""Persist bounded, analyst-only Fraud Rule Discovery diagnostics."""

from alembic import op


revision = "0020_fraud_discovery_diagnostics"
down_revision = "0019_active_dataset_integrity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE TABLE fraud_discovery_diagnostics (
        diagnostic_id uuid PRIMARY KEY,
        run_id uuid NOT NULL UNIQUE REFERENCES fraud_discovery_runs(run_id) ON DELETE RESTRICT,
        agent_id text,
        agent_version text NOT NULL,
        provider text NOT NULL,
        model text NOT NULL,
        contract_version text NOT NULL,
        validation_stage text NOT NULL CHECK (validation_stage IN ('INVOCATION', 'STRUCTURAL', 'SEMANTIC')),
        raw_completion jsonb,
        extracted_proposal jsonb,
        validation_issues jsonb NOT NULL CHECK (jsonb_typeof(validation_issues) = 'array'),
        evidence_reference_failures jsonb,
        supporting_evidence_refs_state text NOT NULL CHECK (
          supporting_evidence_refs_state IN ('MISSING', 'EMPTY', 'MALFORMED', 'PRESENT', 'NOT_EXTRACTED')
        ),
        latency_ms integer NOT NULL CHECK (latency_ms >= 0),
        captured_at timestamptz NOT NULL DEFAULT now(),
        CHECK (raw_completion IS NULL OR jsonb_typeof(raw_completion) = 'object'),
        CHECK (extracted_proposal IS NULL OR jsonb_typeof(extracted_proposal) = 'object'),
        CHECK (evidence_reference_failures IS NULL OR jsonb_typeof(evidence_reference_failures) = 'object')
      )
    """)
    op.execute("CREATE INDEX fraud_discovery_diagnostics_stage_idx ON fraud_discovery_diagnostics (validation_stage, captured_at DESC)")


def downgrade() -> None:
    op.execute("DROP TABLE fraud_discovery_diagnostics")
