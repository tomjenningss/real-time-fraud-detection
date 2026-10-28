"""Durable shadow decision engine state and publication outbox."""

from alembic import op

revision = "0005_shadow_decision_engine"
down_revision = "0004_assessment_correlator"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE TABLE fraud_shadow_assessment_events (
        source_assessment_id text NOT NULL, source_revision bigint NOT NULL CHECK (source_revision > 0),
        policy_version text NOT NULL, transaction_id text NOT NULL,
        source_topic text NOT NULL, source_partition integer NOT NULL CHECK (source_partition >= 0),
        source_offset bigint NOT NULL CHECK (source_offset >= 0), payload_sha256 char(64) NOT NULL,
        payload jsonb NOT NULL,
        processing_status text NOT NULL CHECK (processing_status IN
          ('EVALUATED','AWAITING_INPUTS','INVALID_INPUTS','OBSOLETE')),
        status_reason text, consumed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (source_assessment_id, source_revision, policy_version),
        UNIQUE (source_topic, source_partition, source_offset, policy_version)
      )
    """)
    op.execute("""
      CREATE TABLE fraud_shadow_decision_state (
        transaction_id text NOT NULL, policy_version text NOT NULL,
        source_assessment_id text NOT NULL, latest_source_revision bigint NOT NULL CHECK (latest_source_revision > 0),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (transaction_id, policy_version)
      )
    """)
    op.execute("""
      CREATE TABLE fraud_shadow_decision_history (
        shadow_evaluation_id text PRIMARY KEY, transaction_id text NOT NULL,
        source_assessment_id text NOT NULL, source_revision bigint NOT NULL CHECK (source_revision > 0),
        policy_version text NOT NULL,
        proposed_action text NOT NULL CHECK (proposed_action IN ('APPROVED','BLOCKED','CHALLENGED')),
        original_payment_verdict text NOT NULL CHECK (original_payment_verdict IN ('APPROVED','BLOCKED','CHALLENGED')),
        differs_from_original boolean NOT NULL, decision jsonb NOT NULL,
        evaluated_at timestamptz NOT NULL, evaluation_latency_ms double precision NOT NULL CHECK (evaluation_latency_ms >= 0),
        UNIQUE (source_assessment_id, source_revision, policy_version)
      )
    """)
    op.execute("""
      CREATE TABLE fraud_shadow_decision_outbox (
        outbox_id text PRIMARY KEY, shadow_evaluation_id text UNIQUE,
        transaction_id text NOT NULL, source_revision bigint NOT NULL CHECK (source_revision >= 0),
        destination_topic text NOT NULL, message_key text NOT NULL, payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CLAIMED','PUBLISHED')),
        attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
        claimed_by text, claim_until timestamptz, last_error_type text,
        created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
      )
    """)
    op.execute("""
      CREATE TABLE fraud_shadow_decision_rejected_events (
        id bigserial PRIMARY KEY, source_topic text NOT NULL, source_partition integer NOT NULL,
        source_offset bigint NOT NULL, policy_version text NOT NULL, payload_sha256 char(64) NOT NULL,
        rejection_reason text NOT NULL, rejected_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (source_topic, source_partition, source_offset, policy_version)
      )
    """)
    op.execute("CREATE INDEX fraud_shadow_outbox_claim_idx ON fraud_shadow_decision_outbox (status, available_at, created_at)")
    op.execute("CREATE INDEX fraud_shadow_history_tx_idx ON fraud_shadow_decision_history (transaction_id, evaluated_at)")
    op.execute("CREATE INDEX fraud_shadow_events_status_idx ON fraud_shadow_assessment_events (processing_status, consumed_at)")


def downgrade() -> None:
    op.execute("""
      DROP TABLE fraud_shadow_decision_rejected_events, fraud_shadow_decision_outbox,
      fraud_shadow_decision_history, fraud_shadow_decision_state, fraud_shadow_assessment_events
    """)
