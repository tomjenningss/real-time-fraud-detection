"""Adaptive customer evidence and deterministic Phase C reassessment."""

from alembic import op

revision = "0010_glaramara_phase_c"
down_revision = "0009_release_banking_watermarks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE TYPE customer_investigation_status AS ENUM (
        'IN_PROGRESS', 'READY_FOR_EXTRACTION', 'EXTRACTING',
        'NEEDS_CLARIFICATION', 'REASSESSED', 'FAILED'
      )
    """)
    op.execute("""
      CREATE TABLE customer_fraud_investigations (
        customer_investigation_id uuid PRIMARY KEY,
        fraud_investigation_id uuid NOT NULL UNIQUE REFERENCES investigations(investigation_id),
        payment_id uuid NOT NULL UNIQUE REFERENCES banking_payment_attempts(payment_id),
        customer_id uuid NOT NULL REFERENCES banking_customers(customer_id) ON DELETE RESTRICT,
        original_decision_id uuid NOT NULL REFERENCES payment_decisions(decision_id),
        original_payment_verdict text NOT NULL CHECK (original_payment_verdict = 'CHALLENGED'),
        questionnaire_version text NOT NULL,
        status customer_investigation_status NOT NULL DEFAULT 'IN_PROGRESS',
        risk_context_snapshot jsonb NOT NULL CHECK (jsonb_typeof(risk_context_snapshot) = 'object'),
        required_evidence_keys jsonb NOT NULL CHECK (jsonb_typeof(required_evidence_keys) = 'array'),
        selected_question_ids jsonb NOT NULL CHECK (jsonb_typeof(selected_question_ids) = 'array'),
        question_definitions_snapshot jsonb NOT NULL CHECK (
          jsonb_typeof(question_definitions_snapshot) = 'object'
        ),
        clarification_question jsonb CHECK (
          clarification_question IS NULL OR jsonb_typeof(clarification_question) = 'object'
        ),
        agent_invocation_count integer NOT NULL DEFAULT 0 CHECK (
          agent_invocation_count BETWEEN 0 AND 2
        ),
        started_at timestamptz NOT NULL DEFAULT now(),
        questionnaire_completed_at timestamptz,
        completed_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (customer_investigation_id, customer_id)
      )
    """)
    op.execute("""
      CREATE TABLE customer_fraud_investigation_events (
        event_id uuid PRIMARY KEY,
        customer_investigation_id uuid NOT NULL REFERENCES customer_fraud_investigations(
          customer_investigation_id
        ),
        event_type text NOT NULL CHECK (event_type IN (
          'STARTED', 'ANSWER_RECORDED', 'QUESTIONNAIRE_COMPLETED',
          'EXTRACTION_STARTED', 'CLARIFICATION_REQUESTED', 'REASSESSED', 'FAILED'
        )),
        event_payload jsonb NOT NULL CHECK (jsonb_typeof(event_payload) = 'object'),
        occurred_at timestamptz NOT NULL DEFAULT now()
      )
    """)
    op.execute("""
      CREATE TABLE customer_questionnaire_answers (
        answer_id uuid PRIMARY KEY,
        customer_investigation_id uuid NOT NULL REFERENCES customer_fraud_investigations(
          customer_investigation_id
        ),
        question_id text NOT NULL CHECK (char_length(question_id) BETWEEN 1 AND 96),
        question_version text NOT NULL,
        question_source text NOT NULL CHECK (question_source IN ('DEFINITION','AI_VALIDATED')),
        answer_payload jsonb NOT NULL CHECK (jsonb_typeof(answer_payload) = 'object'),
        provenance text NOT NULL DEFAULT 'CUSTOMER' CHECK (provenance = 'CUSTOMER'),
        idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
        answered_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (customer_investigation_id, question_id),
        UNIQUE (customer_investigation_id, idempotency_key)
      )
    """)
    op.execute("""
      CREATE TABLE fraud_intelligence_extractions (
        extraction_id uuid PRIMARY KEY,
        customer_investigation_id uuid NOT NULL REFERENCES customer_fraud_investigations(
          customer_investigation_id
        ),
        invocation_number integer NOT NULL CHECK (invocation_number BETWEEN 1 AND 2),
        request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
        agent_name text NOT NULL,
        agent_version text NOT NULL,
        provider text NOT NULL,
        model text NOT NULL,
        evidence_schema_version text NOT NULL,
        response_payload jsonb CHECK (
          response_payload IS NULL OR jsonb_typeof(response_payload) = 'object'
        ),
        schema_valid boolean NOT NULL,
        latency_ms integer NOT NULL CHECK (latency_ms >= 0),
        extraction_accuracy numeric(5,4) CHECK (
          extraction_accuracy IS NULL OR extraction_accuracy BETWEEN 0 AND 1
        ),
        error_type text,
        started_at timestamptz NOT NULL,
        finished_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (customer_investigation_id, invocation_number)
      )
    """)
    op.execute("""
      CREATE INDEX fraud_intelligence_extractions_request_idx
      ON fraud_intelligence_extractions (customer_investigation_id, request_sha256)
    """)
    op.execute("""
      CREATE TABLE customer_fraud_reassessments (
        reassessment_id uuid PRIMARY KEY,
        customer_investigation_id uuid NOT NULL REFERENCES customer_fraud_investigations(
          customer_investigation_id
        ),
        extraction_id uuid NOT NULL UNIQUE REFERENCES fraud_intelligence_extractions(extraction_id),
        policy_version text NOT NULL,
        outcome text NOT NULL CHECK (
          outcome IN ('CLEARED','REQUIRES_FURTHER_REVIEW','DECLINED')
        ),
        reason_codes jsonb NOT NULL CHECK (jsonb_typeof(reason_codes) = 'array'),
        evidence_snapshot jsonb NOT NULL CHECK (jsonb_typeof(evidence_snapshot) = 'object'),
        original_payment_verdict text NOT NULL CHECK (original_payment_verdict = 'CHALLENGED'),
        ledger_effect text NOT NULL DEFAULT 'NONE' CHECK (ledger_effect = 'NONE'),
        is_simulated boolean NOT NULL DEFAULT true CHECK (is_simulated),
        reassessed_at timestamptz NOT NULL DEFAULT now()
      )
    """)
    op.execute("""
      CREATE INDEX customer_fraud_investigations_status_idx
      ON customer_fraud_investigations (status, updated_at)
    """)
    op.execute("""
      CREATE VIEW customer_fraud_investigation_metrics AS
      SELECT
        investigation.customer_investigation_id,
        investigation.payment_id,
        investigation.questionnaire_version,
        investigation.status,
        investigation.questionnaire_completed_at IS NOT NULL AS questionnaire_completed,
        cardinality(ARRAY(
          SELECT jsonb_array_elements_text(investigation.selected_question_ids)
        )) AS selected_question_count,
        (SELECT count(*) FROM customer_questionnaire_answers answer
          WHERE answer.customer_investigation_id = investigation.customer_investigation_id
        ) AS answered_question_count,
        investigation.agent_invocation_count,
        extraction.schema_valid,
        extraction.latency_ms AS latest_agent_latency_ms,
        extraction.extraction_accuracy,
        reassessment.outcome AS reassessment_outcome,
        CASE WHEN investigation.completed_at IS NULL THEN NULL ELSE
          (extract(epoch FROM investigation.completed_at - investigation.started_at) * 1000)::bigint
        END AS end_to_end_investigation_ms
      FROM customer_fraud_investigations investigation
      LEFT JOIN LATERAL (
        SELECT candidate.* FROM fraud_intelligence_extractions candidate
        WHERE candidate.customer_investigation_id = investigation.customer_investigation_id
        ORDER BY candidate.invocation_number DESC LIMIT 1
      ) extraction ON true
      LEFT JOIN LATERAL (
        SELECT candidate.* FROM customer_fraud_reassessments candidate
        WHERE candidate.customer_investigation_id = investigation.customer_investigation_id
        ORDER BY candidate.reassessed_at DESC LIMIT 1
      ) reassessment ON true
    """)
    op.execute("""
      CREATE FUNCTION protect_customer_investigation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.payment_id IS DISTINCT FROM OLD.payment_id
          OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
          OR NEW.fraud_investigation_id IS DISTINCT FROM OLD.fraud_investigation_id
          OR NEW.original_decision_id IS DISTINCT FROM OLD.original_decision_id
          OR NEW.original_payment_verdict IS DISTINCT FROM OLD.original_payment_verdict
          OR NEW.questionnaire_version IS DISTINCT FROM OLD.questionnaire_version
          OR NEW.risk_context_snapshot IS DISTINCT FROM OLD.risk_context_snapshot
          OR NEW.required_evidence_keys IS DISTINCT FROM OLD.required_evidence_keys THEN
          RAISE EXCEPTION 'customer investigation identity and provenance are immutable'
            USING ERRCODE = '55000';
        END IF;
        NEW.updated_at = now();
        RETURN NEW;
      END $$
    """)
    op.execute("""
      CREATE TRIGGER customer_fraud_investigation_identity_immutable
      BEFORE UPDATE ON customer_fraud_investigations
      FOR EACH ROW EXECUTE FUNCTION protect_customer_investigation_identity()
    """)
    for table in (
        "customer_fraud_investigation_events",
        "customer_questionnaire_answers",
        "fraud_intelligence_extractions",
        "customer_fraud_reassessments",
    ):
        op.execute(f"""
          CREATE TRIGGER {table}_immutable
          BEFORE UPDATE OR DELETE ON {table}
          FOR EACH ROW EXECUTE FUNCTION reject_banking_immutable_mutation()
        """)


def downgrade() -> None:
    op.execute("DROP VIEW customer_fraud_investigation_metrics")
    op.execute("DROP TABLE customer_fraud_reassessments")
    op.execute("DROP TABLE fraud_intelligence_extractions")
    op.execute("DROP TABLE customer_questionnaire_answers")
    op.execute("DROP TABLE customer_fraud_investigation_events")
    op.execute("DROP TABLE customer_fraud_investigations")
    op.execute("DROP FUNCTION protect_customer_investigation_identity")
    op.execute("DROP TYPE customer_investigation_status")
