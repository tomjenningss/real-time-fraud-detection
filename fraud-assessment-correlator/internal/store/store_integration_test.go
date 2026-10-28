package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/tomjennings/real-time-fraud-detection/fraud-assessment-correlator/internal/assessment"
)

func TestPostgresTransactionRevisionAndDeduplication(t *testing.T) {
	if os.Getenv("CORRELATOR_POSTGRES_INTEGRATION") != "1" {
		t.Skip("set CORRELATOR_POSTGRES_INTEGRATION=1 against a migrated test database")
	}
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	ctx := context.Background()
	s, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	txID := "correlator-integration-" + time.Now().UTC().Format("20060102T150405.000000000")
	t.Cleanup(func() {
		s.Pool.Exec(ctx, "DELETE FROM fraud_assessment_outbox WHERE transaction_id=$1", txID)
		s.Pool.Exec(ctx, "DELETE FROM fraud_assessment_history WHERE transaction_id=$1", txID)
		s.Pool.Exec(ctx, "DELETE FROM fraud_assessments_latest WHERE transaction_id=$1", txID)
		s.Pool.Exec(ctx, "DELETE FROM fraud_assessment_source_events WHERE transaction_id=$1", txID)
	})
	now := time.Now().UTC()
	event := assessment.SourceEvent{Kind: "ML", EventID: txID + ":ml", TransactionID: txID,
		SchemaVersion: assessment.SchemaVersion, EventTime: now, Topic: "integration.fraud.risk.baseline.demo",
		Partition: 0, Offset: 1, Payload: []byte(`{"integration":true}`),
		Component: assessment.ML{FraudProbability: .4, ModelVersion: "integration-v1",
			FeatureSchemaVersion: "fraud-features-1.0.0", ModelTimestamp: now}}
	changed, err := s.Process(ctx, event)
	if err != nil || !changed {
		t.Fatalf("first process: changed=%v err=%v", changed, err)
	}
	changed, err = s.Process(ctx, event)
	if err != nil || changed {
		t.Fatalf("duplicate process: changed=%v err=%v", changed, err)
	}
	var revision, history, outbox int
	if err = s.Pool.QueryRow(ctx, "SELECT revision FROM fraud_assessments_latest WHERE transaction_id=$1", txID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if err = s.Pool.QueryRow(ctx, "SELECT count(*) FROM fraud_assessment_history WHERE transaction_id=$1", txID).Scan(&history); err != nil {
		t.Fatal(err)
	}
	if err = s.Pool.QueryRow(ctx, "SELECT count(*) FROM fraud_assessment_outbox WHERE transaction_id=$1", txID).Scan(&outbox); err != nil {
		t.Fatal(err)
	}
	if revision != 1 || history != 1 || outbox != 1 {
		t.Fatalf("revision=%d history=%d outbox=%d", revision, history, outbox)
	}
}

func TestPostgresMalformedEventCreatesPublishableDLQRecord(t *testing.T) {
	if os.Getenv("CORRELATOR_POSTGRES_INTEGRATION") != "1" {
		t.Skip("set CORRELATOR_POSTGRES_INTEGRATION=1 against a migrated test database")
	}
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	ctx := context.Background()
	s, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	offset := time.Now().UTC().UnixNano()
	topic := "integration.fraud.risk.baseline.demo"
	id := "dlq:" + topic + ":0:" + fmt.Sprint(offset)
	t.Cleanup(func() {
		s.Pool.Exec(ctx, "DELETE FROM fraud_assessment_outbox WHERE outbox_id=$1", id)
		s.Pool.Exec(ctx, "DELETE FROM fraud_assessment_rejected_events WHERE source_topic=$1 AND source_partition=0 AND source_offset=$2", topic, offset)
	})
	if err = s.RecordMalformed(ctx, topic, 0, offset, []byte("not-json"), "invalid envelope"); err != nil {
		t.Fatal(err)
	}
	var revision int
	var destination string
	if err = s.Pool.QueryRow(ctx, "SELECT revision,destination_topic FROM fraud_assessment_outbox WHERE outbox_id=$1", id).Scan(&revision, &destination); err != nil {
		t.Fatal(err)
	}
	if revision != 0 || destination != "fraud.assessments.dlq" {
		t.Fatalf("revision=%d destination=%s", revision, destination)
	}
}

func TestPostgresOutboxClaimRecovery(t *testing.T) {
	if os.Getenv("CORRELATOR_POSTGRES_INTEGRATION") != "1" {
		t.Skip("set CORRELATOR_POSTGRES_INTEGRATION=1 against a migrated test database")
	}
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	ctx := context.Background()
	s, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	txID := "correlator-outbox-recovery-" + time.Now().UTC().Format("20060102T150405.000000000")
	outboxID := txID + ":1"
	t.Cleanup(func() {
		s.Pool.Exec(ctx, "DELETE FROM fraud_assessment_outbox WHERE transaction_id=$1", txID)
		s.Pool.Exec(ctx, "DELETE FROM fraud_assessment_history WHERE transaction_id=$1", txID)
		s.Pool.Exec(ctx, "DELETE FROM fraud_assessments_latest WHERE transaction_id=$1", txID)
		s.Pool.Exec(ctx, "DELETE FROM fraud_assessment_source_events WHERE transaction_id=$1", txID)
	})
	now := time.Now().UTC()
	event := assessment.SourceEvent{Kind: "ML", EventID: txID + ":ml", TransactionID: txID,
		SchemaVersion: assessment.SchemaVersion, EventTime: now,
		Topic: "integration.fraud.risk.baseline.demo", Partition: 0, Offset: now.UnixNano(),
		Payload: []byte(`{"integration":"outbox-recovery"}`), Component: assessment.ML{
			FraudProbability: .5, ModelVersion: "integration-v1",
			FeatureSchemaVersion: "fraud-features-1.0.0", ModelTimestamp: now,
		}}
	if changed, processErr := s.Process(ctx, event); processErr != nil || !changed {
		t.Fatalf("process: changed=%v err=%v", changed, processErr)
	}
	claimed, err := s.ClaimOutbox(ctx, "interrupted-worker", 10)
	if err != nil || len(claimed) != 1 || claimed[0].ID != outboxID {
		t.Fatalf("initial claim: messages=%v err=%v", claimed, err)
	}
	if _, err = s.Pool.Exec(ctx, "UPDATE fraud_assessment_outbox SET claim_until=now()-interval '1 second' WHERE outbox_id=$1", outboxID); err != nil {
		t.Fatal(err)
	}
	reclaimed, err := s.ClaimOutbox(ctx, "recovery-worker", 10)
	if err != nil || len(reclaimed) != 1 || reclaimed[0].ID != outboxID {
		t.Fatalf("recovery claim: messages=%v err=%v", reclaimed, err)
	}
	if err = s.MarkPublished(ctx, outboxID, "recovery-worker"); err != nil {
		t.Fatal(err)
	}
	var status string
	var attempts int
	if err = s.Pool.QueryRow(ctx, "SELECT status,attempts FROM fraud_assessment_outbox WHERE outbox_id=$1", outboxID).Scan(&status, &attempts); err != nil {
		t.Fatal(err)
	}
	if status != "PUBLISHED" || attempts != 2 {
		t.Fatalf("status=%s attempts=%d", status, attempts)
	}
}
