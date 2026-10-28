# Architecture evolution

This repository preserves completed implementations as immutable Git snapshots while future work
continues on a separate branch.

## V1 — Claude Multi-Agent Fraud Investigation

The original implementation uses a Supervisor to coordinate Geo, Behaviour and Action agents. Claude
interprets evidence and produces an investigation recommendation, while deterministic tools perform
geographic calculations and enforce the final action policy. The retained evaluation harness and reports
include the matched synthetic Sonnet-versus-Opus comparison and its documented limitations.

The annotated tag `v1-claude-multiagent` identifies the complete historical snapshot. Inspect it without
moving the current branch with `git show v1-claude-multiagent`, or check it out in a separate worktree:

```sh
git worktree add ../fraud-detection-v1 v1-claude-multiagent
```

## V2 — Streaming Fraud Prevention Platform

V2 is the validated platform baseline. It combines Kafka and Flink processing, immutable deterministic
payment decisions, an optional non-authoritative LightGBM shadow scorer, the existing Claude
investigations, the Go Fraud Assessment Correlator, and the Go shadow Fraud Decision Engine. Shadow ML
and Claude outputs cannot revise the original payment verdict.

The annotated tag `v2-shadow-fraud-platform` identifies this baseline. It can be inspected or opened in
a separate worktree using the same commands with that tag name.

## V3 — Banking Fraud Platform (planned)

Development planned on `feat/banking-fraud-platform` includes two Claude-based capabilities: Customer
Fraud Prevention and Fraud Intelligence. The roadmap also includes synchronous payment decisioning, a
mock banking application, and human-approved fraud-rule discovery and deployment. These V3 capabilities
are plans, not implemented or validated features in the tagged V2 baseline.
