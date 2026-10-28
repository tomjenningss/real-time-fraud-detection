package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/tomjennings/real-time-fraud-detection/fraud-assessment-correlator/internal/assessment"
	"github.com/tomjennings/real-time-fraud-detection/fraud-assessment-correlator/internal/store"
	"github.com/twmb/franz-go/pkg/kgo"
)

var topics = []string{"fraud.decisions.demo", "fraud.risk.baseline.demo", "fraud.investigations.requested", "fraud.investigations.completed"}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	databaseURL := required("DATABASE_URL")
	brokers := strings.Split(env("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092"), ",")
	group := env("CORRELATOR_GROUP_ID", "fraud-assessment-correlator-v1")
	offsetReset := strings.ToLower(env("CORRELATOR_AUTO_OFFSET_RESET", "earliest"))
	var resetOffset kgo.Offset
	switch offsetReset {
	case "earliest":
		resetOffset = kgo.NewOffset().AtStart()
	case "latest":
		resetOffset = kgo.NewOffset().AtEnd()
	default:
		fatal("invalid CORRELATOR_AUTO_OFFSET_RESET", fmt.Errorf("must be earliest or latest, got %q", offsetReset))
	}
	s, err := store.Open(ctx, databaseURL)
	if err != nil {
		fatal("database connection failed", err)
	}
	defer s.Close()
	client, err := kgo.NewClient(kgo.SeedBrokers(brokers...), kgo.ConsumerGroup(group), kgo.ConsumeTopics(topics...),
		kgo.ConsumeResetOffset(resetOffset),
		kgo.DisableAutoCommit(), kgo.FetchMaxWait(time.Second), kgo.RequiredAcks(kgo.AllISRAcks()))
	if err != nil {
		fatal("Kafka client creation failed", err)
	}
	defer client.Close()

	server := healthServer(s, client)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("health server failed", "error", err)
			stop()
		}
	}()
	go publishLoop(ctx, s, client, env("HOSTNAME", "correlator")+"-outbox")
	slog.Info("correlator ready", "topics", topics, "group", group, "auto_offset_reset", offsetReset)

	for ctx.Err() == nil {
		fetches := client.PollFetches(ctx)
		if errs := fetches.Errors(); len(errs) > 0 {
			for _, e := range errs {
				slog.Error("Kafka fetch failed", "topic", e.Topic, "partition", e.Partition, "error", e.Err)
			}
			time.Sleep(time.Second)
			continue
		}
		iter := fetches.RecordIter()
		for !iter.Done() {
			record := iter.Next()
			if ctx.Err() != nil {
				break
			}
			event, decodeErr := assessment.Decode(record.Topic, record.Partition, record.Offset, record.Value)
			if decodeErr != nil {
				if err := s.RecordMalformed(ctx, record.Topic, record.Partition, record.Offset, record.Value, decodeErr.Error()); err != nil {
					fatal("could not persist rejected event", err)
				}
				slog.Warn("event rejected", "topic", record.Topic, "partition", record.Partition, "offset", record.Offset, "error", decodeErr)
			} else if _, err := s.Process(ctx, event); err != nil {
				fatal("event processing failed", fmt.Errorf("event_id=%s: %w", event.EventID, err))
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

func publishLoop(ctx context.Context, s *store.Store, client *kgo.Client, worker string) {
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
			record := &kgo.Record{Topic: message.Topic, Key: []byte(message.Key), Value: message.Payload, Headers: []kgo.RecordHeader{{Key: "event_id", Value: []byte(message.ID)}, {Key: "schema_version", Value: []byte(assessment.SchemaVersion)}}}
			if err := client.ProduceSync(ctx, record).FirstErr(); err != nil {
				s.Release(ctx, message.ID, worker, fmt.Sprintf("%T", err))
				continue
			}
			if err := s.MarkPublished(ctx, message.ID, worker); err != nil {
				slog.Error("outbox acknowledgement failed", "id", message.ID, "error", err)
			}
		}
	}
}

func healthServer(s *store.Store, client *kgo.Client) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK); w.Write([]byte("ok\n")) })
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
		w.Write([]byte("ready\n"))
	})
	return &http.Server{Addr: ":" + env("HTTP_PORT", "8080"), Handler: mux, ReadHeaderTimeout: 3 * time.Second}
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
func sleep(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
