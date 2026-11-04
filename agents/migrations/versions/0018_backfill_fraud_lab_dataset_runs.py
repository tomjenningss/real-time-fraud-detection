"""Associate matching legacy snapshots with the backfilled Fraud Lab dataset."""

from alembic import op

revision = "0018_dataset_run_backfill"
down_revision = "0017_fraud_lab_datasets"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Temporarily retain the original snapshot guard while adding dataset provenance
    # to legacy rows. Snapshot wave IDs, manifests, hashes, counts and results do not change.
    op.execute("""
      CREATE OR REPLACE FUNCTION protect_fraud_discovery_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.run_id IS DISTINCT FROM OLD.run_id
          OR NEW.analyst_id IS DISTINCT FROM OLD.analyst_id
          OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
          OR NEW.snapshot_wave_ids IS DISTINCT FROM OLD.snapshot_wave_ids
          OR NEW.snapshot_manifest IS DISTINCT FROM OLD.snapshot_manifest
          OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
          OR NEW.snapshot_row_count IS DISTINCT FROM OLD.snapshot_row_count THEN
          RAISE EXCEPTION 'fraud discovery snapshot identity is immutable' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END $$
    """)
    op.execute("""
      UPDATE fraud_discovery_runs run
      SET dataset_id = dataset.dataset_id
      FROM fraud_lab_datasets dataset
      JOIN fraud_lab_dataset_waves member ON member.dataset_id = dataset.dataset_id
      WHERE run.dataset_id IS NULL
        AND dataset.requested_by IN ('system-migration', 'system-seed')
        AND run.snapshot_wave_ids = jsonb_build_array(member.wave_id)
        AND run.snapshot_row_count = dataset.actual_transaction_count
        AND (
          SELECT count(*) FROM fraud_lab_dataset_waves members
          WHERE members.dataset_id = dataset.dataset_id
        ) = 1
    """)
    op.execute("""
      CREATE OR REPLACE FUNCTION protect_fraud_discovery_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.run_id IS DISTINCT FROM OLD.run_id
          OR NEW.analyst_id IS DISTINCT FROM OLD.analyst_id
          OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
          OR NEW.dataset_id IS DISTINCT FROM OLD.dataset_id
          OR NEW.snapshot_wave_ids IS DISTINCT FROM OLD.snapshot_wave_ids
          OR NEW.snapshot_manifest IS DISTINCT FROM OLD.snapshot_manifest
          OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
          OR NEW.snapshot_row_count IS DISTINCT FROM OLD.snapshot_row_count THEN
          RAISE EXCEPTION 'fraud discovery snapshot identity is immutable' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END $$
    """)


def downgrade() -> None:
    # The association is immutable provenance and intentionally remains on downgrade.
    pass
