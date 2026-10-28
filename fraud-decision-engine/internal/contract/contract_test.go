package contract

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/tomjennings/real-time-fraud-detection/fraud-decision-engine/internal/policy"
)

func completeAssessment() Assessment {
	return Assessment{
		SchemaVersion: SchemaVersion, AssessmentID: "assessment:tx-1", TransactionID: "tx-1", Revision: 2,
		Deterministic: &Deterministic{Verdict: policy.Approved, PolicyVersion: "fast-path-policy/1.0.0", TriggeredRuleIDs: []string{"FP-APPROVE-NO-SIGNAL"}, EvidenceSHA256: "abc", SourceEvidenceReferences: []string{"kafka:payments.enriched.demo:0:1"}},
		ML:            &ML{FraudProbability: 0.8, ModelVersion: "lgbm-baseline-test", FeatureSchemaVersion: "fraud-features-1.0.0", ModelTimestamp: time.Unix(10, 0).UTC(), InputFeatureProvenance: json.RawMessage(`{"source":"flink_enrichment"}`)},
		Provenance:    []Provenance{{EventID: "event-1", Topic: "fraud.decisions.demo", Partition: 0, Offset: 1, SchemaVersion: SchemaVersion, EventTime: time.Unix(9, 0).UTC()}},
	}
}

func TestDecodeActualPartialShape(t *testing.T) {
	payload := `{"schema_version":"1.0.0","assessment_id":"assessment:tx","transaction_id":"tx","revision":1,"ml":{"fraud_probability":0.4,"model_version":"lgbm-baseline-test","feature_schema_version":"fraud-features-1.0.0","model_timestamp":"2026-10-28T12:00:00Z","input_feature_provenance":null},"provenance":[],"completeness":"PARTIAL","created_at":"2026-10-28T12:00:00Z","updated_at":"2026-10-28T12:00:00Z"}`
	assessment, err := DecodeAssessment([]byte(payload))
	if err != nil || assessment.ML == nil || assessment.Deterministic != nil {
		t.Fatalf("decode failed: assessment=%#v error=%v", assessment, err)
	}
	if result := policy.Evaluate(assessment.PolicyInput(), testPolicy()); result.Status != policy.AwaitingInputs {
		t.Fatalf("partial assessment became %v", result)
	}
}

func TestOutputPreservesProvenanceAndDoesNotUseInvestigation(t *testing.T) {
	a := completeAssessment()
	a.Investigation = json.RawMessage(`{"status":"COMPLETED","recommendation":"APPROVED"}`)
	result := policy.Evaluate(a.PolicyInput(), testPolicy())
	decision, err := NewShadowDecision(a, result, testPolicy(), time.Unix(20, 0).UTC(), 50*time.Microsecond)
	if err != nil {
		t.Fatal(err)
	}
	if decision.ProposedAction != policy.Challenged || decision.OriginalPaymentVerdict != policy.Approved || !decision.DiffersFromOriginal {
		t.Fatalf("unexpected decision: %#v", decision)
	}
	if !strings.Contains(string(decision.InvestigationContext), `"recommendation":"APPROVED"`) || len(decision.InputProvenance.Assessment) != 1 {
		t.Fatalf("audit provenance missing: %#v", decision)
	}
}

func TestEvaluationIDIsStableAndPolicyVersioned(t *testing.T) {
	one := EvaluationID("assessment:tx", 2, "fraud-action-policy-v1")
	if one != EvaluationID("assessment:tx", 2, "fraud-action-policy-v1") {
		t.Fatal("evaluation ID is not reproducible")
	}
	if one == EvaluationID("assessment:tx", 2, "fraud-action-policy-v2") || one == EvaluationID("assessment:tx", 3, "fraud-action-policy-v1") {
		t.Fatal("evaluation ID does not include policy version and source revision")
	}
}

func testPolicy() policy.Config {
	return policy.Config{Version: "fraud-action-policy-v1", ChallengeThreshold: 0.24, BlockThreshold: 0.70, SupportedModelVersionPrefix: "lgbm-baseline-", SupportedFeatureSchemaVersion: "fraud-features-1.0.0"}
}
