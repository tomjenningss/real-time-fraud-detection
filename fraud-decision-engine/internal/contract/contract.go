// Package contract owns the correlated-assessment input and shadow-decision output contracts.
package contract

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/tomjennings/real-time-fraud-detection/fraud-decision-engine/internal/policy"
)

const SchemaVersion = "1.0.0"

type Provenance struct {
	EventID       string    `json:"event_id"`
	Topic         string    `json:"topic"`
	Partition     int32     `json:"partition"`
	Offset        int64     `json:"offset"`
	SchemaVersion string    `json:"schema_version"`
	EventTime     time.Time `json:"event_time"`
}

type Deterministic struct {
	Verdict                  string    `json:"verdict"`
	PolicyVersion            string    `json:"policy_version"`
	TriggeredRuleIDs         []string  `json:"triggered_rule_ids"`
	Signals                  []string  `json:"signals,omitempty"`
	InvestigationRequired    bool      `json:"investigation_required"`
	InvestigationReason      *string   `json:"investigation_reason,omitempty"`
	EvidenceSHA256           string    `json:"evidence_sha256"`
	SourceEvidenceReferences []string  `json:"source_evidence_references"`
	DecidedAt                time.Time `json:"decided_at"`
}

type ML struct {
	FraudProbability       float64         `json:"fraud_probability"`
	ModelVersion           string          `json:"model_version"`
	FeatureSchemaVersion   string          `json:"feature_schema_version"`
	ModelTimestamp         time.Time       `json:"model_timestamp"`
	InputFeatureProvenance json.RawMessage `json:"input_feature_provenance"`
}

type Assessment struct {
	SchemaVersion string          `json:"schema_version"`
	AssessmentID  string          `json:"assessment_id"`
	TransactionID string          `json:"transaction_id"`
	Revision      int64           `json:"revision"`
	Deterministic *Deterministic  `json:"deterministic,omitempty"`
	ML            *ML             `json:"ml,omitempty"`
	Investigation json.RawMessage `json:"investigation,omitempty"`
	Provenance    []Provenance    `json:"provenance"`
	Completeness  string          `json:"completeness"`
	CreatedAt     time.Time       `json:"created_at"`
	UpdatedAt     time.Time       `json:"updated_at"`
}

func DecodeAssessment(payload []byte) (Assessment, error) {
	var assessment Assessment
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&assessment); err != nil {
		return Assessment{}, fmt.Errorf("invalid correlated assessment: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return Assessment{}, errors.New("correlated assessment contains multiple JSON values")
	}
	if assessment.SchemaVersion != SchemaVersion {
		return Assessment{}, fmt.Errorf("unsupported assessment schema version %q", assessment.SchemaVersion)
	}
	if assessment.AssessmentID == "" || assessment.TransactionID == "" || assessment.Revision < 1 {
		return Assessment{}, errors.New("assessment identity and positive revision are required")
	}
	return assessment, nil
}

func (a Assessment) PolicyInput() policy.Input {
	var deterministic *policy.DeterministicResult
	if a.Deterministic != nil {
		deterministic = &policy.DeterministicResult{
			Verdict:       a.Deterministic.Verdict,
			PolicyVersion: a.Deterministic.PolicyVersion,
			RuleIDs:       append([]string(nil), a.Deterministic.TriggeredRuleIDs...),
			Signals:       append([]string(nil), a.Deterministic.Signals...),
		}
	}
	var ml *policy.MLResult
	if a.ML != nil {
		ml = &policy.MLResult{
			FraudProbability:     a.ML.FraudProbability,
			ModelVersion:         a.ML.ModelVersion,
			FeatureSchemaVersion: a.ML.FeatureSchemaVersion,
		}
	}
	return policy.Input{Deterministic: deterministic, ML: ml}
}

type InputProvenance struct {
	Assessment                  []Provenance   `json:"assessment"`
	DeterministicPolicyVersion  string         `json:"deterministic_policy_version"`
	DeterministicEvidenceSHA256 string         `json:"deterministic_evidence_sha256"`
	SourceEvidenceReferences    []string       `json:"source_evidence_references"`
	MLFeature                   map[string]any `json:"ml_feature,omitempty"`
}

type ModelOutput struct {
	FraudProbability     float64   `json:"fraud_probability"`
	ModelVersion         string    `json:"model_version"`
	FeatureSchemaVersion string    `json:"feature_schema_version"`
	ModelTimestamp       time.Time `json:"model_timestamp"`
}

type ShadowDecision struct {
	SchemaVersion            string          `json:"schema_version"`
	EventID                  string          `json:"event_id"`
	ShadowEvaluationID       string          `json:"shadow_evaluation_id"`
	TransactionID            string          `json:"transaction_id"`
	SourceAssessmentID       string          `json:"source_assessment_id"`
	SourceAssessmentRevision int64           `json:"source_assessment_revision"`
	PolicyVersion            string          `json:"policy_version"`
	PolicyConfiguration      policy.Config   `json:"policy_configuration"`
	ProposedAction           string          `json:"proposed_action"`
	OriginalPaymentVerdict   string          `json:"original_payment_verdict"`
	DiffersFromOriginal      bool            `json:"differs_from_original"`
	ContributingSignals      []string        `json:"contributing_signals"`
	DeterministicRuleIDs     []string        `json:"deterministic_rule_ids"`
	PolicyReasons            []policy.Reason `json:"policy_reasons"`
	ML                       ModelOutput     `json:"ml"`
	InputProvenance          InputProvenance `json:"input_provenance"`
	InvestigationContext     json.RawMessage `json:"investigation_context,omitempty"`
	EvaluatedAt              time.Time       `json:"evaluated_at"`
	EvaluationLatencyMS      float64         `json:"evaluation_latency_ms"`
	EvaluationStatus         string          `json:"evaluation_status"`
}

func NewShadowDecision(a Assessment, result policy.Result, config policy.Config, evaluatedAt time.Time, latency time.Duration) (ShadowDecision, error) {
	if result.Status != policy.Evaluated || a.Deterministic == nil || a.ML == nil {
		return ShadowDecision{}, errors.New("only complete evaluated results can become shadow decisions")
	}
	id := EvaluationID(a.AssessmentID, a.Revision, config.Version)
	var feature map[string]any
	if len(a.ML.InputFeatureProvenance) > 0 && string(a.ML.InputFeatureProvenance) != "null" {
		if err := json.Unmarshal(a.ML.InputFeatureProvenance, &feature); err != nil {
			return ShadowDecision{}, errors.New("invalid ML feature provenance")
		}
	}
	return ShadowDecision{
		SchemaVersion:            SchemaVersion,
		EventID:                  id,
		ShadowEvaluationID:       id,
		TransactionID:            a.TransactionID,
		SourceAssessmentID:       a.AssessmentID,
		SourceAssessmentRevision: a.Revision,
		PolicyVersion:            config.Version,
		PolicyConfiguration:      config,
		ProposedAction:           result.Action,
		OriginalPaymentVerdict:   a.Deterministic.Verdict,
		DiffersFromOriginal:      result.Action != a.Deterministic.Verdict,
		ContributingSignals:      nonNil(result.ContributingSignals),
		DeterministicRuleIDs:     nonNil(result.RuleIDs),
		PolicyReasons:            result.Reasons,
		ML: ModelOutput{
			FraudProbability: a.ML.FraudProbability, ModelVersion: a.ML.ModelVersion,
			FeatureSchemaVersion: a.ML.FeatureSchemaVersion, ModelTimestamp: a.ML.ModelTimestamp,
		},
		InputProvenance: InputProvenance{
			Assessment: nonNilProvenance(a.Provenance), DeterministicPolicyVersion: a.Deterministic.PolicyVersion,
			DeterministicEvidenceSHA256: a.Deterministic.EvidenceSHA256,
			SourceEvidenceReferences:    nonNil(a.Deterministic.SourceEvidenceReferences), MLFeature: feature,
		},
		InvestigationContext: append(json.RawMessage(nil), a.Investigation...),
		EvaluatedAt:          evaluatedAt, EvaluationLatencyMS: float64(latency.Nanoseconds()) / 1_000_000,
		EvaluationStatus: policy.Evaluated,
	}, nil
}

func EvaluationID(assessmentID string, revision int64, policyVersion string) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%s", assessmentID, revision, policyVersion)))
	return "shadow-evaluation:" + hex.EncodeToString(digest[:])
}

func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func nonNilProvenance(values []Provenance) []Provenance {
	if values == nil {
		return []Provenance{}
	}
	return values
}
