"""Add an isolated three-partition laboratory for agentic rule investigation."""

from alembic import op

revision = "0016_agentic_lab"
down_revision = "0015_fraud_guidance"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE TABLE fraud_investigation_waves (
        wave_id text PRIMARY KEY CHECK (wave_id ~ '^fraud-investigation-wave-[a-z0-9-]+$'),
        dataset_schema_version text NOT NULL,
        generator_version text NOT NULL,
        seed bigint NOT NULL,
        period_start timestamptz NOT NULL,
        period_end timestamptz NOT NULL CHECK (period_end > period_start),
        row_count integer NOT NULL CHECK (row_count > 0),
        discovery_count integer NOT NULL CHECK (discovery_count > 0),
        validation_count integer NOT NULL CHECK (validation_count > 0),
        final_holdout_count integer NOT NULL CHECK (final_holdout_count > 0),
        content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (discovery_count + validation_count + final_holdout_count = row_count)
      )
    """)
    op.execute("""
      CREATE TABLE fraud_investigation_transactions (
        transaction_id uuid PRIMARY KEY,
        wave_id text NOT NULL REFERENCES fraud_investigation_waves(wave_id) ON DELETE RESTRICT,
        partition text NOT NULL CHECK (partition IN ('DISCOVERY', 'VALIDATION', 'FINAL_HOLDOUT')),
        scenario_group_id uuid NOT NULL,
        event_time timestamptz NOT NULL,
        customer_id uuid NOT NULL,
        beneficiary_id uuid NOT NULL,
        merchant_id uuid NOT NULL,
        amount numeric(12,2) NOT NULL CHECK (amount > 0 AND amount <= 100000),
        ground_truth_fraud boolean NOT NULL,
        baseline_action text NOT NULL CHECK (baseline_action IN ('APPROVED', 'CHALLENGED', 'BLOCKED')),
        features jsonb NOT NULL CHECK (jsonb_typeof(features) = 'object'),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (wave_id, transaction_id)
      )
    """)
    op.execute("""
      CREATE INDEX fraud_investigation_transactions_partition_idx
      ON fraud_investigation_transactions (wave_id, partition, event_time, transaction_id)
    """)
    for table in ("fraud_investigation_waves", "fraud_investigation_transactions"):
        op.execute(f"""
          CREATE TRIGGER {table}_immutable
          BEFORE UPDATE OR DELETE ON {table}
          FOR EACH ROW EXECUTE FUNCTION reject_banking_immutable_mutation()
        """)


def downgrade() -> None:
    op.execute("DROP TABLE fraud_investigation_transactions")
    op.execute("DROP TABLE fraud_investigation_waves")
