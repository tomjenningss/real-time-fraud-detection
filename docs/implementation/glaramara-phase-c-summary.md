# Glaramara Phase C implementation summary

Verified on 2 November 2026. This records implemented behaviour and observed development evidence. All
payments, resolutions and balances remain fictional and simulated.

## Implemented flow

A Glaramara payment must already have immutable deterministic verdict `CHALLENGED` before the signed-session
customer can start a security check. Questionnaire
`glaramara-fraud-questionnaire/1.0.0` begins with payment recognition, beneficiary relationship and purpose.
It adds contact influence for a new beneficiary or velocity context, then selects only bounded follow-ups
required by prior answers. Definitions, selected IDs, answers and append-only events are durable, so refresh
continues at the next unanswered question. The browser never chooses a fraud outcome.

After completion, the server creates `fraud-intelligence-request/1.0.0` from an opaque transaction reference,
payment amount/currency, prior-beneficiary flag, deterministic signal names, required evidence keys and the
versioned question/answer pairs. No account number, customer name, contact detail, credential or unrestricted
database access is supplied. The backend adapter owns the existing authenticated ADK; TechZone does not call
localhost.

The single native agent `fraud_intelligence` (display name Fraud Intelligence) has no tools, collaborators,
memory or knowledge base. It returns strict `fraud-intelligence-evidence/1.0.0` containing recognition,
beneficiary relationship, scam indicators, contradictions, uncertainty, missing evidence, per-claim question
provenance and one optional bounded multiple-choice clarification. Local validation rejects extra fields,
empty indicator sets, mixed `NONE`, invalid clarification structure and missing semantic provenance. One
primary invocation is normal; the database permits at most one clarification and one final invocation.

Policy `customer-evidence-reassessment/1.0.0` is separate from the agent. Complete, recognised, low-risk
evidence can yield simulated `CLEARED`; explicit unrecognised or defined scam evidence can yield `DECLINED`;
missing, uncertain, contradictory, invalid, timed-out or failed evidence yields
`REQUIRES_FURTHER_REVIEW`. The original decision, payment status and balance are never changed.

Alembic `0010_glaramara_phase_c` stores the investigation identity/original verdict, question snapshots,
answers, append-only history, request hash, agent/model/schema/latency, immutable evidence and independent
reassessment. Mutation triggers protect identity, provenance and history. Answer keys and extraction numbers
provide logical idempotency; extraction is claimed transactionally and capped at two attempts.

## Model selection and live validation

Read-only ADK 2.19.1 discovery confirmed the active `glaramara-techzone` Toronto tenant and its actual model
inventory. `groq/openai/gpt-oss-120b` was retained because the final strict run passed all 3 scenarios:

| Scenario | Required evidence | Latency |
|---|---|---:|
| benign known recipient | recognised, known, `NONE` | 5,026 ms |
| safe-account scam | safe account, unexpected contact, pressure, provenance | 6,949 ms |
| unrecognised payment | not recognised and matching provenance | 6,594 ms |

Mean was 6,190 ms, median 6,594 ms and maximum 6,949 ms. A measured
`watsonx/mistralai/mistral-small-3-1-24b-instruct-2503` run failed to produce schema-versioned evidence, so it
was rejected without using latency as a substitute for quality. Only `fraud_intelligence` was imported. The
tenant still lists pre-existing AskOrchestrate, which was not exported for editing, changed or imported.

The completed browser acceptance journey made one further live extraction with
`groq/openai/gpt-oss-120b`. PostgreSQL recorded provider `watsonx-orchestrate`, the configured model, valid
schema `fraud-intelligence-evidence/1.0.0` and measured agent latency 4,545 ms. This was a real tenant
invocation, not the deterministic fixture.

The subsequent REST refactor resolved Toronto service instance
`https://api.ca-tor.watson-orchestrate.cloud.ibm.com/instances/e7d938c9-b921-4195-98d9-082ff54d95c5` and the
existing `fraud_intelligence` ID `f7859afd-0e8d-488e-88c3-64b591330524` through authenticated read-only calls.
IBM IAM and agent lookup both returned 200. No agent was modified.

## End-to-end evidence

Existing genuine HIGH_VELOCITY-path payment `76608ed5-27de-4441-b459-ec2b68f4aa8f` began with immutable
`CHALLENGED` at `fast-path-policy/1.0.0`. Four low-risk contextual answers completed the adaptive questionnaire.
Root Compose deliberately used deterministic extractor `mock-fraud-intelligence/1.0.0`, producing one
schema-valid extraction and simulated `CLEARED` reassessment. PostgreSQL recorded four answers, eight history
events, provider/model/schema/policy provenance and `ledger_effect=NONE`. The payment API still returned
`CHALLENGED`, and the fictional available balance remained £24,862.80 before and after.

A separate fresh five-payment run produced genuine velocity challenge
`1a658cb8-65b2-4444-8ae3-cdabf05148a5` with rule `FP-CHALLENGE-VELOCITY` and authoritative policy
`fast-path-policy/1.0.0`. A localhost-only second Glaramara backend invoked the existing authenticated host ADK
while the Playwright browser completed four adaptive questions. Live evidence recorded `RECOGNISED`, `KNOWN`
and scam indicator `NONE`, with claims linked to `payment_recognition` and `beneficiary_relationship`.
Independent policy `customer-evidence-reassessment/1.0.0` produced simulated `CLEARED` under
`RECOGNISED_WITH_COMPLETE_LOW_RISK_EVIDENCE`. The original and current payment verdict both remained
`CHALLENGED`, `ledger_effect=NONE`, and the balance remained £24,862.80. Four answers, eight append-only events
and two provenance claims were retained.

Native TypeScript REST acceptance used a second fresh velocity challenge
`44439d6c-e864-416d-a833-3ab56d7b05ee`. The browser completed the same four-answer journey through provider
`watsonx-orchestrate-rest`; one non-streaming agent invocation returned valid evidence in 3,952 ms. PostgreSQL
persisted `RECOGNISED`, `KNOWN`, `NONE` and the two supporting question-ID claims. The independent policy
again produced simulated `CLEARED`, while the original verdict remained `CHALLENGED` and ledger effect
remained `NONE`.

The additive migration reached `0010_glaramara_phase_c`. The state-preserving rebuild retained both Flink job
IDs, all required services were healthy and observed consumer lag was zero.

## Verification

- `npm test`: 21 passed, including focused IAM cache, refresh-deduplication and single-401-retry cases;
  `npm run typecheck` and `npm run build` passed.
- Full default Playwright desktop/mobile suite: 12 passed, 4 opt-in PostgreSQL/live cases skipped. The Phase C journey
  covers conditional expansion from four to six questions, refresh recovery, responsive overflow and WCAG
  A/AA scanning.
- Opt-in live Orchestrate browser acceptance: 1 passed in 11.6 seconds using the fresh challenged payment.
- Opt-in native REST browser acceptance: 1 passed in 7.2 seconds using the fresh REST challenged payment.
- `agents`: 90 passed, 8 opt-in skips; Ruff passed. Deployment unit suite: 25 passed.
- ADK agent spec and Python adapter compilation passed; live TechZone evaluation passed 3/3.
- Final `make status` found all required components healthy, both preserved Flink jobs running and all observed
  consumer lags zero. The running Compose service reported explicit extractor mode `mock` and model
  `mock-fraud-intelligence/1.0.0` after the live host acceptance process had stopped.

## Known limits

- Root Compose uses the deterministic fixture and contains no TechZone authentication. The localhost-only
  native REST adapter now has end-to-end browser validation; a non-local hosted deployment must inject the two
  server-only environment values through an appropriate secret manager.
- Orchestrate planner style is deprecated in ADK 2.19.1. It is retained for structured output until an
  equivalent supported style passes the same strict evaluation.
- The extraction HTTP request is synchronous from the Glaramara server, although the claim and durable audit
  are transactional. A production deployment should place the claimed invocation behind a durable worker
  without changing the one-primary-call or conservative-policy contracts.
- This milestone does not transfer money, mutate balances, complete correlation investigations, activate
  LightGBM, add thresholds, retrain models or alter Phase B Kafka/Flink policy.
