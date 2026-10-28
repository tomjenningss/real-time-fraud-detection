package policy

import (
	"math"
	"testing"
)

var testConfig = Config{
	Version:                       "fraud-action-policy-v1",
	ChallengeThreshold:            0.24,
	BlockThreshold:                0.70,
	SupportedModelVersionPrefix:   "lgbm-baseline-",
	SupportedFeatureSchemaVersion: "fraud-features-1.0.0",
}

func input(verdict string, probability float64) Input {
	return Input{
		Deterministic: &DeterministicResult{Verdict: verdict, PolicyVersion: "fast-path-policy/1.0.0", RuleIDs: []string{"rule"}},
		ML:            &MLResult{FraudProbability: probability, ModelVersion: "lgbm-baseline-test", FeatureSchemaVersion: "fraud-features-1.0.0"},
	}
}

func TestDecisionMatrix(t *testing.T) {
	tests := []struct {
		name, verdict string
		probability   float64
		want          string
		reason        string
	}{
		{"approved low", Approved, 0.10, Approved, "DETERMINISTIC_APPROVAL_AND_ML_LOW_RISK"},
		{"approved high", Approved, 0.80, Challenged, "ML_EXPERIMENTAL_RISK_CHALLENGE"},
		{"challenged low", Challenged, 0.10, Challenged, "ORIGINAL_CHALLENGE_PRESERVED"},
		{"challenged high", Challenged, 0.80, Blocked, "DETERMINISTIC_CHALLENGE_AND_ML_HIGH_RISK"},
		{"blocked low", Blocked, 0.01, Blocked, "ORIGINAL_HARD_BLOCK_PRESERVED"},
		{"blocked high", Blocked, 0.99, Blocked, "ORIGINAL_HARD_BLOCK_PRESERVED"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := Evaluate(input(tt.verdict, tt.probability), testConfig)
			if result.Status != Evaluated || result.Action != tt.want || result.Reasons[0].Code != tt.reason {
				t.Fatalf("got status=%s action=%s reasons=%v", result.Status, result.Action, result.Reasons)
			}
		})
	}
}

func TestMissingInputsNeverApprove(t *testing.T) {
	tests := []Input{{}, {Deterministic: input(Approved, 0.1).Deterministic}, {ML: input(Approved, 0.1).ML}}
	for _, tt := range tests {
		result := Evaluate(tt, testConfig)
		if result.Status != AwaitingInputs || result.Action != "" {
			t.Fatalf("missing input returned %#v", result)
		}
	}
}

func TestInvalidAndUnsupportedMLNeverApprove(t *testing.T) {
	tests := []struct {
		name string
		edit func(*Input)
	}{
		{"negative", func(i *Input) { i.ML.FraudProbability = -0.1 }},
		{"above one", func(i *Input) { i.ML.FraudProbability = 1.1 }},
		{"nan", func(i *Input) { i.ML.FraudProbability = math.NaN() }},
		{"infinite", func(i *Input) { i.ML.FraudProbability = math.Inf(1) }},
		{"model", func(i *Input) { i.ML.ModelVersion = "unknown" }},
		{"schema", func(i *Input) { i.ML.FeatureSchemaVersion = "fraud-features-2.0.0" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			value := input(Approved, 0.1)
			tt.edit(&value)
			result := Evaluate(value, testConfig)
			if result.Status != InvalidInputs || result.Action != "" {
				t.Fatalf("invalid input returned %#v", result)
			}
		})
	}
}

func TestPolicyVersionIsConfigurationNotInputMutation(t *testing.T) {
	first := Evaluate(input(Approved, 0.3), testConfig)
	changed := testConfig
	changed.Version = "fraud-action-policy-v2"
	second := Evaluate(input(Approved, 0.3), changed)
	if first.Action != second.Action || first.Status != second.Status {
		t.Fatalf("version label unexpectedly changed the configured decision: %#v %#v", first, second)
	}
}

func TestReasonsAndInputsAreNotMutated(t *testing.T) {
	value := input(Blocked, 0.1)
	value.Deterministic.Signals = []string{"MERCHANT_HOPPING", "HIGH_VELOCITY", "HIGH_VELOCITY"}
	originalVerdict := value.Deterministic.Verdict
	result := Evaluate(value, testConfig)
	if value.Deterministic.Verdict != originalVerdict || result.Reasons[0].Code != "ORIGINAL_HARD_BLOCK_PRESERVED" {
		t.Fatal("evaluation mutated the detector result or omitted its reason")
	}
	if len(result.ContributingSignals) != 2 || result.ContributingSignals[0] != "HIGH_VELOCITY" {
		t.Fatalf("unexpected signal provenance: %v", result.ContributingSignals)
	}
}
