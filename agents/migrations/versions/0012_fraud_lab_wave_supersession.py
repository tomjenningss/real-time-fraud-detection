"""Append-only supersession for corrected synthetic lab waves."""

from alembic import op

revision = "0012_fraud_lab_supersession"
down_revision = "0011_glaramara_phase_d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE TABLE fraud_lab_wave_supersessions (
        superseded_wave_id text PRIMARY KEY REFERENCES fraud_lab_waves(wave_id) ON DELETE RESTRICT,
        replacement_wave_id text NOT NULL UNIQUE REFERENCES fraud_lab_waves(wave_id) ON DELETE RESTRICT,
        reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (superseded_wave_id <> replacement_wave_id)
      )
    """)
    op.execute("""
      CREATE TRIGGER fraud_lab_wave_supersessions_immutable
      BEFORE UPDATE OR DELETE ON fraud_lab_wave_supersessions
      FOR EACH ROW EXECUTE FUNCTION reject_banking_immutable_mutation()
    """)


def downgrade() -> None:
    op.execute("DROP TABLE fraud_lab_wave_supersessions")

