# Glaramara Bank

Mobile-first fictional banking UI for the fraud-platform demonstration. The approved HTML prototype at
`../docs/designs/glaramara-clickable-prototype.html` remains the visual source of truth and is not generated
from this application.

## Phase B and C boundary

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
- Fraud Intelligence extracts strict semantic evidence; a separate deterministic policy writes only a
  simulated investigation resolution. It cannot mutate the original verdict, ledger or balance.
- Every account, card, transaction and beneficiary is fictional.

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
- `GET|POST /api/v1/payments/{paymentId}/investigation`
- `POST /api/v1/payments/{paymentId}/investigation/answers`
- `POST /api/v1/payments/{paymentId}/investigation/extract`
- `GET /api/v1/health`

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

`FRAUD_INTELLIGENCE_PROVIDER` selects `mock` or `orchestrate`. Root Compose defaults to `mock` for a
deterministic, credential-free demonstration. `orchestrate` invokes the existing agent directly from the
Next.js backend. It reads only
`WATSONX_ORCHESTRATE_API_KEY` and `WATSONX_ORCHESTRATE_URL` from the server environment, obtains a cached IAM
token and calls the existing agent through its supported non-streaming chat-completions endpoint. Never use
`NEXT_PUBLIC_` names for either credential. Live failures produce `REQUIRES_FURTHER_REVIEW` and never fall
back to mock. The standalone Python adapter remains in the Orchestrate source directory for diagnostics, but
Glaramara no longer spawns it.

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
