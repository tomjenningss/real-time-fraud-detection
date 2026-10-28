// Package policy implements the transport-independent Action Selection Control.
package policy

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
)

const (
	Approved   = "APPROVED"
	Blocked    = "BLOCKED"
	Challenged = "CHALLENGED"

	Evaluated      = "EVALUATED"
	AwaitingInputs = "AWAITING_INPUTS"
	InvalidInputs  = "INVALID_INPUTS"
)

type Config struct {
	Version                       string  `json:"version"`
	ChallengeThreshold            float64 `json:"challenge_threshold"`
	BlockThreshold                float64 `json:"block_threshold"`
	SupportedModelVersionPrefix   string  `json:"supported_model_version_prefix"`
	SupportedFeatureSchemaVersion string  `json:"supported_feature_schema_version"`
}

func (c Config) Validate() error {
	if c.Version == "" || c.SupportedModelVersionPrefix == "" || c.SupportedFeatureSchemaVersion == "" {
		return errors.New("policy version and supported model contracts are required")
	}
	if math.IsNaN(c.ChallengeThreshold) || math.IsInf(c.ChallengeThreshold, 0) ||
		math.IsNaN(c.BlockThreshold) || math.IsInf(c.BlockThreshold, 0) ||
		c.ChallengeThreshold < 0 || c.BlockThreshold > 1 || c.ChallengeThreshold >= c.BlockThreshold {
		return errors.New("thresholds must satisfy 0 <= challenge < block <= 1")
	}
	return nil
}

type DeterministicResult struct {
	Verdict       string
	PolicyVersion string
	RuleIDs       []string
	Signals       []string
}

type MLResult struct {
	FraudProbability     float64
	ModelVersion         string
	FeatureSchemaVersion string
}

type Input struct {
	Deterministic *DeterministicResult
	ML            *MLResult
}

type Reason struct {
	Code   string `json:"code"`
	Detail string `json:"detail"`
}

type Result struct {
	Status              string
	Action              string
	Reasons             []Reason
	ContributingSignals []string
	RuleIDs             []string
}

// Evaluate is deterministic for one input and policy configuration. It does not
// call Kafka, PostgreSQL, HTTP, ML inference, or Claude.
func Evaluate(input Input, config Config) Result {
	if input.Deterministic == nil && input.ML == nil {
		return incomplete("deterministic decision and LightGBM prediction are missing")
	}
	if input.Deterministic == nil {
		return incomplete("deterministic decision is missing")
	}
	if input.ML == nil {
		return incomplete("LightGBM prediction is missing")
	}
	if err := config.Validate(); err != nil {
		return invalid("POLICY_CONFIGURATION_INVALID", err.Error())
	}
	deterministic, ml := input.Deterministic, input.ML
	if !validAction(deterministic.Verdict) {
		return invalid("DETERMINISTIC_VERDICT_INVALID", "original deterministic verdict is unsupported")
	}
	if deterministic.PolicyVersion == "" {
		return invalid("DETERMINISTIC_POLICY_VERSION_MISSING", "deterministic policy version is required")
	}
	if math.IsNaN(ml.FraudProbability) || math.IsInf(ml.FraudProbability, 0) ||
		ml.FraudProbability < 0 || ml.FraudProbability > 1 {
		return invalid("ML_PROBABILITY_INVALID", "LightGBM probability must be finite and within [0,1]")
	}
	if !strings.HasPrefix(ml.ModelVersion, config.SupportedModelVersionPrefix) {
		return invalid("ML_MODEL_VERSION_UNSUPPORTED", "LightGBM model version is not supported by this policy")
	}
	if ml.FeatureSchemaVersion != config.SupportedFeatureSchemaVersion {
		return invalid("ML_FEATURE_SCHEMA_UNSUPPORTED", "LightGBM feature schema is not supported by this policy")
	}

	result := Result{
		Status:              Evaluated,
		ContributingSignals: uniqueSorted(deterministic.Signals),
		RuleIDs:             uniqueSorted(deterministic.RuleIDs),
	}
	switch deterministic.Verdict {
	case Blocked:
		result.Action = Blocked
		result.Reasons = []Reason{{
			Code:   "ORIGINAL_HARD_BLOCK_PRESERVED",
			Detail: "The immutable deterministic hard block takes precedence over ML and Claude context.",
		}}
	case Challenged:
		if ml.FraudProbability >= config.BlockThreshold {
			result.Action = Blocked
			result.Reasons = []Reason{{
				Code:   "DETERMINISTIC_CHALLENGE_AND_ML_HIGH_RISK",
				Detail: fmt.Sprintf("Existing deterministic challenge plus ML probability at or above experimental block threshold %.4f.", config.BlockThreshold),
			}}
		} else {
			result.Action = Challenged
			result.Reasons = []Reason{{
				Code:   "ORIGINAL_CHALLENGE_PRESERVED",
				Detail: "ML evidence is not sufficient to relax the existing deterministic challenge.",
			}}
		}
	case Approved:
		if ml.FraudProbability >= config.ChallengeThreshold {
			result.Action = Challenged
			result.Reasons = []Reason{{
				Code:   "ML_EXPERIMENTAL_RISK_CHALLENGE",
				Detail: fmt.Sprintf("ML probability is at or above experimental challenge threshold %.4f; ML alone cannot hard block.", config.ChallengeThreshold),
			}}
		} else {
			result.Action = Approved
			result.Reasons = []Reason{{
				Code:   "DETERMINISTIC_APPROVAL_AND_ML_LOW_RISK",
				Detail: fmt.Sprintf("Deterministic approval retained because ML probability is below experimental challenge threshold %.4f.", config.ChallengeThreshold),
			}}
		}
	}
	return result
}

func incomplete(detail string) Result {
	return Result{Status: AwaitingInputs, Reasons: []Reason{{Code: "REQUIRED_INPUT_MISSING", Detail: detail}}}
}

func invalid(code, detail string) Result {
	return Result{Status: InvalidInputs, Reasons: []Reason{{Code: code, Detail: detail}}}
}

func validAction(value string) bool {
	return value == Approved || value == Challenged || value == Blocked
}

func uniqueSorted(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
