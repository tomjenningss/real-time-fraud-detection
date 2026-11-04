"""Add configurable immutable Fraud Lab datasets and explicit activation."""

from alembic import op

revision = "0017_fraud_lab_datasets"
down_revision = "0016_agentic_lab"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE TABLE fraud_lab_datasets (
        dataset_id uuid PRIMARY KEY,
        environment_id text NOT NULL DEFAULT 'glaramara-local'
          CHECK (char_length(environment_id) BETWEEN 1 AND 64),
        generator_version text NOT NULL,
        seed bigint NOT NULL CHECK (seed >= 0),
        requested_transaction_count integer NOT NULL CHECK (
          requested_transaction_count IN (8000, 10000, 20000)
        ),
        actual_transaction_count integer CHECK (
          actual_transaction_count IS NULL OR actual_transaction_count = requested_transaction_count
        ),
        fraud_scenario_id text NOT NULL CHECK (fraud_scenario_id = 'multi_new_beneficiary'),
        status text NOT NULL CHECK (status IN ('PENDING', 'GENERATING', 'READY', 'FAILED')),
        content_sha256 char(64) CHECK (
          content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'
        ),
        requested_by text NOT NULL,
        idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
        requested_at timestamptz NOT NULL DEFAULT now(),
        generation_started_at timestamptz,
        generated_at timestamptz,
        failure_code text CHECK (failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 80),
        UNIQUE (requested_by, idempotency_key),
        CHECK ((status = 'READY') = (
          actual_transaction_count IS NOT NULL AND content_sha256 IS NOT NULL AND generated_at IS NOT NULL
        )),
        CHECK (status = 'FAILED' OR failure_code IS NULL)
      )
    """)
    op.execute("""
      CREATE UNIQUE INDEX fraud_lab_one_generation_per_environment
      ON fraud_lab_datasets (environment_id)
      WHERE status IN ('PENDING', 'GENERATING')
    """)
    op.execute("""
      CREATE TABLE fraud_lab_dataset_waves (
        dataset_id uuid NOT NULL REFERENCES fraud_lab_datasets(dataset_id) ON DELETE RESTRICT,
        wave_id text NOT NULL UNIQUE REFERENCES fraud_lab_waves(wave_id) ON DELETE RESTRICT,
        ordinal smallint NOT NULL CHECK (ordinal > 0),
        PRIMARY KEY (dataset_id, ordinal),
        UNIQUE (dataset_id, wave_id)
      )
    """)
    op.execute("""
      CREATE TABLE fraud_lab_active_datasets (
        environment_id text PRIMARY KEY CHECK (char_length(environment_id) BETWEEN 1 AND 64),
        dataset_id uuid NOT NULL REFERENCES fraud_lab_datasets(dataset_id) ON DELETE RESTRICT,
        activated_by text NOT NULL,
        activated_at timestamptz NOT NULL DEFAULT now()
      )
    """)
    op.execute("""
      CREATE TABLE fraud_lab_dataset_activation_events (
        activation_id uuid PRIMARY KEY,
        environment_id text NOT NULL,
        dataset_id uuid NOT NULL REFERENCES fraud_lab_datasets(dataset_id) ON DELETE RESTRICT,
        previous_dataset_id uuid REFERENCES fraud_lab_datasets(dataset_id) ON DELETE RESTRICT,
        activated_by text NOT NULL,
        activated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (previous_dataset_id IS NULL OR previous_dataset_id <> dataset_id)
      )
    """)
    op.execute("ALTER TABLE fraud_discovery_runs ADD COLUMN dataset_id uuid REFERENCES fraud_lab_datasets(dataset_id) ON DELETE RESTRICT")
    op.execute("""
      CREATE FUNCTION protect_fraud_lab_dataset_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.dataset_id IS DISTINCT FROM OLD.dataset_id
          OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
          OR NEW.generator_version IS DISTINCT FROM OLD.generator_version
          OR NEW.seed IS DISTINCT FROM OLD.seed
          OR NEW.requested_transaction_count IS DISTINCT FROM OLD.requested_transaction_count
          OR NEW.fraud_scenario_id IS DISTINCT FROM OLD.fraud_scenario_id
          OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
          OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
          OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
          RAISE EXCEPTION 'fraud lab dataset identity is immutable' USING ERRCODE = '55000';
        END IF;
        IF OLD.status IN ('READY', 'FAILED') THEN
          RAISE EXCEPTION 'terminal fraud lab dataset is immutable' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END $$
    """)
    op.execute("""
      CREATE TRIGGER fraud_lab_dataset_identity_immutable
      BEFORE UPDATE ON fraud_lab_datasets
      FOR EACH ROW EXECUTE FUNCTION protect_fraud_lab_dataset_identity()
    """)
    op.execute("""
      CREATE TRIGGER fraud_lab_datasets_no_delete
      BEFORE DELETE ON fraud_lab_datasets
      FOR EACH ROW EXECUTE FUNCTION reject_banking_immutable_mutation()
    """)
    for table in ("fraud_lab_dataset_waves", "fraud_lab_dataset_activation_events"):
        op.execute(f"""
          CREATE TRIGGER {table}_immutable
          BEFORE UPDATE OR DELETE ON {table}
          FOR EACH ROW EXECUTE FUNCTION reject_banking_immutable_mutation()
        """)
    op.execute("""
      CREATE FUNCTION validate_fraud_lab_activation() RETURNS trigger LANGUAGE plpgsql AS $$
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
    op.execute("""
      CREATE TRIGGER fraud_lab_active_dataset_ready
      BEFORE INSERT OR UPDATE ON fraud_lab_active_datasets
      FOR EACH ROW EXECUTE FUNCTION validate_fraud_lab_activation()
    """)

    # Existing installations prefer the corrected immutable 8,000-row wave. The original
    # wave remains a fallback for installations that never ran the additive repair command.
    op.execute("""
      WITH selected_wave AS (
        SELECT wave.* FROM fraud_lab_waves wave
        WHERE wave.wave_id = CASE
          WHEN EXISTS (SELECT 1 FROM fraud_lab_waves WHERE wave_id = 'fraud-lab-wave-2026q4-v2')
            THEN 'fraud-lab-wave-2026q4-v2'
          ELSE 'fraud-lab-wave-2026q4-v1'
        END
        AND wave.row_count = 8000
      )
      INSERT INTO fraud_lab_datasets
        (dataset_id, generator_version, seed, requested_transaction_count,
         actual_transaction_count, fraud_scenario_id, status, content_sha256,
         requested_by, idempotency_key, requested_at, generation_started_at, generated_at)
      SELECT 'a5d67ed2-e42c-5dcb-8e75-765b36d8299a', generator_version, seed, 8000,
             row_count, 'multi_new_beneficiary', 'READY', content_sha256,
             'system-migration', 'backfill-existing-8000', created_at, created_at, created_at
      FROM selected_wave
    """)
    op.execute("""
      INSERT INTO fraud_lab_dataset_waves (dataset_id, wave_id, ordinal)
      SELECT 'a5d67ed2-e42c-5dcb-8e75-765b36d8299a', wave_id, 1
      FROM fraud_lab_waves
      WHERE wave_id = CASE
        WHEN EXISTS (SELECT 1 FROM fraud_lab_waves WHERE wave_id = 'fraud-lab-wave-2026q4-v2')
          THEN 'fraud-lab-wave-2026q4-v2'
        ELSE 'fraud-lab-wave-2026q4-v1'
      END
      AND row_count = 8000
    """)
    op.execute("""
      INSERT INTO fraud_lab_active_datasets (environment_id, dataset_id, activated_by)
      SELECT 'glaramara-local', 'a5d67ed2-e42c-5dcb-8e75-765b36d8299a', 'system-migration'
      WHERE EXISTS (
        SELECT 1 FROM fraud_lab_datasets
        WHERE dataset_id = 'a5d67ed2-e42c-5dcb-8e75-765b36d8299a'
      )
    """)
    op.execute("""
      INSERT INTO fraud_lab_dataset_activation_events
        (activation_id, environment_id, dataset_id, previous_dataset_id, activated_by)
      SELECT 'cbd9f138-cf87-52f1-8e74-e3afe423d37c', 'glaramara-local',
             'a5d67ed2-e42c-5dcb-8e75-765b36d8299a', NULL, 'system-migration'
      WHERE EXISTS (
        SELECT 1 FROM fraud_lab_datasets
        WHERE dataset_id = 'a5d67ed2-e42c-5dcb-8e75-765b36d8299a'
      )
    """)
    op.execute("""
      UPDATE fraud_discovery_runs
      SET dataset_id = 'a5d67ed2-e42c-5dcb-8e75-765b36d8299a'
      WHERE snapshot_wave_ids = '["fraud-lab-wave-2026q4-v2"]'::jsonb
        AND EXISTS (
          SELECT 1 FROM fraud_lab_datasets
          WHERE dataset_id = 'a5d67ed2-e42c-5dcb-8e75-765b36d8299a'
        )
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
    op.execute("ALTER TABLE fraud_discovery_runs DROP COLUMN dataset_id")
    op.execute("DROP TABLE fraud_lab_dataset_activation_events")
    op.execute("DROP TABLE fraud_lab_active_datasets")
    op.execute("DROP FUNCTION validate_fraud_lab_activation")
    op.execute("DROP TABLE fraud_lab_dataset_waves")
    op.execute("DROP TABLE fraud_lab_datasets")
    op.execute("DROP FUNCTION protect_fraud_lab_dataset_identity")
