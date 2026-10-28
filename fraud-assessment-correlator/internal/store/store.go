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
	"github.com/tomjennings/real-time-fraud-detection/fraud-assessment-correlator/internal/assessment"
)

var ErrEventConflict = errors.New("source event identity conflict")

type Store struct{ Pool *pgxpool.Pool }

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

// Process durably records one source event and, for meaningful changes, the
// latest snapshot, append-only history, and publication outbox in one transaction.
func (s *Store) Process(ctx context.Context, event assessment.SourceEvent) (bool, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", event.TransactionID); err != nil {
		return false, err
	}
	digest := sha256.Sum256(event.Payload)
	var existingDigest string
	err = tx.QueryRow(ctx, "SELECT payload_sha256 FROM fraud_assessment_source_events WHERE event_id=$1", event.EventID).Scan(&existingDigest)
	if err == nil {
		if existingDigest != hex.EncodeToString(digest[:]) {
			return false, ErrEventConflict
		}
		return false, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}

	var current assessment.Assessment
	var raw []byte
	err = tx.QueryRow(ctx, "SELECT assessment FROM fraud_assessments_latest WHERE transaction_id=$1 FOR UPDATE", event.TransactionID).Scan(&raw)
	var currentPtr *assessment.Assessment
	if err == nil {
		if err = json.Unmarshal(raw, &current); err != nil {
			return false, err
		}
		currentPtr = &current
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}

	next, changed, applyErr := assessment.Apply(currentPtr, event, time.Now().UTC())
	valid := applyErr == nil
	_, err = tx.Exec(ctx, `INSERT INTO fraud_assessment_source_events
		(event_id, transaction_id, event_kind, source_topic, source_partition, source_offset,
		 schema_version, event_timestamp, payload_sha256, payload, valid, validation_error)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, event.EventID, event.TransactionID,
		event.Kind, event.Topic, event.Partition, event.Offset, event.SchemaVersion, event.EventTime,
		hex.EncodeToString(digest[:]), event.Payload, valid, errorString(applyErr))
	if err != nil {
		return false, err
	}
	if applyErr != nil {
		return false, tx.Commit(ctx)
	}
	if !changed {
		return false, tx.Commit(ctx)
	}

	body, err := json.Marshal(next)
	if err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO fraud_assessments_latest
		(transaction_id, revision, assessment, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (transaction_id) DO UPDATE SET revision=EXCLUDED.revision,
		assessment=EXCLUDED.assessment, updated_at=EXCLUDED.updated_at`, next.TransactionID,
		next.Revision, body, next.CreatedAt, next.UpdatedAt)
	if err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO fraud_assessment_history
		(transaction_id, revision, source_event_id, assessment, created_at) VALUES ($1,$2,$3,$4,$5)`,
		next.TransactionID, next.Revision, event.EventID, body, next.UpdatedAt)
	if err != nil {
		return false, err
	}
	outboxID := fmt.Sprintf("%s:%d", next.TransactionID, next.Revision)
	_, err = tx.Exec(ctx, `INSERT INTO fraud_assessment_outbox
		(outbox_id, transaction_id, revision, destination_topic, message_key, payload)
		VALUES ($1,$2,$3,'fraud.assessments.correlated.demo',$2,$4)`, outboxID, next.TransactionID, next.Revision, body)
	if err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

func (s *Store) RecordMalformed(ctx context.Context, topic string, partition int32, offset int64, payload []byte, reason string) error {
	digest := sha256.Sum256(payload)
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `INSERT INTO fraud_assessment_rejected_events
		(source_topic, source_partition, source_offset, payload_sha256, rejection_reason)
		VALUES ($1,$2,$3,$4,$5) ON CONFLICT (source_topic,source_partition,source_offset) DO NOTHING`,
		topic, partition, offset, hex.EncodeToString(digest[:]), reason)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 1 {
		id := fmt.Sprintf("dlq:%s:%d:%d", topic, partition, offset)
		dlq, _ := json.Marshal(map[string]any{"schema_version": assessment.SchemaVersion, "event_id": id,
			"source_topic": topic, "source_partition": partition, "source_offset": offset,
			"payload_sha256": hex.EncodeToString(digest[:]), "failure_type": "VALIDATION_ERROR"})
		_, err = tx.Exec(ctx, `INSERT INTO fraud_assessment_outbox
			(outbox_id,transaction_id,revision,destination_topic,message_key,payload)
			VALUES ($1,$1,0,'fraud.assessments.dlq',$1,$2) ON CONFLICT (outbox_id) DO NOTHING`, id, dlq)
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
		FROM fraud_assessment_outbox WHERE (status='PENDING' OR (status='CLAIMED' AND claim_until < now()))
		AND available_at <= now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var messages []OutboxMessage
	var ids []string
	for rows.Next() {
		var m OutboxMessage
		if err = rows.Scan(&m.ID, &m.Topic, &m.Key, &m.Payload); err != nil {
			return nil, err
		}
		messages = append(messages, m)
		ids = append(ids, m.ID)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) > 0 {
		_, err = tx.Exec(ctx, `UPDATE fraud_assessment_outbox SET status='CLAIMED',claimed_by=$1,
		claim_until=now()+interval '30 seconds',attempts=attempts+1 WHERE outbox_id=ANY($2)`, worker, ids)
		if err != nil {
			return nil, err
		}
	}
	return messages, tx.Commit(ctx)
}

func (s *Store) MarkPublished(ctx context.Context, id, worker string) error {
	tag, err := s.Pool.Exec(ctx, `UPDATE fraud_assessment_outbox SET status='PUBLISHED',published_at=now(),claim_until=NULL
		WHERE outbox_id=$1 AND status='CLAIMED' AND claimed_by=$2`, id, worker)
	if err == nil && tag.RowsAffected() != 1 {
		return errors.New("outbox claim lost")
	}
	return err
}
func (s *Store) Release(ctx context.Context, id, worker, errorType string) error {
	_, err := s.Pool.Exec(ctx, `UPDATE fraud_assessment_outbox SET status='PENDING',claimed_by=NULL,claim_until=NULL,
		available_at=now()+interval '5 seconds',last_error_type=$3 WHERE outbox_id=$1 AND claimed_by=$2`, id, worker, errorType)
	return err
}
func errorString(err error) any {
	if err == nil {
		return nil
	}
	return err.Error()
}
