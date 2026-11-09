# Glaramara end-to-end load testing

This document describes the checked-in load runner and the actual repository path it measures. The runner is
an engineering experiment for the isolated root Compose deployment. It is not a benchmark harness for a
production or shared service, and it never injects payment events directly into Kafka.

## Verified processing path

The payment mutation is `POST /api/v1/payments`. It requires a signed fictional-customer session, exact
same-origin `Origin`, a visible-ASCII `Idempotency-Key`, an owned beneficiary, a GBP amount and a short
reference. `createPaymentAttempt` resolves the primary account, owned beneficiary, allowlisted demo location
and booked-beneficiary history from trusted PostgreSQL state. One PostgreSQL transaction inserts an immutable
`banking_payment_attempts` row and two shared `outbox_events` rows: the canonical raw payment and a delayed
event-time marker. It creates no booked transaction and has `ledger_effect=NONE`.

The existing Python outbox publisher sends both rows to one-partition `payments.raw.demo`. The marker cannot
be claimed until its raw payment is published. The Java Flink job consumes the topic with two seconds of
bounded out-of-orderness and 15 seconds of idleness. Its first keyed operator retains customer/beneficiary
relationship state for 30 event-time days; its customer-keyed operator retains one-, two- and ten-minute
rolling evidence. The live signals are `HIGH_VELOCITY`, `MERCHANT_HOPPING`,
`NEW_BENEFICIARY_HIGH_VALUE`, and the currently observation-only live
`SLOW_BUILDING_BENEFICIARY_RISK`. The sink writes `payments.enriched.demo` at least once. A separate Flink SQL
job consumes the raw topic and emits overlapping two-minute aggregate context to `fraud.signals.demo`; that
topic is not a router input.

The stable Python router group consumes `payments.enriched.demo`. In one PostgreSQL transaction it records the
inbox position, immutable authoritative `payment_decisions`, an optional investigation audit row and
publication outbox rows. The deterministic fast path alone owns the initial verdict. The API's
`banking_payment_status` projection is `PENDING` until this row exists, so the load runner uses the persisted
decision—not HTTP 202 or Kafka acceptance—as completion.

The opt-in-at-code but enabled root-deployment LightGBM service independently consumes enriched evidence and
publishes `fraud.risk.baseline.demo`. The Go correlator consumes deterministic decisions, LightGBM risk and
legacy investigation lifecycle topics, stores revisioned assessments and publishes
`fraud.assessments.correlated.demo`. The Go decision engine consumes those revisions and records/publishes
experimental actions on `fraud.decisions.shadow.demo`. Neither shadow component can update the authoritative
decision.

All topics are replication-one and one-partition in the local deployment. Relevant stable consumer groups are
the root router, LightGBM scorer, correlator, shadow engine, Java enrichment and Flink SQL groups printed by
`make status`. Kafka is at least once; stable transaction/event IDs plus PostgreSQL constraints are the
logical deduplication boundary.

## Runner and traffic model

[`deployment/glaramara_load_test.py`](../../deployment/glaramara_load_test.py) uses only Python 3.11's standard
library. It requires an explicit loopback base URL and `--environment isolated-local`. Payment counts and
rates are allowlisted to the requested progressive matrix. The 50,000-payment profile additionally requires
`--approve-stress`. A unique run ID becomes the idempotency-key prefix; reusing a run ID already present in
PostgreSQL is rejected.

Before submission, the runner creates clearly named run-scoped beneficiaries through the real beneficiary
API for each fictional customer. This supplies valid owned entities and at least four merchant identities
without changing accounts, balances or booked history. Requests are reproducibly planned from the seed,
scheduled at the target rate, bounded by the configured worker count and retried only with the same
idempotency key. SIGINT or SIGTERM stops new submissions, lets in-flight requests finish and reconciles what
was accepted.

Profiles combine six intent labels:

- ordinary small transfers to previously paid beneficiaries;
- a same-customer/same-beneficiary high-velocity burst;
- one-customer rotation across at least four beneficiaries;
- payments above £5,000 to run-scoped beneficiaries with zero booked payments;
- a reproducible increasing investment amount sequence;
- fixed-amount recurring investments to previously paid beneficiaries where possible.

These labels are generator intent, not forced expected verdicts. Flink state is customer-scoped and retained,
and the application has only three fictional customers, so concurrently generated patterns can affect one
another's rolling features. The API also owns event time and advances it close to wall time. Therefore the
increasing investment sequence cannot represent 30 elapsed event-time days in a short live run and must not
be claimed as a live slow-building-rule test. The isolated replay facility remains separate and is not used by
this end-to-end runner.

## Metrics and reconciliation

The JSON report retains direct measurements for:

- payment submission request totals, status codes, errors, timeouts, retries and latency percentiles;
- target and achieved scheduling rate;
- raw and watermark outbox publication, persisted enrichment evidence, authoritative decision counts and
  submission-to-decision latency;
- verdict counts, pending IDs and accepted IDs absent from the run query;
- LightGBM coverage and scoring latency from correlated source payloads;
- Go shadow coverage, policy latency and authoritative/shadow disagreement;
- periodically sampled Kafka group lag;
- Flink REST job state, vertex busy/idle/backpressure metrics when exposed, watermarks, checkpoint counts and
  exceptions;
- PostgreSQL connections, waiting locks, deadlocks and database counters;
- Podman container CPU, memory and process counts, plus container/job restarts where exposed.

Unavailable metrics stay labelled unavailable. Kafka broker byte-rate metrics are not configured, and
throughput is therefore derived from the run's persisted counts and duration. `pg_stat_statements` is not
enabled, so the runner cannot attribute database time to individual queries. Sampling can miss short spikes.
The report never converts missing observations into zero-valued success claims.

Every accepted run payment is selected by its exact idempotency prefix. The reconciliation joins the immutable
attempt to the raw and marker outboxes, immutable decision, persisted Flink evidence, LightGBM source event and
latest Go shadow evaluation. The report separates HTTP generation failures from accepted-but-pending platform
work. Database uniqueness prevents multiple authoritative rows for one transaction; the report records this
constraint-backed duplicate count and verifies that every attempt remains simulated with no ledger effect.

## Usage

Run `make status` first. Read the configured `GLARAMARA_PUBLIC_ORIGIN` from the ignored root `.env`; the example
below uses the currently common alternate local port. Reports are written to `reports/load-tests/<run-id>.json`
and `.md`.

```sh
python3 deployment/glaramara_load_test.py \
  --environment isolated-local \
  --base-url http://127.0.0.1:13000 \
  --payment-count 100 \
  --target-rate 10 \
  --traffic-profile mixed \
  --seed 20261107 \
  --run-id smoke-20261107-01 \
  --concurrency 8 \
  --request-timeout 10 \
  --retry-limit 2 \
  --drain-timeout 180
```

The next profiles are operator-invoked separately after reviewing the previous report:

```sh
# Baseline
python3 deployment/glaramara_load_test.py --environment isolated-local \
  --base-url http://127.0.0.1:13000 --payment-count 1000 --target-rate 50 \
  --traffic-profile mixed --seed 20261107 --run-id baseline-20261107-01

# Medium
python3 deployment/glaramara_load_test.py --environment isolated-local \
  --base-url http://127.0.0.1:13000 --payment-count 2000 --target-rate 100 \
  --traffic-profile mixed --seed 20261107 --run-id medium-20261107-01

# Large
python3 deployment/glaramara_load_test.py --environment isolated-local \
  --base-url http://127.0.0.1:13000 --payment-count 10000 --target-rate 100 \
  --traffic-profile mixed --seed 20261107 --run-id large-20261107-01

# Optional stress: explicit extra acknowledgement is mandatory
python3 deployment/glaramara_load_test.py --environment isolated-local \
  --base-url http://127.0.0.1:13000 --payment-count 50000 --target-rate 250 \
  --traffic-profile fraud-heavy --seed 20261107 --run-id stress-20261107-01 \
  --approve-stress
```

Do not run the next profile unless the prior run has all accepted payments reconciled, zero unexplained
missing outcomes, drained lag, running Flink jobs, no unhealthy/restarted container and acceptable resource
headroom. A high block/challenge rate is not itself a load-test failure; it is a measured consequence of the
unchanged stateful policy and traffic mix.

## Verified blocker recovery smoke

Run `smoke-20261108-recovery01` repeated the 100-payment, 10 tx/s mixed profile with seed `20261107` after two
narrow fixes. Kafka retained `-Xms256m -Xmx512m`; only its container limit changed from 768 MiB to 1 GiB after
the kernel proved repeated memory-cgroup kills while the 12 GiB Podman VM had more than 7 GiB available. The
Go correlator added strict, optional decoding for the deterministic producer's two baseline comparison fields.
The earlier 100 rejected records and DLQ messages were retained and were not replayed.

The rerun accepted and authoritatively decided 100/100 payments, persisted 100 LightGBM and 100 deterministic
branches, and produced a latest shadow decision for all 100 transactions. It added no rejection, duplicate
evaluation identity, authoritative duplicate or ledger effect. Kafka recorded no cgroup limit event, OOM or
restart; all lag drained and all three Flink jobs remained running with no failed checkpoint, exception or
sampled backpressure. The saved JSON and Markdown reports are
`reports/load-tests/smoke-20261108-recovery01.*`. This clears the original blockers for a separately approved
1,000-payment baseline, but it does not prove the five-times-higher 50 tx/s target; that run still requires
progressive monitoring and a deliberate drain timeout.

## Optional Orchestrate subset

The mode is disabled by default. It selects only genuinely `CHALLENGED` payments from the just-completed run,
starts their real Glaramara security checks, submits the versioned questionnaire through application APIs and
lets the application invoke its configured provider. It is bounded to 10–50 investigations and concurrency
one or two.

Before enabling it, confirm that the isolated target has `FRAUD_INTELLIGENCE_PROVIDER=orchestrate`, check the
tenant's model entitlement, rate/concurrency limits and charging terms, and obtain approval for the expected
calls. The CLI requires `--approve-orchestrate-costs` as an operator acknowledgement. For example:

```sh
python3 deployment/glaramara_orchestrate_load_test.py \
  --environment isolated-local \
  --base-url http://127.0.0.1:13000 \
  --source-run-id smoke-20261107-01 \
  --investigations 10 \
  --concurrency 1 \
  --request-timeout 90 \
  --approve-orchestrate-costs
```

The report measures end-to-end application request latency, retries, terminal reassessment, validated
structured evidence and persisted guidance. It does not call a model endpoint directly. The original
authoritative verdict remains immutable.
