"""Extensible synthetic fraud laboratory and rule discovery audit."""

from alembic import op

revision = "0011_glaramara_phase_d"
down_revision = "0010_glaramara_phase_c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE TABLE fraud_lab_waves (
        wave_id text PRIMARY KEY CHECK (wave_id ~ '^fraud-lab-wave-[a-z0-9-]+$'),
        dataset_schema_version text NOT NULL,
        generator_version text NOT NULL,
        seed bigint NOT NULL,
        period_start timestamptz NOT NULL,
        period_end timestamptz NOT NULL CHECK (period_end > period_start),
        row_count integer NOT NULL CHECK (row_count > 0),
        discovery_count integer NOT NULL CHECK (discovery_count > 0),
        evaluation_count integer NOT NULL CHECK (evaluation_count > 0),
        content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
        status text NOT NULL DEFAULT 'READY' CHECK (status = 'READY'),
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (discovery_count + evaluation_count = row_count)
      )
    """)
    op.execute("""
      CREATE TABLE fraud_lab_transactions (
        transaction_id uuid PRIMARY KEY,
        wave_id text NOT NULL REFERENCES fraud_lab_waves(wave_id) ON DELETE RESTRICT,
        partition text NOT NULL CHECK (partition IN ('DISCOVERY','EVALUATION')),
        scenario_group_id uuid NOT NULL,
        event_time timestamptz NOT NULL,
        customer_id uuid NOT NULL,
        beneficiary_id uuid NOT NULL,
        merchant_id uuid NOT NULL,
        amount numeric(12,2) NOT NULL CHECK (amount > 0 AND amount <= 100000),
        ground_truth_fraud boolean NOT NULL,
        label_provenance text NOT NULL DEFAULT 'INDEPENDENT_SYNTHETIC_SCENARIO',
        beneficiary_payment_count_before integer NOT NULL CHECK (beneficiary_payment_count_before >= 0),
        transactions_1m integer NOT NULL CHECK (transactions_1m > 0),
        transactions_2m integer NOT NULL CHECK (transactions_2m > 0),
        transactions_10m integer NOT NULL CHECK (transactions_10m > 0),
        distinct_merchants_2m integer NOT NULL CHECK (distinct_merchants_2m > 0),
        total_amount_2m numeric(14,2) NOT NULL CHECK (total_amount_2m > 0),
        distinct_new_beneficiaries_24h integer NOT NULL CHECK (distinct_new_beneficiaries_24h >= 0),
        new_beneficiary_payments_24h integer NOT NULL CHECK (new_beneficiary_payments_24h >= 0),
        new_beneficiary_total_24h numeric(14,2) NOT NULL CHECK (new_beneficiary_total_24h >= 0),
        beneficiary_distinct_customers_24h integer NOT NULL CHECK (beneficiary_distinct_customers_24h > 0),
        baseline_signals jsonb NOT NULL CHECK (jsonb_typeof(baseline_signals) = 'array'),
        baseline_action text NOT NULL CHECK (baseline_action IN ('APPROVED','CHALLENGED','BLOCKED')),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (wave_id, transaction_id)
      )
    """)
    op.execute("""
      CREATE INDEX fraud_lab_transactions_snapshot_idx
      ON fraud_lab_transactions (wave_id, partition, event_time, transaction_id)
    """)
    op.execute("""
      CREATE INDEX fraud_lab_transactions_customer_time_idx
      ON fraud_lab_transactions (wave_id, customer_id, event_time, transaction_id)
    """)
    op.execute("""
      CREATE TABLE fraud_discovery_runs (
        run_id uuid PRIMARY KEY,
        analyst_id text NOT NULL,
        idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
        status text NOT NULL CHECK (status IN ('ANALYSING','COMPLETED','FAILED')),
        snapshot_wave_ids jsonb NOT NULL CHECK (jsonb_typeof(snapshot_wave_ids) = 'array'),
        snapshot_manifest jsonb NOT NULL CHECK (jsonb_typeof(snapshot_manifest) = 'object'),
        snapshot_sha256 char(64) NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
        snapshot_row_count integer NOT NULL CHECK (snapshot_row_count > 0),
        discovery_report jsonb CHECK (discovery_report IS NULL OR jsonb_typeof(discovery_report) = 'object'),
        discovery_report_sha256 char(64) CHECK (
          discovery_report_sha256 IS NULL OR discovery_report_sha256 ~ '^[0-9a-f]{64}$'
        ),
        agent_name text NOT NULL DEFAULT 'fraud_rule_discovery',
        agent_id text,
        agent_version text NOT NULL DEFAULT '1.0.0',
        provider text,
        model text,
        proposal_schema_version text,
        request_sha256 char(64) CHECK (request_sha256 IS NULL OR request_sha256 ~ '^[0-9a-f]{64}$'),
        latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
        error_type text,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        UNIQUE (analyst_id, idempotency_key)
      )
    """)
    op.execute("""
      CREATE TABLE fraud_rule_candidates (
        candidate_id uuid PRIMARY KEY,
        run_id uuid NOT NULL UNIQUE REFERENCES fraud_discovery_runs(run_id) ON DELETE RESTRICT,
        rule_identifier text NOT NULL,
        rule_name text NOT NULL,
        rule_fingerprint char(64) NOT NULL CHECK (rule_fingerprint ~ '^[0-9a-f]{64}$'),
        duplicate_of_candidate_id uuid REFERENCES fraud_rule_candidates(candidate_id) ON DELETE RESTRICT,
        proposal_schema_version text NOT NULL CHECK (proposal_schema_version = 'fraud-rule-proposal/1.0.0'),
        proposal_payload jsonb NOT NULL CHECK (jsonb_typeof(proposal_payload) = 'object'),
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (duplicate_of_candidate_id IS NULL OR duplicate_of_candidate_id <> candidate_id)
      )
    """)
    op.execute("CREATE INDEX fraud_rule_candidates_fingerprint_idx ON fraud_rule_candidates (rule_fingerprint, created_at)")
    op.execute("""
      CREATE TABLE fraud_rule_backtests (
        backtest_id uuid PRIMARY KEY,
        candidate_id uuid NOT NULL UNIQUE REFERENCES fraud_rule_candidates(candidate_id) ON DELETE RESTRICT,
        snapshot_sha256 char(64) NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
        evaluator_version text NOT NULL,
        baseline_policy_version text NOT NULL CHECK (baseline_policy_version = 'fast-path-policy/1.1.0'),
        evaluated_transaction_count integer NOT NULL CHECK (evaluated_transaction_count > 0),
        metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
        example_references jsonb NOT NULL CHECK (jsonb_typeof(example_references) = 'object'),
        semantics_note text NOT NULL,
        evaluated_at timestamptz NOT NULL DEFAULT now()
      )
    """)
    op.execute("""
      CREATE TABLE fraud_rule_reviews (
        review_id uuid PRIMARY KEY,
        candidate_id uuid NOT NULL UNIQUE REFERENCES fraud_rule_candidates(candidate_id) ON DELETE RESTRICT,
        decision text NOT NULL CHECK (decision IN ('APPROVED_FOR_IMPLEMENTATION','REJECTED')),
        reviewer_id text NOT NULL,
        reviewer_name text NOT NULL,
        reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
        reviewed_at timestamptz NOT NULL DEFAULT now()
      )
    """)
    op.execute("""
      CREATE VIEW fraud_rule_candidate_status AS
      SELECT candidate.candidate_id,
             CASE WHEN review.decision IS NOT NULL THEN review.decision
                  WHEN backtest.backtest_id IS NOT NULL THEN 'BACKTESTED'
                  ELSE 'PROPOSED' END AS status
      FROM fraud_rule_candidates candidate
      LEFT JOIN fraud_rule_backtests backtest ON backtest.candidate_id = candidate.candidate_id
      LEFT JOIN fraud_rule_reviews review ON review.candidate_id = candidate.candidate_id
    """)
    op.execute("""
      CREATE FUNCTION protect_fraud_discovery_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
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
      CREATE TRIGGER fraud_discovery_snapshot_immutable
      BEFORE UPDATE ON fraud_discovery_runs
      FOR EACH ROW EXECUTE FUNCTION protect_fraud_discovery_snapshot()
    """)
    for table in (
        "fraud_lab_waves",
        "fraud_lab_transactions",
        "fraud_rule_candidates",
        "fraud_rule_backtests",
        "fraud_rule_reviews",
    ):
        op.execute(f"""
          CREATE TRIGGER {table}_immutable
          BEFORE UPDATE OR DELETE ON {table}
          FOR EACH ROW EXECUTE FUNCTION reject_banking_immutable_mutation()
        """)


def downgrade() -> None:
    op.execute("DROP VIEW fraud_rule_candidate_status")
    op.execute("DROP TABLE fraud_rule_reviews")
    op.execute("DROP TABLE fraud_rule_backtests")
    op.execute("DROP TABLE fraud_rule_candidates")
    op.execute("DROP TABLE fraud_discovery_runs")
    op.execute("DROP TABLE fraud_lab_transactions")
    op.execute("DROP TABLE fraud_lab_waves")
    op.execute("DROP FUNCTION protect_fraud_discovery_snapshot")
