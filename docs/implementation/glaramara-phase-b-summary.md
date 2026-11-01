# Glaramara Phase B implementation summary

Verified on 1 November 2026. This handoff records implemented behaviour and observed evidence; it does not
authorise Phase B.1, live payments or Phase C Orchestrate work.

## Implemented architecture

Glaramara now submits a simulated payment through `POST /api/v1/payments`. The signed-session customer,
primary open account, owned beneficiary and active allowlisted location are resolved and validated in
PostgreSQL. A canonical request hash, transaction advisory lock and `(customer_id, idempotency_key)` constraint
provide concurrent idempotency: an identical replay returns the original payment and conflicting reuse is
rejected.

The submission transaction reserves monotonic raw-event time, writes one immutable `banking_payment_attempts`
record and creates two existing `outbox_events` records: the canonical raw payment and a delayed event-time
marker. The marker's future event time is independent of its three-second processing-time outbox delay; the
additive `0009_release_banking_watermarks` migration releases pending rows created before that distinction was
enforced. The root 16-payment probe coordinates through the same PostgreSQL advisory lock and clock before it
publishes its later SQL-window marker; either workflow can therefore run next without producing a late UI
payment. The shared Python publisher retains its lease, retry and Kafka-acknowledgement contract. Its claim
query prevents the banking marker from being leased until the raw record is `PUBLISHED`, which makes recovery
safe for the two-second Flink event-time boundary. `payment_id` and `transaction_id` are the same UUID
throughout the pipeline.

The Java Flink enrichment job and Python deterministic router are unchanged. Only
`fast-path-policy/1.0.0` writes the immutable customer verdict. The independent LightGBM scorer, Go correlator
and Go decision engine continue asynchronously with their existing contracts. Their model, feature, revision
and policy provenance is returned separately and cannot change the customer-facing status.

`GET /api/v1/payments/{paymentId}` enforces customer ownership and reports `PENDING`, `APPROVED`, `CHALLENGED`
or `BLOCKED`. `banking_payment_status` derives terminal states only from `payment_decisions`. The responsive UI
polls this API and labels shadow evidence as experimental. No booked transaction, balance mutation or ledger
effect is implemented.

Root Compose builds, starts and health-checks Glaramara on port `13000`. `make glaramara-smoke-test` is a
bounded publishing probe for submission, replay/conflict handling, asynchronous authority/shadow completion
and unchanged balance.

## Verification evidence

The focused and regression checks observed for this implementation were:

- `cd glaramara-bank && npm test && npm run typecheck && npm run build`: 10 contract tests passed; typecheck
  and production build passed;
- mocked Playwright desktop/mobile: 10 passed, with 2 isolated-PostgreSQL cases skipped by default;
- `cd agents && .venv/bin/pytest -q && .venv/bin/ruff check .`: 88 passed, 8 opt-in skips; Ruff passed;
- deployment tests: 22 passed, and `make config` rendered successfully;
- Flink support tests: 15 passed and 6 Kafka integration cases skipped by default; Maven build passed;
- both Go services passed `go test ./...` and `go vet ./...` in the deployment Go toolchain;
- live payment `7b5f7cca-6406-4c9f-9ec1-e960e5fc80df`, submitted immediately after the controlled fixture's
  future window marker, reached deterministic `APPROVED` under
  `fast-path-policy/1.0.0`, LightGBM model `lgbm-baseline-20261028T115824Z-abfd893e`, correlated revision 2,
  and Go shadow `APPROVED` under `fraud-action-policy-v1`; both outbox rows published on their first attempt
  and the fictional balance was unchanged;
- controlled run `07d96a1bfc1a` preserved all 16 stable IDs across enriched, deterministic, ML, correlated and
  shadow topics, the deterministic 11 approved / 2 challenged / 3 blocked distribution, and both SQL rules.
- manual payment `052817e4-389a-4eaa-a380-b566ac40fb78` proved the recovery path: its raw record published once
  at offset 242; its incorrectly future-scheduled marker later published once at offset 243; the same payment
  then reached deterministic `APPROVED`, complete correlation revision 2 and evaluated shadow evidence without
  another submission. Revision `0009` makes equivalent pending markers immediately recoverable.

The database-backed banking schema and browser suites remain opt-in because they require an explicitly
isolated PostgreSQL database. The live checks above used the isolated root `fraud-platform-dev` deployment and
did not reset offsets, recreate volumes, cancel Flink jobs or touch protected golden projects.

## Known limits and deferred work

- Kafka and all outboxes remain at least once; stable identifiers and database uniqueness provide logical
  deduplication. The publisher retries indefinitely and has no terminal operator-controlled failure state.
- A genuinely late raw record remains logged by Java rather than routed to a durable late-event topic.
- The synthetic LightGBM model is uncalibrated and shadow-only. ML-active selection belongs to Phase B.1.
- There is no real payment rail, balance mutation, ledger posting, synchronous authorisation service or
  challenge-resolution workflow.
- Live Claude investigations remain disabled, and root Compose does not start the investigation worker.
- No Orchestrate questionnaire, agent or deployment work was performed; that boundary remains Phase C.
