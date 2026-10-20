"""Optional canonical context for controlled investigations."""

from alembic import op

revision = "0003_investigation_context"
down_revision = "0002_live_budget"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE TABLE investigation_context (
        investigation_id uuid PRIMARY KEY REFERENCES investigations(investigation_id),
        context_payload jsonb NOT NULL, historical_payload jsonb,
        payload_sha256 char(64) NOT NULL, provenance text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    """)


def downgrade() -> None:
    op.execute("DROP TABLE investigation_context")
