# Glaramara Phase A implementation summary

Completed on 1 November 2026. Phase A establishes persistent fictional banking data and a responsive
banking experience while stopping before payment submission. It does not publish Kafka records, invoke
fraud logic, change a balance or deploy an Orchestrate agent.

## Banking application

`glaramara-bank/` is a Next.js App Router application using TypeScript, Tailwind CSS and local
shadcn-style primitives. It preserves the approved forest/sage/off-white palette, `glaramara.` wordmark,
mountain SVG, desktop rail, mobile tabs, cards and multi-step payment review.

Implemented screens:

- overview with PostgreSQL-backed balance, spending and recent activity;
- full activity search;
- debit-card display;
- persistent beneficiary list and fictional-recipient creation;
- payment recipient, amount and review steps;
- a safe Phase A stop and status placeholder that never invent a verdict.

The desktop and mobile customer switchers use an eight-hour HMAC-SHA256 signed demo session. The cookie
is HttpOnly and SameSite=Lax (Secure in production). Mutation routes require the exact configured or
request-derived origin, and customer identity always comes from the signed session.

Phase A routes are `GET|POST /api/v1/demo/session`, `GET /api/v1/dashboard`, `GET /api/v1/activity` and
`GET|POST /api/v1/beneficiaries`. There is deliberately no payment mutation route.

## PostgreSQL migration

Alembic revision `0006_glaramara_banking` adds:

- `banking_customers`;
- `banking_accounts`;
- `banking_beneficiaries`;
- `banking_demo_locations`;
- `banking_transactions`;
- `banking_payment_attempts`.

It deterministically seeds Alex Morgan, Priya Shah and Daniel Evans. Alex retains the approved £24,862.80
balance, sort code/account suffix, Sam and Chloe beneficiaries and transaction history. Seed statements
are replay-safe. Composite foreign keys prevent cross-customer account, beneficiary and location use.

Booked transactions and payment attempts are immutable. Demo balances cannot be changed. Payment attempts
are constrained to `ledger_effect='NONE'` and `is_simulated=true`, but Phase A does not create them.

## Verification

- Existing Phase 0 platform baseline: Python agents 78 passed/2 skipped, Flink support 15 passed/6 skipped,
  deployment 22 passed, Go tests/vet passed, Maven build passed, and controlled 16-payment evidence remained
  11 approved/2 challenged/3 blocked.
- Post-change agents suite: 81 passed/5 skipped; Ruff passed.
- Banking schema against a disposable PostgreSQL 17 instance: migration chain to head passed; 3 integration
  tests passed for replay-safe seeds, immutable records and balance protection.
- Glaramara source/API contracts: 9 passed; TypeScript passed; optimized production build passed.
- Playwright at 1440×1000 and 390×844: 10 passed and 2 explicitly skipped opt-in database cases. The suite
  covers responsive navigation, customer switching, beneficiary persistence, the £10,000 pre-submission
  boundary and WCAG A/AA checks.
- Opt-in real PostgreSQL browser/API test: 1 passed, covering signed cookies, seeded reads, origin rejection,
  beneficiary persistence and the absent payment route.
- `npm audit`: zero known vulnerabilities after pinning current patched dependencies.

The disposable PostgreSQL container and its test-only data were removed after verification. Both existing
platform stacks, Kafka offsets, Flink state and persistent volumes were untouched.

## Issues and boundaries before Phase B

- The existing `agents/.venv` is Python 3.14.3 although the repository target is Python 3.11. The suite is
  green, but CI should also retain a pinned 3.11 run.
- Next's Turbopack production builder attempts an internal port bind that the managed execution sandbox
  forbids. The checked-in build command uses the supported webpack builder and passes.
- Headless Chrome emits harmless macOS display-link warnings.
- Payment submission, outbox publication, Flink watermark work, contextual routing, LightGBM correlation
  and Go shadow status are all reserved for Phase B. No working fraud-platform component was rewritten.
- No TechZone or Orchestrate command was run. AskOrchestrate was left untouched, and agent deployment remains
  blocked until Phase C.

The approved prototype remains byte-for-byte unchanged at 41,947 bytes with SHA-256
`b4d80db36500936eb4a4d7cc1597881b52815af8551d8d6fb7955258e9d45374`.
