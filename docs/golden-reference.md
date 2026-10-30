# Mac mini golden reference inventory

This is the read-only inventory captured on 2026-10-30 before the root development deployment was created.
The Git working tree was clean at `c34d698` (`v2-shadow-fraud-platform`), so the earlier uncommitted deployment
attempt described in the task was not present and there was no uncommitted snapshot to preserve.

## Protected runtime resources

| Compose project | Service/container | ID at inventory | Host port |
| --- | --- | --- | --- |
| `confluent-flink` | `confluent-flink-kafka-1` | `e8d4c6b0b20a` | `9092` |
| `confluent-flink` | `confluent-flink-jobmanager-1` | `df0bd2b74109` | `8081` |
| `confluent-flink` | `confluent-flink-taskmanager-1` | `bb354c869b93` | none |
| `confluent-flink` | `confluent-flink-control-center-1` | `4592b34c7ee4` | `9021` |
| `part3` | `part3-postgres-1` | `918c0835a2ea` | `5433` |
| `part3` | `part3-fraud-assessment-correlator-1` | `2cf41299bbf5` | `8082` |
| `part3` | `part3-fraud-decision-engine-1` | `6070b224355e` | `8083` |
| `fraud-observability` | `fraud-observability-phoenix-1` | `67c60d580624` | `4317`, `6006` |

The two required Flink jobs were `RUNNING`:

- `Per-transaction behavioural enrichment` — `0eb1e24ae292bfd36458cb6404bfaf87`
- `Fraud SQL signals analytics` — `6611e546cdbb2de9fdef1547b3a1675d`

Protected networks are `confluent-flink_default`, `part3_default`, and
`fraud-observability_default`. Protected state volumes are `confluent-flink_kafka-data`,
`part3_fraud-postgres-data`, and `fraud-observability_fraud-phoenix-data`. The unlabelled
`fraud-enrichment-m2` Maven cache is also treated as reference-owned and must not be reused or removed.

The golden Kafka broker contained the platform topics and consumer groups, including
`flink-transaction-enrichment-v1`, `flink-fraud-analytics-v1`, `fraud-decision-router-v1`,
`fraud-shadow-baseline-v1`, `fraud-assessment-correlator-v1`, and `fraud-decision-engine-v1`.

## Isolation rule

No root lifecycle command targets the projects above. The new deployment always supplies its own Compose
project (default `fraud-platform-dev`), uses ports `19092`, `55433`, `18081`, `18082`, and `18083`, and lets
Compose create project-prefixed networks and volumes. It uses a separate broker, database, checkpoint volume,
topics, and consumer offsets. Application image layers may be shared by Podman, but no runtime state is.

Never run `podman compose down`, volume removal, offset resets, or Flink cancellation against the protected
project names. The root `make down` and confirmed `make reset` commands derive their target only from the
explicit development project.

## Capacity observed at inventory

The Podman VM exposed 5 CPUs and 6.18 GB RAM. The running protected containers consumed approximately
4.45 GB, so a concurrent second Kafka/Flink stack was not started during the initial audit. Capacity must be
increased or an explicit, approved stop plan must be agreed before full concurrent validation; the golden
deployment itself must not be stopped implicitly.

