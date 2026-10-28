package metrics

import (
	"fmt"
	"io"
	"sync"
)

type Counters struct {
	mu                sync.Mutex
	assessments       uint64
	evaluated         uint64
	actions           map[string]uint64
	agreements        uint64
	disagreements     uint64
	awaiting          uint64
	invalid           uint64
	duplicates        uint64
	obsolete          uint64
	publishFailures   uint64
	latencyCount      uint64
	latencySumSeconds float64
}

func New() *Counters { return &Counters{actions: make(map[string]uint64)} }

func (c *Counters) Assessment() { c.mu.Lock(); c.assessments++; c.mu.Unlock() }
func (c *Counters) Evaluated(action string, agreement bool, latencyMS float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.evaluated++
	c.actions[action]++
	if agreement {
		c.agreements++
	} else {
		c.disagreements++
	}
	c.latencyCount++
	c.latencySumSeconds += latencyMS / 1000
}
func (c *Counters) Awaiting()       { c.mu.Lock(); c.awaiting++; c.mu.Unlock() }
func (c *Counters) Invalid()        { c.mu.Lock(); c.invalid++; c.mu.Unlock() }
func (c *Counters) Duplicate()      { c.mu.Lock(); c.duplicates++; c.mu.Unlock() }
func (c *Counters) Obsolete()       { c.mu.Lock(); c.obsolete++; c.mu.Unlock() }
func (c *Counters) PublishFailure() { c.mu.Lock(); c.publishFailures++; c.mu.Unlock() }

func (c *Counters) WritePrometheus(w io.Writer) {
	c.mu.Lock()
	defer c.mu.Unlock()
	fmt.Fprintf(w, "fraud_shadow_assessments_total %d\n", c.assessments)
	fmt.Fprintf(w, "fraud_shadow_evaluations_total %d\n", c.evaluated)
	for _, action := range []string{"APPROVED", "BLOCKED", "CHALLENGED"} {
		fmt.Fprintf(w, "fraud_shadow_actions_total{action=%q} %d\n", action, c.actions[action])
	}
	fmt.Fprintf(w, "fraud_shadow_agreement_total{agrees=\"true\"} %d\n", c.agreements)
	fmt.Fprintf(w, "fraud_shadow_agreement_total{agrees=\"false\"} %d\n", c.disagreements)
	fmt.Fprintf(w, "fraud_shadow_awaiting_inputs_total %d\n", c.awaiting)
	fmt.Fprintf(w, "fraud_shadow_invalid_inputs_total %d\n", c.invalid)
	fmt.Fprintf(w, "fraud_shadow_duplicate_assessments_total %d\n", c.duplicates)
	fmt.Fprintf(w, "fraud_shadow_obsolete_assessments_total %d\n", c.obsolete)
	fmt.Fprintf(w, "fraud_shadow_kafka_publish_failures_total %d\n", c.publishFailures)
	fmt.Fprintf(w, "fraud_shadow_policy_latency_seconds_count %d\n", c.latencyCount)
	fmt.Fprintf(w, "fraud_shadow_policy_latency_seconds_sum %.9f\n", c.latencySumSeconds)
}
