package assessment

import (
	"fmt"
	"testing"
	"time"
)

var testTime = time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)

func TestPartialAndIncrementalOutOfOrderAssessment(t *testing.T) {
	ml := ML{FraudProbability: .87, ModelVersion: "lgbm-v1", FeatureSchemaVersion: "fraud-features-1.0.0", ModelTimestamp: testTime}
	first := SourceEvent{Kind: "ML", EventID: "ml-1", TransactionID: "tx-1", SchemaVersion: SchemaVersion, EventTime: testTime, Topic: "fraud.risk.baseline.demo", Component: ml}
	a, changed, err := Apply(nil, first, testTime)
	if err != nil || !changed || a.Revision != 1 || a.Completeness != "PARTIAL" {
		t.Fatalf("unexpected initial assessment: %#v %v", a, err)
	}
	reason := "HIGH_VELOCITY"
	deterministic := Deterministic{Verdict: "CHALLENGED", PolicyVersion: "fast-path/v1", TriggeredRuleIDs: []string{"velocity"}, InvestigationNeeded: true, InvestigationReason: &reason, EvidenceSHA256: "abc", DecidedAt: testTime.Add(-time.Second)}
	second := SourceEvent{Kind: "DETERMINISTIC", EventID: "decision-1", TransactionID: "tx-1", SchemaVersion: SchemaVersion, EventTime: deterministic.DecidedAt, Topic: "fraud.decisions.demo", Component: deterministic}
	a, changed, err = Apply(&a, second, testTime.Add(time.Second))
	if err != nil || !changed || a.Revision != 2 || a.Completeness != "PENDING_INVESTIGATION" {
		t.Fatalf("unexpected update: %#v %v", a, err)
	}
}

func TestDuplicateDoesNotIncrementRevision(t *testing.T) {
	e := SourceEvent{EventID: "ml-1", TransactionID: "tx-1", SchemaVersion: SchemaVersion, EventTime: testTime, Topic: "fraud.risk.baseline.demo", Component: ML{FraudProbability: .2, ModelVersion: "v1", FeatureSchemaVersion: "f1", ModelTimestamp: testTime}}
	a, _, _ := Apply(nil, e, testTime)
	again, changed, err := Apply(&a, e, testTime.Add(time.Second))
	if err != nil || changed || again.Revision != 1 {
		t.Fatalf("duplicate changed revision: %#v %v", again, err)
	}
}

func TestDeterministicVerdictIsImmutable(t *testing.T) {
	base := Deterministic{Verdict: "APPROVED", PolicyVersion: "v1", EvidenceSHA256: "one", DecidedAt: testTime}
	e := SourceEvent{EventID: "d1", TransactionID: "tx-1", SchemaVersion: SchemaVersion, EventTime: testTime, Topic: "fraud.decisions.demo", Component: base}
	a, _, _ := Apply(nil, e, testTime)
	base.Verdict = "BLOCKED"
	e.EventID = "d2"
	e.Component = base
	if _, _, err := Apply(&a, e, testTime); err == nil {
		t.Fatal("expected immutable verdict conflict")
	}
}

func TestCompletedBeforeRequestedPreservesBothTimestamps(t *testing.T) {
	recommendation, reason, policy, audit, mode := "CHALLENGED", "review", "p1", "postgres:audit", "dry-run"
	completedAt := testTime
	completed := Investigation{InvestigationID: "i1", Status: "COMPLETED", CompletedAt: &completedAt, Recommendation: &recommendation, Reason: &reason, PolicyVersion: &policy, AuditReference: &audit, Mode: &mode}
	a, _, _ := Apply(nil, SourceEvent{EventID: "c1", TransactionID: "tx", SchemaVersion: SchemaVersion, EventTime: testTime, Topic: "fraud.investigations.completed", Component: completed}, testTime)
	requestedAt := testTime.Add(-time.Minute)
	requested := Investigation{InvestigationID: "i1", Status: "REQUESTED", RequestedAt: &requestedAt}
	a, changed, err := Apply(&a, SourceEvent{EventID: "r1", TransactionID: "tx", SchemaVersion: SchemaVersion, EventTime: requestedAt, Topic: "fraud.investigations.requested", Component: requested}, testTime)
	if err != nil || !changed || a.Investigation.Status != "COMPLETED" || a.Investigation.RequestedAt == nil {
		t.Fatalf("out-of-order merge failed: %#v %v", a, err)
	}
}

func TestDecodeRejectsMalformedAndUnknownSchema(t *testing.T) {
	for _, payload := range [][]byte{[]byte(`not-json`), []byte(`{"schema_version":"2.0.0","event_id":"e","transaction_id":"t"}`)} {
		if _, err := Decode("fraud.risk.baseline.demo", 0, 0, payload); err == nil {
			t.Fatalf("accepted %s", payload)
		}
	}
}

func TestDecodeAllRepositoryContracts(t *testing.T) {
	ts := testTime.Format(time.RFC3339)
	cases := map[string]string{
		"fraud.decisions.demo":           fmt.Sprintf(`{"schema_version":"1.0.0","event_id":"e","decision_id":"d","transaction_id":"t","correlation_id":"c","payment_verdict":"APPROVED","decision_source":"deterministic_fast_path","policy_version":"p","triggered_rule_ids":[],"investigation_required":false,"investigation_reason":null,"source_evidence_references":[],"evidence_sha256":"h","transaction_timestamp":"%s","ingested_at":"%s","decided_at":"%s","decision_processing_latency_ms":1,"ingestion_to_decision_ms":2}`, ts, ts, ts),
		"fraud.risk.baseline.demo":       fmt.Sprintf(`{"schema_version":"1.0.0","event_id":"e","transaction_id":"t","model_version":"m","feature_schema_version":"f","fraud_probability":0.3,"model_timestamp":"%s","transaction_timestamp":"%s","scoring_latency_ms":1,"input_feature_provenance":{}}`, ts, ts),
		"fraud.investigations.requested": fmt.Sprintf(`{"schema_version":"1.0.0","event_id":"e","investigation_id":"i","decision_id":"d","transaction_id":"t","correlation_id":"c","original_payment_verdict":"CHALLENGED","routing_reason":"r","fast_path_policy_version":"p","evidence":{},"source_evidence_references":[],"requested_at":"%s"}`, ts),
		"fraud.investigations.completed": fmt.Sprintf(`{"schema_version":"1.0.0","event_id":"e","investigation_id":"i","decision_id":"d","transaction_id":"t","correlation_id":"c","original_payment_verdict":"CHALLENGED","recommended_action":"BLOCKED","investigation_policy_version":"p","triggered_rule_ids":[],"reason":"r","source_evidence_references":[],"model_configuration":{},"audit_reference":"a","mode":"dry-run","completed_at":"%s"}`, ts),
	}
	for topic, payload := range cases {
		if _, err := Decode(topic, 0, 0, []byte(payload)); err != nil {
			t.Errorf("%s: %v", topic, err)
		}
	}
}
