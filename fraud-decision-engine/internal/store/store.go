package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tomjennings/real-time-fraud-detection/fraud-decision-engine/internal/contract"
	"github.com/tomjennings/real-time-fraud-detection/fraud-decision-engine/internal/ordering"
	"github.com/tomjennings/real-time-fraud-detection/fraud-decision-engine/internal/policy"
)

var ErrAssessmentConflict = errors.New("source assessment revision identity conflict")

type Store struct{ Pool *pgxpool.Pool }

type SourcePosition struct {
	Topic     string
	Partition int32
	Offset    int64
}

type Evaluation struct {
	Assessment contract.Assessment
	Raw        []byte
	Position   SourcePosition
	Result     policy.Result
	Decision   *contract.ShadowDecision
}

type ProcessOutcome struct {
	Classification string
	Status         string
	Action         string
	Agreement      bool
	LatencyMS      float64
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{Pool: pool}, nil
}

func (s *Store) Close()                          { s.Pool.Close() }
func (s *Store) Ready(ctx context.Context) error { return s.Pool.Ping(ctx) }

// Process records ordering state and an evaluated decision plus outbox message atomically.
// Incomplete or invalid assessments are recorded for audit but never published as decisions.
func (s *Store) Process(ctx context.Context, evaluation Evaluation, config policy.Config) (ProcessOutcome, error) {
	a := evaluation.Assessment
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ProcessOutcome{}, err
	}
	defer tx.Rollback(ctx)
	lockKey := a.TransactionID + ":policy:" + config.Version
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", lockKey); err != nil {
		return ProcessOutcome{}, err
	}

	digest := sha256.Sum256(evaluation.Raw)
	digestText := hex.EncodeToString(digest[:])
	var existingDigest string
	err = tx.QueryRow(ctx, `SELECT payload_sha256 FROM fraud_shadow_assessment_events
		WHERE source_assessment_id=$1 AND source_revision=$2 AND policy_version=$3`,
		a.AssessmentID, a.Revision, config.Version).Scan(&existingDigest)
	if err == nil {
		if existingDigest != digestText {
			return ProcessOutcome{}, ErrAssessmentConflict
		}
		return ProcessOutcome{Classification: ordering.Duplicate, Status: "DUPLICATE"}, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return ProcessOutcome{}, err
	}

	var latestRevision int64
	var stateAssessmentID string
	err = tx.QueryRow(ctx, `SELECT source_assessment_id,latest_source_revision
		FROM fraud_shadow_decision_state WHERE transaction_id=$1 AND policy_version=$2 FOR UPDATE`,
		a.TransactionID, config.Version).Scan(&stateAssessmentID, &latestRevision)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return ProcessOutcome{}, err
	}
	if err == nil && stateAssessmentID != a.AssessmentID {
		return ProcessOutcome{}, errors.New("transaction maps to conflicting assessment identity")
	}

	classification := ordering.Classify(false, latestRevision, a.Revision)
	status := evaluation.Result.Status
	if classification == ordering.Obsolete {
		status = "OBSOLETE"
	}
	if err = insertSourceEvent(ctx, tx, evaluation, config.Version, digestText, status); err != nil {
		return ProcessOutcome{}, err
	}
	if classification == ordering.Obsolete {
		return ProcessOutcome{Classification: classification, Status: status}, tx.Commit(ctx)
	}
	_, err = tx.Exec(ctx, `INSERT INTO fraud_shadow_decision_state
		(transaction_id,policy_version,source_assessment_id,latest_source_revision,updated_at)
		VALUES ($1,$2,$3,$4,now()) ON CONFLICT (transaction_id,policy_version) DO UPDATE SET
		source_assessment_id=EXCLUDED.source_assessment_id,
		latest_source_revision=EXCLUDED.latest_source_revision,updated_at=now()`,
		a.TransactionID, config.Version, a.AssessmentID, a.Revision)
	if err != nil {
		return ProcessOutcome{}, err
	}
	if evaluation.Result.Status != policy.Evaluated {
		return ProcessOutcome{Classification: classification, Status: status}, tx.Commit(ctx)
	}
	if evaluation.Decision == nil {
		return ProcessOutcome{}, errors.New("evaluated result is missing shadow decision")
	}
	body, err := json.Marshal(evaluation.Decision)
	if err != nil {
		return ProcessOutcome{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO fraud_shadow_decision_history
		(shadow_evaluation_id,transaction_id,source_assessment_id,source_revision,policy_version,
		 proposed_action,original_payment_verdict,differs_from_original,decision,evaluated_at,evaluation_latency_ms)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, evaluation.Decision.ShadowEvaluationID,
		a.TransactionID, a.AssessmentID, a.Revision, config.Version, evaluation.Decision.ProposedAction,
		evaluation.Decision.OriginalPaymentVerdict, evaluation.Decision.DiffersFromOriginal, body,
		evaluation.Decision.EvaluatedAt, evaluation.Decision.EvaluationLatencyMS)
	if err != nil {
		return ProcessOutcome{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO fraud_shadow_decision_outbox
		(outbox_id,shadow_evaluation_id,transaction_id,source_revision,destination_topic,message_key,payload)
		VALUES ($1,$1,$2,$3,'fraud.decisions.shadow.demo',$2,$4)`, evaluation.Decision.ShadowEvaluationID,
		a.TransactionID, a.Revision, body)
	if err != nil {
		return ProcessOutcome{}, err
	}
	return ProcessOutcome{Classification: classification, Status: status, Action: evaluation.Decision.ProposedAction,
		Agreement: !evaluation.Decision.DiffersFromOriginal, LatencyMS: evaluation.Decision.EvaluationLatencyMS}, tx.Commit(ctx)
}

func insertSourceEvent(ctx context.Context, tx pgx.Tx, evaluation Evaluation, policyVersion, digest, status string) error {
	a := evaluation.Assessment
	reason := ""
	if len(evaluation.Result.Reasons) > 0 {
		reason = evaluation.Result.Reasons[0].Code
	}
	_, err := tx.Exec(ctx, `INSERT INTO fraud_shadow_assessment_events
		(source_assessment_id,source_revision,policy_version,transaction_id,source_topic,source_partition,
		 source_offset,payload_sha256,payload,processing_status,status_reason)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, a.AssessmentID, a.Revision, policyVersion,
		a.TransactionID, evaluation.Position.Topic, evaluation.Position.Partition, evaluation.Position.Offset,
		digest, evaluation.Raw, status, reason)
	return err
}

func (s *Store) RecordMalformed(ctx context.Context, position SourcePosition, payload []byte, policyVersion, reason string) error {
	digest := sha256.Sum256(payload)
	digestText := hex.EncodeToString(digest[:])
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `INSERT INTO fraud_shadow_decision_rejected_events
		(source_topic,source_partition,source_offset,policy_version,payload_sha256,rejection_reason)
		VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (source_topic,source_partition,source_offset,policy_version) DO NOTHING`,
		position.Topic, position.Partition, position.Offset, policyVersion, digestText, reason)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 1 {
		id := fmt.Sprintf("shadow-dlq:%s:%d:%d:%s", position.Topic, position.Partition, position.Offset, policyVersion)
		dlq, _ := json.Marshal(map[string]any{"schema_version": contract.SchemaVersion, "event_id": id,
			"source_topic": position.Topic, "source_partition": position.Partition, "source_offset": position.Offset,
			"policy_version": policyVersion, "payload_sha256": digestText, "failure_type": "VALIDATION_ERROR"})
		_, err = tx.Exec(ctx, `INSERT INTO fraud_shadow_decision_outbox
			(outbox_id,transaction_id,source_revision,destination_topic,message_key,payload)
			VALUES ($1,$1,0,'fraud.decisions.shadow.dlq',$1,$2) ON CONFLICT (outbox_id) DO NOTHING`, id, dlq)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

type OutboxMessage struct {
	ID, Topic, Key string
	Payload        []byte
}

func (s *Store) ClaimOutbox(ctx context.Context, worker string, limit int) ([]OutboxMessage, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT outbox_id,destination_topic,message_key,payload
		FROM fraud_shadow_decision_outbox WHERE (status='PENDING' OR (status='CLAIMED' AND claim_until < now()))
		AND available_at <= now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var messages []OutboxMessage
	var ids []string
	for rows.Next() {
		var message OutboxMessage
		if err = rows.Scan(&message.ID, &message.Topic, &message.Key, &message.Payload); err != nil {
			return nil, err
		}
		messages = append(messages, message)
		ids = append(ids, message.ID)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) > 0 {
		_, err = tx.Exec(ctx, `UPDATE fraud_shadow_decision_outbox SET status='CLAIMED',claimed_by=$1,
			claim_until=now()+interval '30 seconds',attempts=attempts+1 WHERE outbox_id=ANY($2)`, worker, ids)
		if err != nil {
			return nil, err
		}
	}
	return messages, tx.Commit(ctx)
}

func (s *Store) MarkPublished(ctx context.Context, id, worker string) error {
	tag, err := s.Pool.Exec(ctx, `UPDATE fraud_shadow_decision_outbox SET status='PUBLISHED',published_at=now(),claim_until=NULL
		WHERE outbox_id=$1 AND status='CLAIMED' AND claimed_by=$2`, id, worker)
	if err == nil && tag.RowsAffected() != 1 {
		return errors.New("outbox claim lost")
	}
	return err
}

func (s *Store) Release(ctx context.Context, id, worker, errorType string) error {
	_, err := s.Pool.Exec(ctx, `UPDATE fraud_shadow_decision_outbox SET status='PENDING',claimed_by=NULL,claim_until=NULL,
		available_at=now()+interval '5 seconds',last_error_type=$3 WHERE outbox_id=$1 AND claimed_by=$2`, id, worker, errorType)
	return err
}

// EvaluationSummary returns aggregate shadow-policy observations for the report endpoint.
func (s *Store) EvaluationSummary(ctx context.Context, policyVersion string) ([]byte, error) {
	rows, err := s.Pool.Query(ctx, `WITH latest AS (
		SELECT h.proposed_action,h.original_payment_verdict,h.evaluation_latency_ms
		FROM fraud_shadow_decision_history h JOIN fraud_shadow_decision_state s
		ON s.transaction_id=h.transaction_id AND s.policy_version=h.policy_version
		AND s.latest_source_revision=h.source_revision
		WHERE h.policy_version=$1
	) SELECT proposed_action,original_payment_verdict,count(*),avg(evaluation_latency_ms)
		FROM latest GROUP BY proposed_action,original_payment_verdict
		ORDER BY proposed_action,original_payment_verdict`, policyVersion)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type cell struct {
		Proposed string  `json:"proposed_action"`
		Original string  `json:"original_payment_verdict"`
		Count    int64   `json:"count"`
		MeanMS   float64 `json:"mean_evaluation_latency_ms"`
	}
	var cells []cell
	actions := map[string]int64{}
	originals := map[string]int64{}
	var evaluated, agreements int64
	var weightedLatencyMS float64
	for rows.Next() {
		var value cell
		if err = rows.Scan(&value.Proposed, &value.Original, &value.Count, &value.MeanMS); err != nil {
			return nil, err
		}
		cells = append(cells, value)
		actions[value.Proposed] += value.Count
		originals[value.Original] += value.Count
		evaluated += value.Count
		weightedLatencyMS += value.MeanMS * float64(value.Count)
		if value.Proposed == value.Original {
			agreements += value.Count
		}
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	statusRows, err := s.Pool.Query(ctx, `SELECT e.processing_status,count(*)
		FROM fraud_shadow_decision_state s JOIN fraud_shadow_assessment_events e
		ON e.source_assessment_id=s.source_assessment_id
		AND e.source_revision=s.latest_source_revision AND e.policy_version=s.policy_version
		WHERE s.policy_version=$1 AND e.processing_status <> 'EVALUATED'
		GROUP BY e.processing_status ORDER BY e.processing_status`, policyVersion)
	if err != nil {
		return nil, err
	}
	defer statusRows.Close()
	insufficient := map[string]int64{}
	for statusRows.Next() {
		var status string
		var count int64
		if err = statusRows.Scan(&status, &count); err != nil {
			return nil, err
		}
		insufficient[status] = count
	}
	meanLatencyMS := float64(0)
	if evaluated > 0 {
		meanLatencyMS = weightedLatencyMS / float64(evaluated)
	}
	return json.Marshal(map[string]any{
		"policy_version": policyVersion, "transactions_evaluated": evaluated,
		"shadow_action_distribution": actions, "original_verdict_distribution": originals,
		"agreements": agreements, "disagreements": evaluated - agreements,
		"agreement_matrix": cells, "latest_unevaluated_transactions": insufficient,
		"mean_policy_evaluation_latency_ms": meanLatencyMS, "generated_at": time.Now().UTC(),
	})
}
