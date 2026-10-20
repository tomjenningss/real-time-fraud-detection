"""Durable live-evaluation budget and per-call usage ledger."""

from alembic import op

revision = "0002_live_budget"
down_revision = "0001_part3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE TABLE live_experiments (
        experiment_id text PRIMARY KEY,
        budget_gbp numeric(12,6) NOT NULL CHECK (budget_gbp > 0),
        usd_per_gbp numeric(12,6) NOT NULL CHECK (usd_per_gbp > 0),
        budget_usd numeric(12,8) NOT NULL CHECK (budget_usd > 0),
        baseline_cost_usd numeric(12,8) NOT NULL CHECK (baseline_cost_usd >= 0),
        max_investigations integer NOT NULL CHECK (max_investigations > 0),
        configuration jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    """)
    op.execute("""
      CREATE TABLE live_investigation_allocations (
        investigation_id uuid PRIMARY KEY REFERENCES investigations(investigation_id),
        experiment_id text NOT NULL REFERENCES live_experiments(experiment_id),
        attempt_id uuid NOT NULL UNIQUE REFERENCES investigation_attempts(attempt_id),
        reserved_cost_usd numeric(12,8) NOT NULL CHECK (reserved_cost_usd > 0),
        actual_cost_usd numeric(12,8) NOT NULL DEFAULT 0 CHECK (actual_cost_usd >= 0),
        status text NOT NULL CHECK (status IN ('ACTIVE','COMPLETED','FAILED','AMBIGUOUS')),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      )
    """)
    op.execute("""
      CREATE TABLE model_call_usage (
        call_id uuid PRIMARY KEY,
        experiment_id text NOT NULL REFERENCES live_experiments(experiment_id),
        investigation_id uuid NOT NULL REFERENCES live_investigation_allocations(investigation_id),
        attempt_id uuid NOT NULL REFERENCES investigation_attempts(attempt_id),
        agent text NOT NULL, model text NOT NULL, call_number integer NOT NULL CHECK (call_number > 0),
        status text NOT NULL CHECK (status IN ('RESERVED','SUCCEEDED','AMBIGUOUS')),
        approximate_input_tokens integer NOT NULL CHECK (approximate_input_tokens >= 0),
        max_output_tokens integer NOT NULL CHECK (max_output_tokens > 0),
        input_tokens integer CHECK (input_tokens >= 0), output_tokens integer CHECK (output_tokens >= 0),
        reserved_cost_usd numeric(12,8) NOT NULL CHECK (reserved_cost_usd >= 0),
        remaining_calls_reserve_usd numeric(12,8) NOT NULL CHECK (remaining_calls_reserve_usd >= 0),
        accounted_cost_usd numeric(12,8) NOT NULL DEFAULT 0 CHECK (accounted_cost_usd >= 0),
        latency_ms numeric(14,3), tool_names jsonb NOT NULL DEFAULT '[]'::jsonb,
        error_type text, provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
        reserved_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
        UNIQUE (attempt_id, agent, call_number)
      )
    """)
    op.execute("CREATE INDEX model_call_usage_attempt_idx ON model_call_usage (attempt_id, reserved_at)")


def downgrade() -> None:
    op.execute("DROP TABLE model_call_usage, live_investigation_allocations, live_experiments")
