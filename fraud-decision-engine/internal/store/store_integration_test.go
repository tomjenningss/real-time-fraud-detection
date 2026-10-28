package store

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/tomjennings/real-time-fraud-detection/fraud-decision-engine/internal/contract"
	"github.com/tomjennings/real-time-fraud-detection/fraud-decision-engine/internal/ordering"
	"github.com/tomjennings/real-time-fraud-detection/fraud-decision-engine/internal/policy"
)

func TestPostgresDuplicateOutOfOrderAndPolicyVersion(t *testing.T) {
	if os.Getenv("SHADOW_ENGINE_POSTGRES_INTEGRATION") != "1" {
		t.Skip("set SHADOW_ENGINE_POSTGRES_INTEGRATION=1 to run")
	}
	ctx := context.Background()
	s, err := Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	txID := "shadow-engine-integration-" + time.Now().UTC().Format("20060102T150405.000000000")
	assessmentID := "assessment:" + txID
	t.Cleanup(func() {
		cleanup := []string{
			"DELETE FROM fraud_shadow_decision_outbox WHERE transaction_id=$1",
			"DELETE FROM fraud_shadow_decision_history WHERE transaction_id=$1",
			"DELETE FROM fraud_shadow_decision_state WHERE transaction_id=$1",
			"DELETE FROM fraud_shadow_assessment_events WHERE transaction_id=$1",
		}
		for _, statement := range cleanup {
			if _, cleanupErr := s.Pool.Exec(ctx, statement, txID); cleanupErr != nil {
				t.Errorf("integration cleanup failed: %v", cleanupErr)
			}
		}
		s.Close()
	})

	config := integrationPolicy("fraud-action-policy-integration-v1")
	revisionTwo := integrationEvaluation(t, txID, assessmentID, 2, config, 0.8, 20)
	outcome, err := s.Process(ctx, revisionTwo, config)
	if err != nil || outcome.Status != policy.Evaluated || outcome.Action != policy.Challenged {
		t.Fatalf("first evaluation outcome=%#v error=%v", outcome, err)
	}
	outcome, err = s.Process(ctx, revisionTwo, config)
	if err != nil || outcome.Classification != ordering.Duplicate {
		t.Fatalf("duplicate outcome=%#v error=%v", outcome, err)
	}
	revisionOne := integrationEvaluation(t, txID, assessmentID, 1, config, 0.1, 19)
	outcome, err = s.Process(ctx, revisionOne, config)
	if err != nil || outcome.Classification != ordering.Obsolete {
		t.Fatalf("obsolete outcome=%#v error=%v", outcome, err)
	}

	configV2 := integrationPolicy("fraud-action-policy-integration-v2")
	revisionTwoV2 := integrationEvaluation(t, txID, assessmentID, 2, configV2, 0.8, 20)
	outcome, err = s.Process(ctx, revisionTwoV2, configV2)
	if err != nil || outcome.Status != policy.Evaluated {
		t.Fatalf("policy v2 outcome=%#v error=%v", outcome, err)
	}
	var history, outbox, sourceEvents int
	if err = s.Pool.QueryRow(ctx, "SELECT count(*) FROM fraud_shadow_decision_history WHERE transaction_id=$1", txID).Scan(&history); err != nil {
		t.Fatal(err)
	}
	if err = s.Pool.QueryRow(ctx, "SELECT count(*) FROM fraud_shadow_decision_outbox WHERE transaction_id=$1", txID).Scan(&outbox); err != nil {
		t.Fatal(err)
	}
	if err = s.Pool.QueryRow(ctx, "SELECT count(*) FROM fraud_shadow_assessment_events WHERE transaction_id=$1", txID).Scan(&sourceEvents); err != nil {
		t.Fatal(err)
	}
	if history != 2 || outbox != 2 || sourceEvents != 3 {
		t.Fatalf("history=%d outbox=%d source_events=%d", history, outbox, sourceEvents)
	}
}

func integrationEvaluation(t *testing.T, txID, assessmentID string, revision int64, config policy.Config, probability float64, offset int64) Evaluation {
	t.Helper()
	a := contract.Assessment{
		SchemaVersion: contract.SchemaVersion, AssessmentID: assessmentID, TransactionID: txID, Revision: revision,
		Deterministic: &contract.Deterministic{Verdict: policy.Approved, PolicyVersion: "fast-path-policy/1.0.0", TriggeredRuleIDs: []string{"FP-APPROVE-NO-SIGNAL"}, EvidenceSHA256: "test"},
		ML:            &contract.ML{FraudProbability: probability, ModelVersion: "lgbm-baseline-integration", FeatureSchemaVersion: "fraud-features-1.0.0", ModelTimestamp: time.Now().UTC()},
	}
	raw, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	result := policy.Evaluate(a.PolicyInput(), config)
	decision, err := contract.NewShadowDecision(a, result, config, time.Now().UTC(), time.Since(started))
	if err != nil {
		t.Fatal(err)
	}
	return Evaluation{Assessment: a, Raw: raw, Position: SourcePosition{Topic: "integration.fraud.assessments.correlated", Partition: 0, Offset: offset}, Result: result, Decision: &decision}
}

func integrationPolicy(version string) policy.Config {
	return policy.Config{Version: version, ChallengeThreshold: 0.24, BlockThreshold: 0.70, SupportedModelVersionPrefix: "lgbm-baseline-", SupportedFeatureSchemaVersion: "fraud-features-1.0.0"}
}
