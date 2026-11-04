"""Harden the single active Fraud Lab dataset selection."""

from alembic import op

revision = "0019_active_dataset_integrity"
down_revision = "0018_dataset_run_backfill"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE OR REPLACE FUNCTION validate_fraud_lab_activation() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        dataset_status text;
        dataset_environment text;
        member_count integer;
      BEGIN
        SELECT status, environment_id INTO dataset_status, dataset_environment
        FROM fraud_lab_datasets WHERE dataset_id = NEW.dataset_id;
        SELECT count(*) INTO member_count FROM fraud_lab_dataset_waves WHERE dataset_id = NEW.dataset_id;
        IF dataset_status IS DISTINCT FROM 'READY'
          OR dataset_environment IS DISTINCT FROM NEW.environment_id
          OR member_count = 0 THEN
          RAISE EXCEPTION 'only a completed fraud lab dataset from the same environment can be activated'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$
    """)
    op.execute("""
      CREATE FUNCTION prevent_fraud_lab_active_dataset_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'active fraud lab dataset selection cannot be deleted' USING ERRCODE = '55000';
      END $$
    """)
    op.execute("""
      CREATE TRIGGER fraud_lab_active_dataset_no_delete
      BEFORE DELETE ON fraud_lab_active_datasets
      FOR EACH ROW EXECUTE FUNCTION prevent_fraud_lab_active_dataset_delete()
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER fraud_lab_active_dataset_no_delete ON fraud_lab_active_datasets")
    op.execute("DROP FUNCTION prevent_fraud_lab_active_dataset_delete")
    op.execute("""
      CREATE OR REPLACE FUNCTION validate_fraud_lab_activation() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        dataset_status text;
        member_count integer;
      BEGIN
        SELECT status INTO dataset_status FROM fraud_lab_datasets WHERE dataset_id = NEW.dataset_id;
        SELECT count(*) INTO member_count FROM fraud_lab_dataset_waves WHERE dataset_id = NEW.dataset_id;
        IF dataset_status IS DISTINCT FROM 'READY' OR member_count = 0 THEN
          RAISE EXCEPTION 'only a completed fraud lab dataset can be activated' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$
    """)
