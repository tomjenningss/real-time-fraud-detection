# Glaramara Bank

Mobile-first fictional banking UI for the fraud-platform demonstration. The approved HTML prototype at
`../docs/designs/glaramara-clickable-prototype.html` remains the visual source of truth and is not generated
from this application.

## Phase B, C and D boundary

- The dashboard, activity, cards, beneficiaries and payment-review journeys are implemented.
- `Pay` beside an owned beneficiary opens payment review with that recipient selected; the customer can
  explicitly return to recipient selection with `Change recipient`.
- Fictional customer/account data is selected through the demo customer switcher.
- The server layer supplies those read models from PostgreSQL and a signed demo session.
- Payment review submits a simulated attempt through the PostgreSQL outbox and existing fraud pipeline.
- Customer status comes only from the immutable deterministic Python verdict. LightGBM and Go remain
  separately labelled shadow evidence.
- Submission never creates a booked transaction, ledger effect or balance change.
- A genuine `CHALLENGED` payment can enter a short, versioned adaptive questionnaire with durable refresh
  recovery. Questionnaire `1.1.0` adds a required, 500-character circumstances explanation for a first-time
  beneficiary; conditional follow-ups remain selected from checked-in definitions, never generated freely.
- Saving the final selected answer automatically starts the existing server-side extraction and controlled
  reassessment. The customer sees a saved, refresh-safe review screen while the browser polls the durable
  pending/processing/completed/failed lifecycle; duplicate calls return the same work and stale processing is
  recoverable within the existing invocation budget.
- Fraud Intelligence extracts strict semantic evidence; a separate deterministic policy writes only a
  simulated investigation resolution. It cannot mutate the original verdict, ledger or balance.
- `fraud-prevention-guidance/1.0.0` then selects an approved, versioned message from source-linked findings.
  The exact rendered message, template references and evidence provenance are persisted with the simulated
  reassessment, so refresh and replay never regenerate advice or call Orchestrate.
- Every account, card, transaction and beneficiary is fictional.
- The separate `/fraud-operations` persona analyses only immutable synthetic fraud-lab history. It can
  propose, backtest and review a future control, but cannot change a payment verdict or deploy a rule.

PostgreSQL is authoritative for customer, account, transaction and beneficiary screens. `lib/demo-data.ts`
contains shared view types and a small render-time identity fallback only; once the signed session is ready,
the UI reads `/api/v1/dashboard`, `/api/v1/activity` and `/api/v1/beneficiaries`.

The Phase B API surface is:

- `GET|POST /api/v1/demo/session`
- `GET /api/v1/dashboard`
- `GET /api/v1/activity`
- `GET|POST /api/v1/beneficiaries`
- `POST /api/v1/payments`
- `GET /api/v1/payments/{paymentId}`
- `GET /api/v1/payments/{paymentId}/fraud-intelligence`
- `GET|POST /api/v1/payments/{paymentId}/investigation`
- `POST /api/v1/payments/{paymentId}/investigation/answers`
- `POST /api/v1/payments/{paymentId}/investigation/extract`
- `GET /api/v1/health`
- `GET /api/v1/fraud-operations`
- `POST /api/v1/fraud-operations/analyses`
- `GET /api/v1/fraud-operations/runs/{runId}`
- `POST /api/v1/fraud-operations/candidates/{candidateId}/reviews`

Customer identity always comes from the HMAC-signed, HttpOnly, SameSite session cookie. Session and
beneficiary/payment mutations require an exact same-origin request. Payment submission also requires an
`Idempotency-Key`; account and location identity never come from the browser.

The optional `beneficiary` payment URL parameter is only a selection hint. The server-returned owned
beneficiary list must contain that UUID before the UI skips recipient selection, and the payment API repeats
the composite customer/beneficiary ownership check before accepting the attempt.

One PostgreSQL transaction reserves monotonic raw-event time and inserts the immutable banking attempt plus
raw-payment and delayed-watermark rows into the existing `outbox_events`. The root regression fixture uses the
same advisory lock and event clock, so its later SQL-window marker cannot make a subsequent UI payment late.
The raw payment uses the stable beneficiary UUID as merchant identity and carries a server-derived count of
immutable booked payments for that beneficiary; customer-entered display names are not history inputs.
The marker payload's event time is separate from its processing-time schedule: it becomes publishable three
seconds after insertion even when coordinated event time is farther ahead. Migration
`0009_release_banking_watermarks` releases any pending marker written by the earlier conflated-clock
implementation. The Python publisher retries and recovers leases. It only claims the banking marker after
Kafka acknowledged the raw event, allowing the existing two-second Flink watermark contract to process a
sporadic UI payment without making a later retry late. `banking_payment_status` derives terminal status only
from `payment_decisions`.

### Live Fraud Intelligence system view

The session-scoped `System view` toggle adds a collapsible `Fraud decision breakdown` below the existing
payment status or customer security guidance without changing or replacing the retail journey. The read-only projection endpoint
assembles persisted outbox acknowledgements, router/Flink evidence, LightGBM source events, Go correlation
revisions, shadow evaluations, questionnaire history, extraction metadata and simulated reassessments. It
never publishes, invokes a provider or writes UI state.

Alembic `0013_fraud_intel_view` adds nullable `payment_decisions.enrichment_evidence`. The router writes its
already validated `FlinkEvidence` in the same immutable decision transaction; decision IDs, evidence hashes,
outbox events, duplicate handling and Kafka commit ordering are unchanged. Historical decisions remain null
and the UI labels their Flink stage as downstream-inferred when only the router inbox proves observation.

The breakdown is collapsed by default and groups only transaction-scoped evidence that the projection has
actually observed: Flink signals/features, the authoritative router decision and rules, shadow-only LightGBM
and Go evidence, watsonx Orchestrate findings when that provider was used, and the original/reassessed payment
outcome. A separate collapsed `Architecture flow` sits beside the customer journey on wide screens and stacks
below it on smaller screens, restoring the live persisted dependency diagram and its read-only evidence drawers
without replacing the customer response. Missing components and invented defaults
are not rendered. The customer-facing resolution card quotes an
actual saved explanation when present, follows it with two or three approved protective steps, and always
states clearly when a challenged payment has not been sent. It never displays indicator enums, confidence
scores, rule IDs or an unsupported callback promise. Historical reassessments without a guidance payload are
shown as not observed rather than backfilled.

Guidance templates may personalise bounded wording from validated evidence provenance. For example, a
customer-reported daughter-abroad request can name the daughter, unexpected contact, reported circumstances
and urgency while explicitly stating that identity and circumstances were not independently verified. The
renderer never asks watsonx to decide an outcome, never interpolates arbitrary free text into approved advice,
and falls back to generic safe guidance when provider evidence is missing, invalid or contradictory.

Agent `1.2.1` treats an explicitly described travel emergency, loss of access to a phone or money and an
immediate request for help as customer-reported urgency; it separately retains an explicit friend or other
third-party withdrawal instruction. Neither finding proves the emergency or the caller's identity. Family
guidance prioritises a previously trusted contact method and warns against third-party account instructions.

## Local development

Dependencies are intentionally not vendored into the repository.

```sh
cd ../agents
DATABASE_URL=postgresql://... .venv/bin/alembic upgrade head

cd ../glaramara-bank
npm install
npm run dev
```

Checks:

```sh
npm test
npm run typecheck
npm run build
npm run test:e2e
```

Copy `.env.example` to a local ignored environment file only when connecting the server layer.
Never commit session secrets or database credentials.

`GLARAMARA_PUBLIC_ORIGIN` pins the exact browser origin accepted by mutation routes. Set it to the
externally visible HTTPS origin in hosted environments; the development example uses localhost.

`GLARAMARA_SESSION_SECRET` must contain at least 32 bytes. `DATABASE_SSL=true` enables certificate-verified
TLS for PostgreSQL. `GLARAMARA_COOKIE_SECURE` defaults to true in production; set it false only for explicit
localhost HTTP development. Keep all settings outside Git.

### Fraud Operations

Selecting `Alex Morgan — Fraud Analyst` issues a signed, HttpOnly `FRAUD_ANALYST` session and opens the
dedicated internal shell. Customer sessions receive `403` from every Fraud Operations API; role and reviewer
identity are derived by the server and never accepted from the browser.

`FRAUD_RULE_DISCOVERY_PROVIDER` selects `mock` or `orchestrate`. Live mode reuses the server-only IBM IAM
credentials but has independent agent ID, model and timeout settings. An analysis snapshots the active wave
manifest, sends only discovery-partition aggregates and bounded pseudonymous examples, validates the strict
`fraud-rule-proposal/1.0.0` result, and only then reads the held-out evaluation partition. Approval records
`APPROVED_FOR_IMPLEMENTATION`; it never activates or publishes a control.

An agent proposal that fails this strict validation returns HTTP 422 `FRAUD_LAB_INVALID_PROPOSAL`. It is a
scoped analysis failure, not a banking availability failure; the active dataset and existing dashboard remain
available and unchanged.

Failed discovery runs retain an analyst-only diagnostic record available from the run-detail API. It records
the bounded, credential-redacted completion snapshot, extracted proposal, provider/model and contract
provenance, structural Zod issues, semantic evidence-reference failures and latency. Customer-facing routes
never expose that diagnostic payload. A completion is capped at 64 KiB; oversized completions retain only a
digest and byte count.

The Fraud Scenario Lab above the investigation workflow separates three actions:

1. `Generate new dataset` enqueues exactly 8,000, 10,000 or 20,000 rows for the fixed-purpose Python worker.
2. `Activate completed dataset` requires explicit confirmation and selects evidence only for future runs.
3. `Run new analysis` snapshots that active dataset and then invokes the configured discovery provider.

Generation and activation never invoke Orchestrate. Dataset status is durable, requests are idempotent per
analyst/key, one generation may run per environment, interrupted work fails closed, and every generated
dataset retains its seed, generator version, scenario and digest. Historical runs continue to display their
original immutable snapshots and backtests.

The initial 8,000-row wave is seeded and backfilled as the active dataset by the migration job during
`make up`. The optional historical additive-wave command remains reproducible and idempotent:

```sh
make fraud-lab-next-wave
```

It appends a distinct beneficiary fan-in period without resetting prior waves, snapshots, candidates,
backtests or reviews. The batch evaluator recomputes supported temporal features in chronological order, but
does not emulate Flink watermarks, late-event handling, checkpoints or operational deduplication.

With the running Glaramara service configured with `FRAUD_RULE_DISCOVERY_PROVIDER=orchestrate`, run one
complete live discovery and held-out backtest from the repository root:

```sh
make fraud-lab-live-analysis
```

For a bounded 15-attempt reliability measurement against the already active 20,000-row dataset (no dataset
generation, deployment, approval or activation), run:

```sh
base_url=$(awk -F= '$1 == "GLARAMARA_PUBLIC_ORIGIN" { print substr($0, index($0, "=") + 1); exit }' .env)
python3 deployment/fraud_lab_reliability_evaluation.py --base-url "$base_url" --attempts 15
```

The target fails closed if `.env` is not configured for Orchestrate or if the completed run does not record
the live REST provider. It prints the immutable snapshot, proposal, duplicate reference, and computed metrics.
It does not approve, deploy, or activate the candidate.

`FRAUD_INTELLIGENCE_PROVIDER` selects `mock` or `orchestrate`. The browser never calls the provider directly:
the final questionnaire answer causes the Glaramara backend to run the existing extraction workflow
automatically, and refresh recovery reads the persisted investigation state. Root Compose defaults to `mock` for a
deterministic, credential-free demonstration. `orchestrate` invokes the existing agent directly from the
Next.js backend. It reads only
`WATSONX_ORCHESTRATE_API_KEY` and `WATSONX_ORCHESTRATE_URL` from the server environment, obtains a cached IAM
token and calls the existing agent through its supported non-streaming chat-completions endpoint. Never use
`NEXT_PUBLIC_` names for either credential. Live failures produce `REFER_TO_ANALYST` under policy v1.2 and never fall
back to mock. The standalone Python adapter remains in the Orchestrate source directory for diagnostics, but
Glaramara no longer spawns it.

Questionnaire `1.2.0` separates relationship from database-derived prior-payment history and always collects
an investment origin plus a short reason. Evidence `1.2.0` preserves those customer claims and transaction
context separately. Existing questionnaire snapshots and valid evidence `1.1.0` remain readable; the frozen
`1.1.0` Gemma benchmark is retained unchanged and must not be used as `1.2.0` ground truth.

For a bounded live development journey, keep the Compose Glaramara service in `mock` mode and start a second
localhost-only backend from the repository root after building the app:

```sh
cd glaramara-bank && npm run build
cd .. && sh deployment/run_glaramara_live_orchestrate.sh
```

This process reads the private root deployment values without printing them, connects to PostgreSQL through
its existing loopback port and lets Next.js load the ignored `.env.local` server credentials. It defaults to
native TypeScript REST mode. The browser origin is `http://127.0.0.1:13001`; stopping this host process does
not change the Compose mock configuration.
The opt-in live acceptance sequence first creates a fresh genuine velocity challenge, then passes its payment
ID to the browser test:

```sh
python3 deployment/glaramara_phase_c_challenge.py
cd glaramara-bank
RUN_GLARAMARA_PHASE_C_LIVE=1 GLARAMARA_PHASE_C_PAYMENT_ID=<printed-payment-id> \
PLAYWRIGHT_BASE_URL=http://127.0.0.1:13001 \
  npx playwright test tests/e2e/phase-c-live-orchestrate.spec.ts \
  --project=desktop-chrome --workers=1
```

This publishes fictional payment attempts and performs one live tenant invocation, so it is never part of the
default test suite.

## Isolated PostgreSQL validation

Database-backed tests must target an explicitly approved isolated database at Alembic head, never either
running fraud-platform database:

```sh
cd ../agents
RUN_PART3_POSTGRES_TESTS=1 DATABASE_URL=postgresql://... \
  .venv/bin/pytest -q tests/test_banking_schema_integration.py

cd ../glaramara-bank
RUN_GLARAMARA_POSTGRES_TESTS=1 DATABASE_URL=postgresql://... \
GLARAMARA_SESSION_SECRET=replace-with-at-least-32-bytes \
  npx playwright test tests/e2e/phase-a-postgres.spec.ts --project=desktop-chrome
```

The normal Playwright suite mocks API transport and checks both 1440×1000 desktop and 390×844 mobile
layouts, customer switching, beneficiary persistence, idempotent payment submission, pending status,
adaptive Phase C follow-ups, refresh recovery and WCAG A/AA. Pending authoritative payments keep a
low-frequency poll after the initial fast window so outbox
recovery can update an already-open status page. `PLAYWRIGHT_BASE_URL` can reuse an explicitly managed local
server.

The root deployment provides a bounded live acceptance probe. It publishes one unique simulated payment:

```sh
make glaramara-smoke-test
```

It verifies same-key replay and conflict handling, the authoritative policy/version, Go shadow/model
provenance and an unchanged fictional balance. It is opt-in because it publishes to Kafka and persists the
immutable payment attempt.

## Design system

- Primary forest: `#173F33`
- Secondary green: `#275A47`
- Soft sage: `#D6E9B8`
- Warm off-white: `#F5F7F3`
- Brand: `glaramara.` with the approved mountain artwork

The compact brand mark, account artwork and card artwork are preserved as inline SVG in
`components/mountain-mark.tsx` so their geometry stays faithful to the prototype.
