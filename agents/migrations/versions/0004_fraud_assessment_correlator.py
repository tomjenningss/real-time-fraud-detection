"""Durable correlation state and assessment publication outbox."""

from alembic import op

revision = "0004_assessment_correlator"
down_revision = "0003_investigation_context"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE TABLE fraud_assessment_source_events (
        event_id text PRIMARY KEY, transaction_id text NOT NULL, event_kind text NOT NULL,
        source_topic text NOT NULL, source_partition integer NOT NULL CHECK (source_partition >= 0),
        source_offset bigint NOT NULL CHECK (source_offset >= 0), schema_version text NOT NULL,
        event_timestamp timestamptz NOT NULL, payload_sha256 char(64) NOT NULL,
        payload jsonb NOT NULL, valid boolean NOT NULL, validation_error text,
        consumed_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (source_topic, source_partition, source_offset)
      )
    """)
    op.execute("""
      CREATE TABLE fraud_assessments_latest (
        transaction_id text PRIMARY KEY, revision bigint NOT NULL CHECK (revision > 0),
        assessment jsonb NOT NULL, created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      )
    """)
    op.execute("""
      CREATE TABLE fraud_assessment_history (
        transaction_id text NOT NULL, revision bigint NOT NULL CHECK (revision > 0),
        source_event_id text NOT NULL REFERENCES fraud_assessment_source_events(event_id),
        assessment jsonb NOT NULL, created_at timestamptz NOT NULL,
        PRIMARY KEY (transaction_id, revision), UNIQUE (source_event_id)
      )
    """)
    op.execute("""
      CREATE TABLE fraud_assessment_outbox (
        outbox_id text PRIMARY KEY, transaction_id text NOT NULL, revision bigint NOT NULL CHECK (revision >= 0),
        destination_topic text NOT NULL, message_key text NOT NULL, payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CLAIMED','PUBLISHED')),
        attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
        claimed_by text, claim_until timestamptz, last_error_type text,
        created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
        UNIQUE (transaction_id, revision)
      )
    """)
    op.execute("""
      CREATE TABLE fraud_assessment_rejected_events (
        id bigserial PRIMARY KEY, source_topic text NOT NULL, source_partition integer NOT NULL,
        source_offset bigint NOT NULL, payload_sha256 char(64) NOT NULL,
        rejection_reason text NOT NULL, rejected_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (source_topic, source_partition, source_offset)
      )
    """)
    op.execute("CREATE INDEX fraud_assessment_outbox_claim_idx ON fraud_assessment_outbox (status, available_at, created_at)")
    op.execute("CREATE INDEX fraud_assessment_source_tx_idx ON fraud_assessment_source_events (transaction_id, consumed_at)")


def downgrade() -> None:
    op.execute("DROP TABLE fraud_assessment_rejected_events, fraud_assessment_outbox, fraud_assessment_history, fraud_assessments_latest, fraud_assessment_source_events")
