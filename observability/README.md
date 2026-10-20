# Phoenix observability

Phoenix is an optional local viewer for OpenTelemetry traces emitted by the investigation worker.
It is supplementary: PostgreSQL remains authoritative for payment decisions, investigation attempts,
audit records, evidence provenance, budget reservations, model-call accounting, and the Kafka
inbox/outbox. Losing Phoenix data has no effect on decision or investigation state.

## Start and stop

The service is isolated in its own Compose project, so these commands do not recreate Kafka, Flink,
or PostgreSQL:

```sh
# Check VM headroom first. The VM is 6 GiB and Phoenix is capped at 768 MiB.
podman machine ssh free -m
podman stats --no-stream

podman compose -f observability/compose.yaml config
podman compose -f observability/compose.yaml up -d phoenix
podman inspect fraud-observability-phoenix-1 --format '{{.State.Health.Status}}'
```

Open <http://localhost:6006>. OTLP/HTTP ingestion is available at
`http://127.0.0.1:6006/v1/traces`; OTLP/gRPC is bound to `127.0.0.1:4317`. Both ports are loopback-only.

```sh
# Stop while retaining the container and data.
podman compose -f observability/compose.yaml stop phoenix

# Remove only this optional container/network; the named data volume is retained.
podman compose -f observability/compose.yaml down
```

Do not add `--volumes` to `down` unless deleting all local Phoenix traces is intentional. Phoenix uses
SQLite in the named `fraud-observability_fraud-phoenix-data` volume. No automatic retention policy is
configured for this local demonstration.

The image is explicitly pinned to `arizephoenix/phoenix:version-20.23.0`. The single-container SQLite
deployment is appropriate for a local, single-user demonstration; it is not a production HA topology.

## Application configuration

Tracing is disabled by default and requires no configuration for existing users:

```sh
OTEL_ENABLED=true
OTEL_SERVICE_NAME=fraud-investigation-worker
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:6006/v1/traces
OTEL_EXPORT_TIMEOUT_SECONDS=2
PHOENIX_PROJECT_NAME=fraud-investigations
OTEL_CAPTURE_SYNTHETIC_CONTENT=false
```

Use `http://host.containers.internal:6006/v1/traces` when the worker itself runs in a Podman container,
or the Phoenix Compose service hostname if both services are deliberately placed on one network.
Set `OTEL_ENABLED=false` (or leave it unset) to disable tracing. Export initialization, span mutation,
flush, and export errors are isolated from application processing; telemetry never controls retries.

`OTEL_CAPTURE_SYNTHETIC_CONTENT=true` is a development-only opt-in assertion that the data is
synthetic. Even then, configured secret, credential, and latitude/longitude keys are recursively
redacted. The default exports structured allowlisted metadata only—not prompts, completions, API keys,
authentication headers, database URLs, `.env` values, customer coordinates, or complete payments.
Phoenix has no authentication in this local profile, which is why its ports must remain loopback-only.

## Reading a trace

Select project `fraud-investigations` in Phoenix and filter span attributes by
`fraud.investigation.id` using the UUID stored in PostgreSQL. `fraud.attempt.id`,
`fraud.transaction.id`, `fraud.correlation.id`, and `fraud.decision.id` provide the other durable joins.
Trace and span IDs are also copied into `fraud.trace_id` and `fraud.span_id` for simple inspection.

A worker-driven trace follows the operations that actually ran:

```text
fraud investigation
└── investigation worker
    └── supervisor workflow
        └── supervisor agent
            ├── anthropic.messages <model>       (LLM)
            ├── tool run_geo_investigation       (delegation)
            │   └── geo agent
            │       ├── tool check_geo_distance  (deterministic)
            │       └── anthropic.messages ...   (LLM, live mode)
            ├── tool run_behaviour_investigation
            │   └── behaviour agent
            └── tool run_action_policy
                └── action agent
                    └── tool apply_decision_rules
    └── investigation persisted                  (PostgreSQL + outbox hand-off)
```

Concurrent Geo and Behaviour branches may appear in either order. Model spans carry model name, call
sequence, input/output/total tokens, latency, and estimated USD cost. Tool spans carry tool name,
duration/status where available, and allowlisted evidence provenance. The root carries original
payment verdict, final recommendation, policy version, and the supplementary per-investigation cost.
PostgreSQL model-call ledger values remain authoritative.

The completion event is *durably enqueued* within the persistence span. Actual Kafka publication is a
separate outbox-worker process and is not falsely represented as a child span. Likewise, the current
Kafka request schema is unchanged, so router-to-worker trace context is not propagated; durable IDs
provide cross-boundary correlation without changing event identity or idempotency.

## Zero-cost smoke test

With Phoenix healthy:

```sh
cd agents
.venv/bin/python scripts/smoke_phoenix.py
```

The script replaces the Anthropic SDK client before execution and emits deterministic fake tool-use
responses. It makes nine mocked model calls, makes no provider request, publishes no Kafka message,
and does not access PostgreSQL. `estimated_cost_usd` is what those synthetic token counts would cost,
not expenditure. Prompt/output capture remains off.

The validated example produced trace `a5f416d6b7f4d298a2986ceb5417f0e0` for investigation
`bc45fa1c-8a65-59ca-b0ba-d6d6b25fc761`: 1 chain span, 4 agent spans, 9 LLM spans, and 11 tool/delegation
spans. Every LLM span had token and cost attributes, and no span contained `input.value` or
`output.value`.

## Troubleshooting

- UI unavailable: check `podman inspect fraud-observability-phoenix-1` and
  `podman logs --tail 100 fraud-observability-phoenix-1`.
- No traces from a Mac process: use `127.0.0.1`, ensure `OTEL_ENABLED=true`, and check project
  `PHOENIX_PROJECT_NAME`.
- No traces from a container: use `host.containers.internal`, not `localhost`.
- Slow or unavailable collector: investigations continue; exporter failures are logged and spans may
  be dropped from the bounded in-memory batch queue.
- Unexpected content: disable tracing immediately, keep content capture false, and remove the Phoenix
  data volume only through an explicit reviewed data-destruction operation.

## Observability, evaluation, and governance

Observability records what executed and how long it took. Evaluation measures output quality against
expected scenarios. Governance sets authority, budgets, policy versions, approvals, and durable audit
requirements. Phoenix assists the first and can support later analysis, but it replaces neither the
evaluation suite nor PostgreSQL-backed governance.

OpenTelemetry was chosen because it is vendor-neutral, supports async context propagation and standard
exporters, and keeps the custom Anthropic SDK orchestration intact. OpenInference conventions add
portable LLM/agent/tool meaning without adopting an agent framework or coupling execution to Phoenix.

## Measured local resources

Before Phoenix, the 6 GiB Podman VM reported 5,896 MiB total and 3,256 MiB available. After ingesting
the mocked smoke trace, Phoenix used approximately 452 MiB of its 768 MiB limit. Kafka, Flink, and
PostgreSQL remained running and were not restarted or recreated.
