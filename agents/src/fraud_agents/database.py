from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .events import (
    InvestigationCompletedEvent,
    InvestigationRequestEvent,
    KafkaPosition,
    PaymentDecisionEvent,
)
from .schemas import HistoricalEvidence, InvestigationInput, TransactionContext


class IdentityConflict(RuntimeError):
    """A globally unique transaction ID was reused with different canonical evidence."""


@dataclass(frozen=True)
class OutboxMessage:
    event_id: UUID
    topic: str
    key: str
    payload: dict[str, Any]


class FraudStore:
    def __init__(self, database_url: str):
        self.database_url = database_url

    @contextmanager
    def connection(self) -> Iterator[psycopg.Connection]:
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            yield connection

    def record_router_result(
        self,
        *,
        position: KafkaPosition,
        payload_sha256: str,
        decision: PaymentDecisionEvent,
        request: InvestigationRequestEvent | None,
    ) -> bool:
        """Atomically record inbox, immutable decision and all downstream outbox messages."""
        logical_id = decision.decision_id
        with self.connection() as connection, connection.transaction():
            existing = connection.execute(
                "SELECT evidence_sha256 FROM payment_decisions WHERE transaction_id=%s FOR UPDATE",
                (decision.transaction_id,),
            ).fetchone()
            if existing:
                if existing["evidence_sha256"] != decision.evidence_sha256:
                    raise IdentityConflict("transaction_id was reused with different evidence")
                self._record_inbox(connection, "decision-router", logical_id, position, payload_sha256)
                return False
            self._record_inbox(connection, "decision-router", logical_id, position, payload_sha256)
            connection.execute(
                """INSERT INTO payment_decisions
                   (decision_id, transaction_id, correlation_id, payment_verdict, decision_source,
                    policy_version, investigation_required, investigation_reason, evidence_sha256,
                    decision_payload, decided_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    decision.decision_id,
                    decision.transaction_id,
                    decision.correlation_id,
                    decision.payment_verdict.value,
                    decision.decision_source,
                    decision.policy_version,
                    decision.investigation_required,
                    decision.investigation_reason,
                    decision.evidence_sha256,
                    Jsonb(decision.model_dump(mode="json")),
                    decision.decided_at,
                ),
            )
            self._insert_outbox(
                connection,
                decision.event_id,
                "payment_decision",
                decision.decision_id,
                "fraud.decisions.demo",
                decision.transaction_id,
                decision.model_dump(mode="json"),
            )
            if request:
                connection.execute(
                    """INSERT INTO investigations
                       (investigation_id, decision_id, transaction_id, correlation_id,
                        original_payment_verdict, request_payload, requested_at)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                    (
                        request.investigation_id,
                        request.decision_id,
                        request.transaction_id,
                        request.correlation_id,
                        request.original_payment_verdict.value,
                        Jsonb(request.model_dump(mode="json")),
                        request.requested_at,
                    ),
                )
                self._insert_outbox(
                    connection,
                    request.event_id,
                    "investigation",
                    request.investigation_id,
                    "fraud.investigations.requested",
                    request.transaction_id,
                    request.model_dump(mode="json"),
                )
        return True

    def record_dlq(
        self,
        *,
        consumer_name: str,
        logical_event_id: UUID,
        position: KafkaPosition,
        payload_sha256: str,
        event_id: UUID,
        topic: str,
        key: str,
        payload: dict[str, Any],
    ) -> None:
        with self.connection() as connection, connection.transaction():
            self._record_inbox(connection, consumer_name, logical_event_id, position, payload_sha256)
            self._insert_outbox(connection, event_id, "dlq", logical_event_id, topic, key, payload)

    @staticmethod
    def _record_inbox(
        connection, consumer: str, logical_id: UUID, position: KafkaPosition, digest: str
    ) -> None:
        connection.execute(
            """INSERT INTO consumed_events
               (consumer_name, logical_event_id, source_topic, source_partition,
                source_offset, payload_sha256)
               VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
            (consumer, logical_id, position.topic, position.partition, position.offset, digest),
        )

    @staticmethod
    def _insert_outbox(connection, event_id, aggregate_type, aggregate_id, topic, key, payload) -> None:
        connection.execute(
            """INSERT INTO outbox_events
               (event_id, aggregate_type, aggregate_id, destination_topic, message_key,
                schema_version, payload)
               VALUES (%s,%s,%s,%s,%s,'1.0.0',%s) ON CONFLICT (event_id) DO NOTHING""",
            (event_id, aggregate_type, aggregate_id, topic, key, Jsonb(payload)),
        )

    def claim_outbox(
        self,
        worker_id: str,
        limit: int,
        lease_seconds: int = 30,
        created_after=None,
    ) -> list[OutboxMessage]:
        """Claim briefly; caller publishes only after this transaction has committed."""
        with self.connection() as connection, connection.transaction():
            rows = connection.execute(
                """SELECT event_id, destination_topic, message_key, payload FROM outbox_events
                   WHERE (status='PENDING' OR (status='CLAIMED' AND claim_until < now()))
                     AND available_at <= now()
                     AND (%s::timestamptz IS NULL OR created_at >= %s::timestamptz)
                   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT %s""",
                (created_after, created_after, limit),
            ).fetchall()
            ids = [row["event_id"] for row in rows]
            if ids:
                connection.execute(
                    """UPDATE outbox_events SET status='CLAIMED', claimed_by=%s,
                       claim_until=now()+(%s * interval '1 second'), attempts=attempts+1
                       WHERE event_id = ANY(%s)""",
                    (worker_id, lease_seconds, ids),
                )
        return [
            OutboxMessage(row["event_id"], row["destination_topic"], row["message_key"], row["payload"])
            for row in rows
        ]

    def mark_published(self, event_id: UUID, worker_id: str) -> None:
        with self.connection() as connection, connection.transaction():
            changed = connection.execute(
                """UPDATE outbox_events SET status='PUBLISHED', published_at=now(), claim_until=NULL
                   WHERE event_id=%s AND status='CLAIMED' AND claimed_by=%s""",
                (event_id, worker_id),
            ).rowcount
            if changed != 1:
                raise RuntimeError("outbox claim was lost before acknowledgement")

    def release_outbox(self, event_id: UUID, worker_id: str, error_type: str, delay_seconds: int) -> None:
        with self.connection() as connection, connection.transaction():
            connection.execute(
                """UPDATE outbox_events SET status='PENDING', claimed_by=NULL, claim_until=NULL,
                   available_at=now()+(%s * interval '1 second'), last_error_type=%s
                   WHERE event_id=%s AND claimed_by=%s""",
                (delay_seconds, error_type, event_id, worker_id),
            )

    def prepare_investigation_attempt(
        self,
        request: InvestigationRequestEvent,
        position: KafkaPosition,
        payload_sha256: str,
        mode: str,
        models: dict[str, str],
        max_attempts: int,
    ) -> tuple[UUID, int] | None:
        """Claim work durably. Existing RUNNING live attempts remain ambiguous and are not replayed."""
        with self.connection() as connection, connection.transaction():
            row = connection.execute(
                "SELECT status, request_payload FROM investigations WHERE investigation_id=%s FOR UPDATE",
                (request.investigation_id,),
            ).fetchone()
            if not row:
                raise RuntimeError("investigation request has no authoritative router state")
            if row["request_payload"] != request.model_dump(mode="json"):
                raise IdentityConflict("investigation request differs from authoritative router state")
            self._record_inbox(connection, "investigation-worker", request.event_id, position, payload_sha256)
            if row["status"] in {"COMPLETED", "FAILED", "AMBIGUOUS"}:
                return None
            running = connection.execute(
                """SELECT attempt_id FROM investigation_attempts
                   WHERE investigation_id=%s AND status='RUNNING' ORDER BY attempt_number DESC LIMIT 1""",
                (request.investigation_id,),
            ).fetchone()
            if running:
                connection.execute(
                    """UPDATE investigation_attempts SET status='AMBIGUOUS', finished_at=now()
                       WHERE attempt_id=%s""",
                    (running["attempt_id"],),
                )
                connection.execute(
                    """UPDATE investigations SET status='AMBIGUOUS', updated_at=now()
                       WHERE investigation_id=%s""",
                    (request.investigation_id,),
                )
                connection.execute(
                    """UPDATE live_investigation_allocations SET status='AMBIGUOUS',updated_at=now()
                       WHERE attempt_id=%s""",
                    (running["attempt_id"],),
                )
                return None
            number = connection.execute(
                """SELECT coalesce(max(attempt_number),0)+1 AS n FROM investigation_attempts
                   WHERE investigation_id=%s""",
                (request.investigation_id,),
            ).fetchone()["n"]
            if number > max_attempts:
                connection.execute(
                    "UPDATE investigations SET status='FAILED', updated_at=now() WHERE investigation_id=%s",
                    (request.investigation_id,),
                )
                return None
            attempt_id = uuid4()
            connection.execute(
                """INSERT INTO investigation_attempts
                   (attempt_id, investigation_id, attempt_number, mode, status, model_configuration)
                   VALUES (%s,%s,%s,%s,'PREPARED',%s)""",
                (attempt_id, request.investigation_id, number, mode, Jsonb(models)),
            )
            connection.execute(
                "UPDATE investigations SET status='RUNNING', updated_at=now() WHERE investigation_id=%s",
                (request.investigation_id,),
            )
            return attempt_id, number

    def mark_attempt_running(self, attempt_id: UUID) -> None:
        with self.connection() as connection, connection.transaction():
            connection.execute(
                """UPDATE investigation_attempts SET status='RUNNING', started_at=now()
                   WHERE attempt_id=%s AND status='PREPARED'""",
                (attempt_id,),
            )

    def record_investigation_context(
        self,
        investigation_id: UUID,
        context: TransactionContext,
        historical: HistoricalEvidence | None,
        provenance: str,
    ) -> None:
        payload = {
            "context": context.model_dump(mode="json"),
            "historical": historical.model_dump(mode="json") if historical else None,
        }
        digest = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        with self.connection() as connection, connection.transaction():
            existing = connection.execute(
                "SELECT payload_sha256 FROM investigation_context WHERE investigation_id=%s FOR UPDATE",
                (investigation_id,),
            ).fetchone()
            if existing:
                if existing["payload_sha256"] != digest:
                    raise IdentityConflict("investigation context is immutable")
                return
            connection.execute(
                """INSERT INTO investigation_context
                   (investigation_id,context_payload,historical_payload,payload_sha256,provenance)
                   VALUES (%s,%s,%s,%s,%s)""",
                (
                    investigation_id,
                    Jsonb(payload["context"]),
                    Jsonb(payload["historical"]) if payload["historical"] else None,
                    digest,
                    provenance,
                ),
            )

    def load_investigation_input(self, request: InvestigationRequestEvent) -> InvestigationInput:
        with self.connection() as connection:
            row = connection.execute(
                """SELECT context_payload,historical_payload FROM investigation_context
                   WHERE investigation_id=%s""",
                (request.investigation_id,),
            ).fetchone()
        if not row:
            return InvestigationInput(flink=request.evidence)
        return InvestigationInput(
            flink=request.evidence,
            context=TransactionContext.model_validate(row["context_payload"]),
            historical=(
                HistoricalEvidence.model_validate(row["historical_payload"])
                if row["historical_payload"]
                else None
            ),
        )

    def configure_live_experiment(self, settings) -> None:
        budget_usd = Decimal(str(settings.live_budget_gbp)) * Decimal(
            str(settings.live_usd_per_gbp)
        )
        configuration = {
            "investigation_reserve_usd": settings.live_investigation_reserve_usd,
            "max_model_calls": settings.live_max_model_calls,
            "remaining_call_reserve_usd": settings.live_remaining_call_reserve_usd,
            "input_token_safety_multiplier": settings.live_input_token_safety_multiplier,
            "pricing_usd_per_million_tokens": {
                model: list(rates) for model, rates in settings.pricing.items()
            },
        }
        with self.connection() as connection, connection.transaction():
            existing = connection.execute(
                "SELECT * FROM live_experiments WHERE experiment_id=%s FOR UPDATE",
                (settings.live_experiment_id,),
            ).fetchone()
            expected = (
                Decimal(str(settings.live_budget_gbp)),
                Decimal(str(settings.live_usd_per_gbp)),
                budget_usd,
                Decimal(str(settings.live_baseline_cost_usd)),
                settings.live_max_investigations,
            )
            if existing:
                observed = (
                    existing["budget_gbp"],
                    existing["usd_per_gbp"],
                    existing["budget_usd"],
                    existing["baseline_cost_usd"],
                    existing["max_investigations"],
                )
                if observed != expected or existing["configuration"] != configuration:
                    raise RuntimeError("live experiment configuration differs from durable state")
                return
            connection.execute(
                """INSERT INTO live_experiments
                   (experiment_id,budget_gbp,usd_per_gbp,budget_usd,baseline_cost_usd,
                    max_investigations,configuration) VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                (*((settings.live_experiment_id,) + expected), Jsonb(configuration)),
            )

    def allocate_live_investigation(self, attempt_id: UUID, investigation_id: UUID, settings) -> None:
        reserve = Decimal(str(settings.live_investigation_reserve_usd))
        with self.connection() as connection, connection.transaction():
            attempt = connection.execute(
                """SELECT investigation_id,mode,status FROM investigation_attempts
                   WHERE attempt_id=%s FOR UPDATE""",
                (attempt_id,),
            ).fetchone()
            if (
                not attempt
                or attempt["investigation_id"] != investigation_id
                or attempt["mode"] != "live"
                or attempt["status"] != "PREPARED"
            ):
                raise RuntimeError("paid allocation requires its matching PREPARED live attempt")
            experiment = connection.execute(
                "SELECT * FROM live_experiments WHERE experiment_id=%s FOR UPDATE",
                (settings.live_experiment_id,),
            ).fetchone()
            if not experiment:
                raise RuntimeError("live experiment is not configured")
            existing = connection.execute(
                "SELECT attempt_id FROM live_investigation_allocations WHERE investigation_id=%s",
                (investigation_id,),
            ).fetchone()
            if existing:
                if existing["attempt_id"] != attempt_id:
                    raise RuntimeError("live investigation already has a paid allocation")
                return
            totals = connection.execute(
                """SELECT count(*) AS count,coalesce(sum(reserved_cost_usd),0) AS reserved
                   FROM live_investigation_allocations WHERE experiment_id=%s""",
                (settings.live_experiment_id,),
            ).fetchone()
            if totals["count"] >= experiment["max_investigations"]:
                raise RuntimeError("live investigation count limit exhausted")
            if experiment["baseline_cost_usd"] + totals["reserved"] + reserve > experiment["budget_usd"]:
                raise RuntimeError("cumulative live experiment budget exhausted")
            connection.execute(
                """INSERT INTO live_investigation_allocations
                   (investigation_id,experiment_id,attempt_id,reserved_cost_usd,status)
                   VALUES (%s,%s,%s,%s,'ACTIVE')""",
                (investigation_id, settings.live_experiment_id, attempt_id, reserve),
            )

    def reserve_model_call(
        self,
        *,
        call_id: UUID,
        attempt_id: UUID,
        agent: str,
        model: str,
        call_number: int,
        approximate_input_tokens: int,
        max_output_tokens: int,
        reserved_cost_usd: Decimal,
        settings,
    ) -> None:
        with self.connection() as connection, connection.transaction():
            allocation = connection.execute(
                """SELECT a.*,e.budget_usd,e.baseline_cost_usd FROM live_investigation_allocations a
                   JOIN live_experiments e USING(experiment_id) WHERE attempt_id=%s FOR UPDATE OF a""",
                (attempt_id,),
            ).fetchone()
            if not allocation or allocation["status"] != "ACTIVE":
                raise RuntimeError("live investigation has no active durable allocation")
            usage = connection.execute(
                """SELECT count(*) AS calls,coalesce(sum(accounted_cost_usd),0) AS actual,
                   coalesce(sum(reserved_cost_usd) FILTER (WHERE status='RESERVED'),0) AS active
                   FROM model_call_usage WHERE attempt_id=%s""",
                (attempt_id,),
            ).fetchone()
            if usage["calls"] >= settings.live_max_model_calls:
                raise RuntimeError("live model-call limit exhausted")
            remaining_calls = settings.live_max_model_calls - usage["calls"] - 1
            remaining_reserve = Decimal(str(settings.live_remaining_call_reserve_usd)) * remaining_calls
            projected = usage["actual"] + usage["active"] + reserved_cost_usd + remaining_reserve
            if projected > allocation["reserved_cost_usd"]:
                raise RuntimeError("investigation reserve cannot cover this call and remaining-call reserve")
            connection.execute(
                """INSERT INTO model_call_usage
                   (call_id,experiment_id,investigation_id,attempt_id,agent,model,call_number,status,
                    approximate_input_tokens,max_output_tokens,reserved_cost_usd,
                    remaining_calls_reserve_usd,provenance)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,'RESERVED',%s,%s,%s,%s,%s)""",
                (
                    call_id, allocation["experiment_id"], allocation["investigation_id"], attempt_id,
                    agent, model, call_number, approximate_input_tokens, max_output_tokens,
                    reserved_cost_usd, remaining_reserve,
                    Jsonb({"source": "anthropic_messages_api", "pricing": "configured_estimate"}),
                ),
            )

    def settle_model_call(
        self, call_id: UUID, input_tokens: int, output_tokens: int, cost_usd: Decimal, latency_ms: float
    ) -> None:
        with self.connection() as connection, connection.transaction():
            row = connection.execute(
                """UPDATE model_call_usage SET status='SUCCEEDED',input_tokens=%s,output_tokens=%s,
                   accounted_cost_usd=%s,latency_ms=%s,settled_at=now()
                   WHERE call_id=%s AND status='RESERVED' RETURNING attempt_id""",
                (input_tokens, output_tokens, cost_usd, latency_ms, call_id),
            ).fetchone()
            if not row:
                raise RuntimeError("model-call reservation is missing or already settled")
            connection.execute(
                """UPDATE live_investigation_allocations SET actual_cost_usd=actual_cost_usd+%s,
                   updated_at=now() WHERE attempt_id=%s""",
                (cost_usd, row["attempt_id"]),
            )

    def mark_model_call_ambiguous(self, call_id: UUID, latency_ms: float, error_type: str) -> None:
        with self.connection() as connection, connection.transaction():
            row = connection.execute(
                """UPDATE model_call_usage SET status='AMBIGUOUS',accounted_cost_usd=reserved_cost_usd,
                   latency_ms=%s,error_type=%s,settled_at=now()
                   WHERE call_id=%s AND status='RESERVED'
                   RETURNING attempt_id,reserved_cost_usd""",
                (latency_ms, error_type, call_id),
            ).fetchone()
            if row:
                connection.execute(
                    """UPDATE live_investigation_allocations SET actual_cost_usd=actual_cost_usd+%s,
                       updated_at=now() WHERE attempt_id=%s""",
                    (row["reserved_cost_usd"], row["attempt_id"]),
                )

    def record_model_call_tools(self, call_id: UUID, tool_names: list[str]) -> None:
        with self.connection() as connection, connection.transaction():
            connection.execute(
                "UPDATE model_call_usage SET tool_names=%s WHERE call_id=%s",
                (Jsonb(tool_names), call_id),
            )

    def complete_investigation(
        self,
        attempt_id: UUID,
        event: InvestigationCompletedEvent,
        audit_payload: dict[str, Any],
        estimated_cost: float,
    ) -> None:
        with self.connection() as connection, connection.transaction():
            connection.execute(
                """UPDATE investigation_attempts SET status='SUCCEEDED', finished_at=now(),
                   estimated_cost_usd=coalesce(
                     (SELECT actual_cost_usd FROM live_investigation_allocations WHERE attempt_id=%s),%s)
                   WHERE attempt_id=%s""",
                (attempt_id, estimated_cost, attempt_id),
            )
            connection.execute(
                """UPDATE live_investigation_allocations SET status='COMPLETED',updated_at=now()
                   WHERE attempt_id=%s""",
                (attempt_id,),
            )
            connection.execute(
                """UPDATE investigations SET status='COMPLETED', recommended_action=%s,
                   investigation_policy_version=%s, result_payload=%s, completed_at=%s, updated_at=now()
                   WHERE investigation_id=%s""",
                (
                    event.recommended_action.value,
                    event.investigation_policy_version,
                    Jsonb(event.model_dump(mode="json")),
                    event.completed_at,
                    event.investigation_id,
                ),
            )
            connection.execute(
                """INSERT INTO audit_records (investigation_id, attempt_id, audit_payload) VALUES (%s,%s,%s)
                   ON CONFLICT (investigation_id) DO NOTHING""",
                (event.investigation_id, attempt_id, Jsonb(audit_payload)),
            )
            self._insert_outbox(
                connection,
                event.event_id,
                "investigation",
                event.investigation_id,
                "fraud.investigations.completed",
                event.transaction_id,
                event.model_dump(mode="json"),
            )

    def fail_attempt(self, attempt_id: UUID, retryable: bool, error_type: str) -> None:
        status = "RETRYABLE_FAILED" if retryable else "PERMANENT_FAILED"
        with self.connection() as connection, connection.transaction():
            row = connection.execute(
                """UPDATE investigation_attempts SET status=%s, failure_type=%s, finished_at=now()
                   WHERE attempt_id=%s RETURNING investigation_id""",
                (status, error_type, attempt_id),
            ).fetchone()
            connection.execute(
                "UPDATE investigations SET status=%s, updated_at=now() WHERE investigation_id=%s",
                ("REQUESTED" if retryable else "FAILED", row["investigation_id"]),
            )
            connection.execute(
                """UPDATE live_investigation_allocations SET status=%s,updated_at=now()
                   WHERE attempt_id=%s""",
                ("AMBIGUOUS" if retryable else "FAILED", attempt_id),
            )

    def live_budget_status(self, experiment_id: str) -> dict[str, Any]:
        with self.connection() as connection:
            row = connection.execute(
                """SELECT e.*,
                   count(a.investigation_id) AS investigation_count,
                   coalesce(sum(a.reserved_cost_usd),0) AS allocated_cost_usd,
                   coalesce(sum(a.actual_cost_usd),0) AS accounted_new_cost_usd
                   FROM live_experiments e LEFT JOIN live_investigation_allocations a USING(experiment_id)
                   WHERE e.experiment_id=%s GROUP BY e.experiment_id""",
                (experiment_id,),
            ).fetchone()
            if not row:
                raise RuntimeError("live experiment is not configured")
            result = dict(row)
            result["accounted_total_cost_usd"] = (
                row["baseline_cost_usd"] + row["accounted_new_cost_usd"]
            )
            result["estimated_total_cost_gbp"] = (
                result["accounted_total_cost_usd"] / row["usd_per_gbp"]
            )
            return result
