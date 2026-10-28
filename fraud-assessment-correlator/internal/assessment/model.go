package assessment

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
)

const SchemaVersion = "1.0.0"

type Provenance struct {
	EventID       string          `json:"event_id"`
	Topic         string          `json:"topic"`
	Partition     int32           `json:"partition"`
	Offset        int64           `json:"offset"`
	SchemaVersion string          `json:"schema_version"`
	EventTime     time.Time       `json:"event_time"`
	Payload       json.RawMessage `json:"payload,omitempty"`
}

type Deterministic struct {
	Verdict                  string    `json:"verdict"`
	PolicyVersion            string    `json:"policy_version"`
	TriggeredRuleIDs         []string  `json:"triggered_rule_ids"`
	Signals                  []string  `json:"signals,omitempty"`
	InvestigationNeeded      bool      `json:"investigation_required"`
	InvestigationReason      *string   `json:"investigation_reason,omitempty"`
	EvidenceSHA256           string    `json:"evidence_sha256"`
	DecidedAt                time.Time `json:"decided_at"`
	SourceEvidenceReferences []string  `json:"source_evidence_references"`
}

type ML struct {
	FraudProbability     float64         `json:"fraud_probability"`
	ModelVersion         string          `json:"model_version"`
	FeatureSchemaVersion string          `json:"feature_schema_version"`
	ModelTimestamp       time.Time       `json:"model_timestamp"`
	FeatureProvenance    json.RawMessage `json:"input_feature_provenance"`
}

type Investigation struct {
	InvestigationID          string            `json:"investigation_id"`
	Status                   string            `json:"status"`
	RequestedAt              *time.Time        `json:"requested_at,omitempty"`
	CompletedAt              *time.Time        `json:"completed_at,omitempty"`
	Recommendation           *string           `json:"recommendation,omitempty"`
	Reason                   *string           `json:"reason,omitempty"`
	PolicyVersion            *string           `json:"policy_version,omitempty"`
	TriggeredRuleIDs         []string          `json:"triggered_rule_ids,omitempty"`
	ModelConfiguration       map[string]string `json:"model_configuration,omitempty"`
	AuditReference           *string           `json:"audit_reference,omitempty"`
	Mode                     *string           `json:"mode,omitempty"`
	RoutingReason            *string           `json:"routing_reason,omitempty"`
	EvidenceSignals          []string          `json:"evidence_signals,omitempty"`
	SourceEvidenceReferences []string          `json:"source_evidence_references,omitempty"`
}

type Assessment struct {
	SchemaVersion string         `json:"schema_version"`
	AssessmentID  string         `json:"assessment_id"`
	TransactionID string         `json:"transaction_id"`
	Revision      int64          `json:"revision"`
	Deterministic *Deterministic `json:"deterministic,omitempty"`
	ML            *ML            `json:"ml,omitempty"`
	Investigation *Investigation `json:"investigation,omitempty"`
	Provenance    []Provenance   `json:"provenance"`
	Completeness  string         `json:"completeness"`
	CreatedAt     time.Time      `json:"created_at"`
	UpdatedAt     time.Time      `json:"updated_at"`
}

type SourceEvent struct {
	Kind          string
	EventID       string
	TransactionID string
	SchemaVersion string
	EventTime     time.Time
	Topic         string
	Partition     int32
	Offset        int64
	Payload       []byte
	Component     any
}

func Decode(topic string, partition int32, offset int64, payload []byte) (SourceEvent, error) {
	var envelope struct {
		SchemaVersion string `json:"schema_version"`
		EventID       string `json:"event_id"`
		TransactionID string `json:"transaction_id"`
	}
	if err := strictUnmarshal(payload, &envelope, false); err != nil {
		return SourceEvent{}, fmt.Errorf("invalid envelope: %w", err)
	}
	if envelope.SchemaVersion != SchemaVersion || envelope.EventID == "" || envelope.TransactionID == "" {
		return SourceEvent{}, errors.New("unsupported schema_version or missing identity")
	}
	e := SourceEvent{EventID: envelope.EventID, TransactionID: envelope.TransactionID, SchemaVersion: envelope.SchemaVersion, Topic: topic, Partition: partition, Offset: offset, Payload: payload}
	switch topic {
	case "fraud.decisions.demo":
		var v decisionEvent
		if err := strictUnmarshal(payload, &v, true); err != nil {
			return SourceEvent{}, err
		}
		if !validVerdict(v.PaymentVerdict) {
			return SourceEvent{}, errors.New("invalid payment_verdict")
		}
		e.Kind, e.EventTime = "DETERMINISTIC", v.DecidedAt
		e.Component = Deterministic{Verdict: v.PaymentVerdict, PolicyVersion: v.PolicyVersion,
			TriggeredRuleIDs: v.TriggeredRuleIDs, InvestigationNeeded: v.InvestigationRequired,
			InvestigationReason: v.InvestigationReason, EvidenceSHA256: v.EvidenceSHA256,
			DecidedAt: v.DecidedAt, SourceEvidenceReferences: v.SourceEvidenceReferences}
	case "fraud.risk.baseline.demo":
		var v riskEvent
		if err := strictUnmarshal(payload, &v, true); err != nil {
			return SourceEvent{}, err
		}
		if v.FraudProbability < 0 || v.FraudProbability > 1 {
			return SourceEvent{}, errors.New("fraud_probability outside [0,1]")
		}
		e.Kind, e.EventTime = "ML", v.ModelTimestamp
		e.Component = ML{v.FraudProbability, v.ModelVersion, v.FeatureSchemaVersion, v.ModelTimestamp, v.InputFeatureProvenance}
	case "fraud.investigations.requested":
		var v requestEvent
		if err := strictUnmarshal(payload, &v, true); err != nil {
			return SourceEvent{}, err
		}
		e.Kind, e.EventTime = "INVESTIGATION_REQUESTED", v.RequestedAt
		t := v.RequestedAt
		routing := v.RoutingReason
		var evidence requestEvidence
		if err := json.Unmarshal(v.Evidence, &evidence); err != nil {
			return SourceEvent{}, errors.New("invalid investigation evidence")
		}
		e.Component = Investigation{InvestigationID: v.InvestigationID, Status: "REQUESTED", RequestedAt: &t,
			RoutingReason: &routing, EvidenceSignals: evidence.Signals,
			SourceEvidenceReferences: v.SourceEvidenceReferences}
	case "fraud.investigations.completed":
		var v completedEvent
		if err := strictUnmarshal(payload, &v, true); err != nil {
			return SourceEvent{}, err
		}
		if !validVerdict(v.OriginalPaymentVerdict) || !validVerdict(v.RecommendedAction) {
			return SourceEvent{}, errors.New("invalid investigation verdict")
		}
		t, recommendation, reason, policy, audit, mode := v.CompletedAt, v.RecommendedAction, v.Reason, v.InvestigationPolicyVersion, v.AuditReference, v.Mode
		e.Kind, e.EventTime = "INVESTIGATION_COMPLETED", v.CompletedAt
		e.Component = Investigation{InvestigationID: v.InvestigationID, Status: "COMPLETED", CompletedAt: &t,
			Recommendation: &recommendation, Reason: &reason, PolicyVersion: &policy,
			TriggeredRuleIDs: v.TriggeredRuleIDs, ModelConfiguration: v.ModelConfiguration,
			AuditReference: &audit, Mode: &mode, SourceEvidenceReferences: v.SourceEvidenceReferences}
	default:
		return SourceEvent{}, errors.New("unsupported topic")
	}
	return e, nil
}

func Apply(current *Assessment, event SourceEvent, now time.Time) (Assessment, bool, error) {
	var next Assessment
	if current == nil {
		next = Assessment{SchemaVersion: SchemaVersion, AssessmentID: "assessment:" + event.TransactionID, TransactionID: event.TransactionID, CreatedAt: now}
	} else {
		next = *current
		next.Provenance = append([]Provenance(nil), current.Provenance...)
	}
	if next.TransactionID != event.TransactionID {
		return Assessment{}, false, errors.New("transaction identity mismatch")
	}
	changed := false
	switch component := event.Component.(type) {
	case Deterministic:
		if next.Investigation != nil && len(next.Investigation.EvidenceSignals) > 0 {
			component.Signals = append([]string(nil), next.Investigation.EvidenceSignals...)
		}
		if next.Deterministic != nil {
			if !equalJSON(*next.Deterministic, component) {
				return Assessment{}, false, errors.New("immutable deterministic verdict conflict")
			}
		} else {
			next.Deterministic, changed = &component, true
		}
	case ML:
		if next.ML == nil || event.EventTime.After(next.ML.ModelTimestamp) {
			if next.ML == nil || !equalJSON(*next.ML, component) {
				next.ML, changed = &component, true
			}
		}
	case Investigation:
		if next.Investigation == nil {
			next.Investigation, changed = &component, true
		} else if next.Investigation.InvestigationID != component.InvestigationID {
			return Assessment{}, false, errors.New("investigation identity conflict")
		} else if component.Status == "COMPLETED" && next.Investigation.Status != "COMPLETED" {
			component.RequestedAt = next.Investigation.RequestedAt
			component.RoutingReason = next.Investigation.RoutingReason
			component.EvidenceSignals = next.Investigation.EvidenceSignals
			next.Investigation, changed = &component, true
		} else if component.Status == "REQUESTED" && next.Investigation.RequestedAt == nil {
			copy := *next.Investigation
			copy.RequestedAt = component.RequestedAt
			copy.RoutingReason = component.RoutingReason
			copy.EvidenceSignals = component.EvidenceSignals
			next.Investigation, changed = &copy, true
			if next.Deterministic != nil && len(component.EvidenceSignals) > 0 {
				deterministic := *next.Deterministic
				deterministic.Signals = append([]string(nil), component.EvidenceSignals...)
				next.Deterministic = &deterministic
			}
		}
	default:
		return Assessment{}, false, errors.New("unknown component")
	}
	if !changed {
		return next, false, nil
	}
	next.Revision++
	next.UpdatedAt = now
	next.Provenance = append(next.Provenance, Provenance{event.EventID, event.Topic, event.Partition, event.Offset, event.SchemaVersion, event.EventTime, nil})
	next.Completeness = completeness(next)
	return next, true, nil
}

func completeness(a Assessment) string {
	if a.Deterministic == nil || a.ML == nil {
		return "PARTIAL"
	}
	if a.Deterministic.InvestigationNeeded && (a.Investigation == nil || a.Investigation.Status != "COMPLETED") {
		return "PENDING_INVESTIGATION"
	}
	return "COMPLETE"
}

func equalJSON(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}
func validVerdict(v string) bool { return v == "APPROVED" || v == "CHALLENGED" || v == "BLOCKED" }
func strictUnmarshal(payload []byte, target any, disallowUnknown bool) error {
	d := json.NewDecoder(bytes.NewReader(payload))
	if disallowUnknown {
		d.DisallowUnknownFields()
	}
	if err := d.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("multiple JSON values")
	}
	return nil
}

type decisionEvent struct {
	SchemaVersion               string    `json:"schema_version"`
	EventID                     string    `json:"event_id"`
	DecisionID                  string    `json:"decision_id"`
	TransactionID               string    `json:"transaction_id"`
	CorrelationID               string    `json:"correlation_id"`
	PaymentVerdict              string    `json:"payment_verdict"`
	DecisionSource              string    `json:"decision_source"`
	PolicyVersion               string    `json:"policy_version"`
	TriggeredRuleIDs            []string  `json:"triggered_rule_ids"`
	InvestigationRequired       bool      `json:"investigation_required"`
	InvestigationReason         *string   `json:"investigation_reason"`
	SourceEvidenceReferences    []string  `json:"source_evidence_references"`
	EvidenceSHA256              string    `json:"evidence_sha256"`
	TransactionTimestamp        time.Time `json:"transaction_timestamp"`
	IngestedAt                  time.Time `json:"ingested_at"`
	DecidedAt                   time.Time `json:"decided_at"`
	DecisionProcessingLatencyMS float64   `json:"decision_processing_latency_ms"`
	IngestionToDecisionMS       float64   `json:"ingestion_to_decision_ms"`
}
type riskEvent struct {
	SchemaVersion          string          `json:"schema_version"`
	EventID                string          `json:"event_id"`
	TransactionID          string          `json:"transaction_id"`
	ModelVersion           string          `json:"model_version"`
	FeatureSchemaVersion   string          `json:"feature_schema_version"`
	FraudProbability       float64         `json:"fraud_probability"`
	ModelTimestamp         time.Time       `json:"model_timestamp"`
	TransactionTimestamp   time.Time       `json:"transaction_timestamp"`
	ScoringLatencyMS       float64         `json:"scoring_latency_ms"`
	InputFeatureProvenance json.RawMessage `json:"input_feature_provenance"`
	CorrelationID          string          `json:"correlation_id,omitempty"`
	TraceID                string          `json:"trace_id,omitempty"`
}
type requestEvidence struct {
	Signals []string `json:"signals"`
}
type requestEvent struct {
	SchemaVersion            string          `json:"schema_version"`
	EventID                  string          `json:"event_id"`
	InvestigationID          string          `json:"investigation_id"`
	DecisionID               string          `json:"decision_id"`
	TransactionID            string          `json:"transaction_id"`
	CorrelationID            string          `json:"correlation_id"`
	OriginalPaymentVerdict   string          `json:"original_payment_verdict"`
	RoutingReason            string          `json:"routing_reason"`
	FastPathPolicyVersion    string          `json:"fast_path_policy_version"`
	Evidence                 json.RawMessage `json:"evidence"`
	SourceEvidenceReferences []string        `json:"source_evidence_references"`
	RequestedAt              time.Time       `json:"requested_at"`
}
type completedEvent struct {
	SchemaVersion              string            `json:"schema_version"`
	EventID                    string            `json:"event_id"`
	InvestigationID            string            `json:"investigation_id"`
	DecisionID                 string            `json:"decision_id"`
	TransactionID              string            `json:"transaction_id"`
	CorrelationID              string            `json:"correlation_id"`
	OriginalPaymentVerdict     string            `json:"original_payment_verdict"`
	RecommendedAction          string            `json:"recommended_action"`
	InvestigationPolicyVersion string            `json:"investigation_policy_version"`
	TriggeredRuleIDs           []string          `json:"triggered_rule_ids"`
	Reason                     string            `json:"reason"`
	SourceEvidenceReferences   []string          `json:"source_evidence_references"`
	ModelConfiguration         map[string]string `json:"model_configuration"`
	AuditReference             string            `json:"audit_reference"`
	Mode                       string            `json:"mode"`
	CompletedAt                time.Time         `json:"completed_at"`
}
