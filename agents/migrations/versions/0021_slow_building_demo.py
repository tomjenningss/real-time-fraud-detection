"""Isolated slow-building APP replay manifests."""

from alembic import op

revision = "0021_slow_building_demo"
down_revision = "0020_fraud_discovery_diagnostics"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE TABLE slow_building_demo_runs (
        run_id uuid PRIMARY KEY,
        customer_id uuid NOT NULL REFERENCES banking_customers(customer_id) ON DELETE RESTRICT,
        beneficiary_id uuid NOT NULL,
        payment_id uuid NOT NULL UNIQUE REFERENCES banking_payment_attempts(payment_id),
        transaction_ids jsonb NOT NULL CHECK (
          jsonb_typeof(transaction_ids) = 'array' AND jsonb_array_length(transaction_ids) = 5
        ),
        scenario_payload jsonb NOT NULL CHECK (jsonb_typeof(scenario_payload) = 'object'),
        event_time_start timestamptz NOT NULL,
        event_time_end timestamptz NOT NULL CHECK (event_time_end > event_time_start),
        raw_topic text NOT NULL DEFAULT 'payments.raw.slow-building-replay' CHECK (
          raw_topic = 'payments.raw.slow-building-replay'
        ),
        enriched_topic text NOT NULL DEFAULT 'payments.enriched.slow-building-replay' CHECK (
          enriched_topic = 'payments.enriched.slow-building-replay'
        ),
        baseline_policy_version text NOT NULL DEFAULT 'fast-path-policy/1.1.0',
        demo_policy_version text NOT NULL DEFAULT 'fast-path-policy/1.2.0-slow-building-demo',
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (beneficiary_id, customer_id)
          REFERENCES banking_beneficiaries(beneficiary_id, customer_id) ON DELETE RESTRICT
      )
    """)
    op.execute("""
      CREATE INDEX slow_building_demo_runs_created_idx
      ON slow_building_demo_runs (created_at DESC)
    """)
    op.execute("""
      CREATE TRIGGER slow_building_demo_runs_immutable
      BEFORE UPDATE OR DELETE ON slow_building_demo_runs
      FOR EACH ROW EXECUTE FUNCTION reject_banking_immutable_mutation()
    """)


def downgrade() -> None:
    op.execute("DROP TABLE slow_building_demo_runs")
