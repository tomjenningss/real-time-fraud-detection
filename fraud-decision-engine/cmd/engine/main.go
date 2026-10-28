package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/tomjennings/real-time-fraud-detection/fraud-decision-engine/internal/contract"
	"github.com/tomjennings/real-time-fraud-detection/fraud-decision-engine/internal/metrics"
	"github.com/tomjennings/real-time-fraud-detection/fraud-decision-engine/internal/ordering"
	"github.com/tomjennings/real-time-fraud-detection/fraud-decision-engine/internal/policy"
	"github.com/tomjennings/real-time-fraud-detection/fraud-decision-engine/internal/store"
	"github.com/twmb/franz-go/pkg/kgo"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	config := loadPolicyConfig()
	if err := config.Validate(); err != nil {
		fatal("invalid action-selection policy configuration", err)
	}
	databaseURL := required("DATABASE_URL")
	brokers := strings.Split(env("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092"), ",")
	inputTopic := env("SHADOW_DECISION_INPUT_TOPIC", "fraud.assessments.correlated.demo")
	group := env("SHADOW_DECISION_GROUP_ID", "fraud-decision-engine-v1")
	offsetReset := strings.ToLower(env("SHADOW_DECISION_AUTO_OFFSET_RESET", "earliest"))
	resetOffset := kgo.NewOffset().AtStart()
	if offsetReset == "latest" {
		resetOffset = kgo.NewOffset().AtEnd()
	} else if offsetReset != "earliest" {
		fatal("invalid SHADOW_DECISION_AUTO_OFFSET_RESET", fmt.Errorf("must be earliest or latest, got %q", offsetReset))
	}
	s, err := store.Open(ctx, databaseURL)
	if err != nil {
		fatal("database connection failed", err)
	}
	defer s.Close()
	client, err := kgo.NewClient(kgo.SeedBrokers(brokers...), kgo.ConsumerGroup(group),
		kgo.ConsumeTopics(inputTopic), kgo.ConsumeResetOffset(resetOffset), kgo.DisableAutoCommit(),
		kgo.FetchMaxWait(time.Second), kgo.RequiredAcks(kgo.AllISRAcks()))
	if err != nil {
		fatal("Kafka client creation failed", err)
	}
	defer client.Close()
	counters := metrics.New()
	server := healthServer(s, client, counters, config.Version)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("HTTP server failed", "error", err)
			stop()
		}
	}()
	go publishLoop(ctx, s, client, counters, env("HOSTNAME", "fraud-decision-engine")+"-outbox")
	slog.Info("shadow decision engine ready", "input_topic", inputTopic, "output_topic", "fraud.decisions.shadow.demo",
		"group", group, "auto_offset_reset", offsetReset, "policy_version", config.Version,
		"challenge_threshold", config.ChallengeThreshold, "block_threshold", config.BlockThreshold)

	for ctx.Err() == nil {
		fetches := client.PollFetches(ctx)
		if errs := fetches.Errors(); len(errs) > 0 {
			for _, fetchErr := range errs {
				slog.Error("Kafka fetch failed", "topic", fetchErr.Topic, "partition", fetchErr.Partition, "error", fetchErr.Err)
			}
			sleep(ctx, time.Second)
			continue
		}
		iterator := fetches.RecordIter()
		for !iterator.Done() {
			record := iterator.Next()
			if ctx.Err() != nil {
				break
			}
			counters.Assessment()
			position := store.SourcePosition{Topic: record.Topic, Partition: record.Partition, Offset: record.Offset}
			assessment, decodeErr := contract.DecodeAssessment(record.Value)
			if decodeErr != nil {
				if err := s.RecordMalformed(ctx, position, record.Value, config.Version, decodeErr.Error()); err != nil {
					fatal("could not persist rejected assessment", err)
				}
				counters.Invalid()
				slog.Warn("assessment rejected", "partition", record.Partition, "offset", record.Offset, "error", decodeErr)
			} else {
				started := time.Now()
				result := policy.Evaluate(assessment.PolicyInput(), config)
				latency := time.Since(started)
				var decision *contract.ShadowDecision
				if result.Status == policy.Evaluated {
					value, buildErr := contract.NewShadowDecision(assessment, result, config, time.Now().UTC(), latency)
					if buildErr != nil {
						if err := s.RecordMalformed(ctx, position, record.Value, config.Version, buildErr.Error()); err != nil {
							fatal("could not persist invalid evaluated assessment", err)
						}
						counters.Invalid()
						slog.Warn("assessment provenance rejected", "assessment_id", assessment.AssessmentID, "error", buildErr)
						if err := client.CommitRecords(ctx, record); err != nil {
							fatal("offset commit failed", err)
						}
						continue
					}
					decision = &value
				}
				outcome, processErr := s.Process(ctx, store.Evaluation{Assessment: assessment, Raw: record.Value,
					Position: position, Result: result, Decision: decision}, config)
				if processErr != nil {
					fatal("assessment processing failed", fmt.Errorf("assessment_id=%s revision=%d: %w", assessment.AssessmentID, assessment.Revision, processErr))
				}
				recordOutcome(counters, outcome)
				slog.Info("assessment processed", "assessment_id", assessment.AssessmentID, "revision", assessment.Revision,
					"classification", outcome.Classification, "status", outcome.Status, "proposed_action", outcome.Action,
					"policy_version", config.Version)
			}
			if err := client.CommitRecords(ctx, record); err != nil {
				fatal("offset commit failed", err)
			}
		}
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
}

func recordOutcome(counters *metrics.Counters, outcome store.ProcessOutcome) {
	switch outcome.Classification {
	case ordering.Duplicate:
		counters.Duplicate()
		return
	case ordering.Obsolete:
		counters.Obsolete()
		return
	}
	switch outcome.Status {
	case policy.Evaluated:
		counters.Evaluated(outcome.Action, outcome.Agreement, outcome.LatencyMS)
	case policy.AwaitingInputs:
		counters.Awaiting()
	case policy.InvalidInputs:
		counters.Invalid()
	}
}

func publishLoop(ctx context.Context, s *store.Store, client *kgo.Client, counters *metrics.Counters, worker string) {
	for ctx.Err() == nil {
		messages, err := s.ClaimOutbox(ctx, worker, 50)
		if err != nil {
			slog.Error("outbox claim failed", "error", err)
			sleep(ctx, time.Second)
			continue
		}
		if len(messages) == 0 {
			sleep(ctx, 500*time.Millisecond)
			continue
		}
		for _, message := range messages {
			record := &kgo.Record{Topic: message.Topic, Key: []byte(message.Key), Value: message.Payload,
				Headers: []kgo.RecordHeader{{Key: "event_id", Value: []byte(message.ID)}, {Key: "schema_version", Value: []byte(contract.SchemaVersion)}}}
			if err := client.ProduceSync(ctx, record).FirstErr(); err != nil {
				counters.PublishFailure()
				_ = s.Release(ctx, message.ID, worker, fmt.Sprintf("%T", err))
				slog.Error("shadow decision publish failed", "outbox_id", message.ID, "error", err)
				continue
			}
			if err := s.MarkPublished(ctx, message.ID, worker); err != nil {
				slog.Error("outbox acknowledgement failed", "outbox_id", message.ID, "error", err)
			}
		}
	}
}

func healthServer(s *store.Store, client *kgo.Client, counters *metrics.Counters, policyVersion string) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := s.Ready(ctx); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		if err := client.Ping(ctx); err != nil {
			http.Error(w, "Kafka unavailable", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ready\n"))
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		counters.WritePrometheus(w)
	})
	mux.HandleFunc("/evaluation-report", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		body, err := s.EvaluationSummary(ctx, policyVersion)
		if err != nil {
			http.Error(w, "report unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	})
	return &http.Server{Addr: ":" + env("HTTP_PORT", "8080"), Handler: mux, ReadHeaderTimeout: 3 * time.Second}
}

func loadPolicyConfig() policy.Config {
	return policy.Config{
		Version:                       env("ACTION_POLICY_VERSION", "fraud-action-policy-v1"),
		ChallengeThreshold:            floatEnv("ACTION_CHALLENGE_THRESHOLD", 0.24),
		BlockThreshold:                floatEnv("ACTION_BLOCK_THRESHOLD", 0.70),
		SupportedModelVersionPrefix:   env("ACTION_SUPPORTED_MODEL_VERSION_PREFIX", "lgbm-baseline-"),
		SupportedFeatureSchemaVersion: env("ACTION_SUPPORTED_FEATURE_SCHEMA_VERSION", "fraud-features-1.0.0"),
	}
}

func floatEnv(name string, fallback float64) float64 {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		fatal("invalid numeric environment variable", fmt.Errorf("%s: %w", name, err))
	}
	return parsed
}
func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
func required(name string) string {
	value := os.Getenv(name)
	if value == "" {
		slog.Error("required environment variable missing", "name", name)
		os.Exit(2)
	}
	return value
}
func fatal(message string, err error) { slog.Error(message, "error", err); os.Exit(1) }
func sleep(ctx context.Context, duration time.Duration) {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
