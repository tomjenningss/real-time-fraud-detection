"""Part 3 durable fraud decision and investigation state."""

from alembic import op

revision = "0001_part3"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE TYPE outbox_status AS ENUM ('PENDING','CLAIMED','PUBLISHED')")
    op.execute(
        "CREATE TYPE investigation_status AS ENUM ('REQUESTED','RUNNING','COMPLETED','FAILED','AMBIGUOUS')"
    )
    op.execute(
        "CREATE TYPE attempt_status AS ENUM ('PREPARED','RUNNING','SUCCEEDED','RETRYABLE_FAILED','PERMANENT_FAILED','AMBIGUOUS')"
    )
    op.execute("""
      CREATE TABLE consumed_events (
        id bigserial PRIMARY KEY, consumer_name text NOT NULL, logical_event_id uuid NOT NULL,
        source_topic text NOT NULL, source_partition integer NOT NULL CHECK (source_partition >= 0),
        source_offset bigint NOT NULL CHECK (source_offset >= 0), payload_sha256 char(64) NOT NULL,
        consumed_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (consumer_name, source_topic, source_partition, source_offset),
        UNIQUE (consumer_name, logical_event_id)
      )
    """)
    op.execute("""
      CREATE TABLE payment_decisions (
        decision_id uuid PRIMARY KEY, transaction_id text NOT NULL UNIQUE,
        correlation_id uuid NOT NULL UNIQUE, payment_verdict text NOT NULL CHECK (payment_verdict IN ('APPROVED','CHALLENGED','BLOCKED')),
        decision_source text NOT NULL CHECK (decision_source = 'deterministic_fast_path'),
        policy_version text NOT NULL, investigation_required boolean NOT NULL,
        investigation_reason text, evidence_sha256 char(64) NOT NULL,
        decision_payload jsonb NOT NULL, decided_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    """)
    op.execute("""
      CREATE TABLE investigations (
        investigation_id uuid PRIMARY KEY, decision_id uuid NOT NULL UNIQUE REFERENCES payment_decisions(decision_id),
        transaction_id text NOT NULL UNIQUE, correlation_id uuid NOT NULL,
        original_payment_verdict text NOT NULL CHECK (original_payment_verdict IN ('APPROVED','CHALLENGED','BLOCKED')),
        status investigation_status NOT NULL DEFAULT 'REQUESTED', request_payload jsonb NOT NULL,
        recommended_action text CHECK (recommended_action IN ('APPROVED','CHALLENGED','BLOCKED')),
        investigation_policy_version text, result_payload jsonb, requested_at timestamptz NOT NULL,
        completed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
      )
    """)
    op.execute("""
      CREATE TABLE investigation_attempts (
        attempt_id uuid PRIMARY KEY, investigation_id uuid NOT NULL REFERENCES investigations(investigation_id),
        attempt_number integer NOT NULL CHECK (attempt_number > 0), mode text NOT NULL CHECK (mode IN ('dry-run','live')),
        status attempt_status NOT NULL, model_configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
        estimated_cost_usd numeric(12,8) NOT NULL DEFAULT 0, failure_type text,
        started_at timestamptz, finished_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (investigation_id, attempt_number)
      )
    """)
    op.execute("""
      CREATE TABLE audit_records (
        investigation_id uuid PRIMARY KEY REFERENCES investigations(investigation_id),
        attempt_id uuid NOT NULL REFERENCES investigation_attempts(attempt_id), audit_payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    """)
    op.execute("""
      CREATE TABLE outbox_events (
        event_id uuid PRIMARY KEY, aggregate_type text NOT NULL, aggregate_id uuid NOT NULL,
        destination_topic text NOT NULL, message_key text NOT NULL, schema_version text NOT NULL,
        payload jsonb NOT NULL, status outbox_status NOT NULL DEFAULT 'PENDING',
        attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
        claimed_by text, claim_until timestamptz, last_error_type text,
        created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
      )
    """)
    op.execute("CREATE INDEX outbox_claim_idx ON outbox_events (status, available_at, created_at)")
    op.execute("CREATE INDEX investigation_status_idx ON investigations (status, requested_at)")
    op.execute("""
      CREATE FUNCTION reject_payment_decision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'payment decisions are immutable';
      END $$
    """)
    op.execute("""
      CREATE TRIGGER payment_decisions_immutable
      BEFORE UPDATE OR DELETE ON payment_decisions
      FOR EACH ROW EXECUTE FUNCTION reject_payment_decision_mutation()
    """)


def downgrade() -> None:
    op.execute(
        "DROP TABLE outbox_events, audit_records, investigation_attempts, investigations, payment_decisions, consumed_events"
    )
    op.execute("DROP TYPE attempt_status, investigation_status, outbox_status")
    op.execute("DROP FUNCTION reject_payment_decision_mutation")
