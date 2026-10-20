from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from pydantic import ValidationError

from .budget import DurableCostController
from .config import Settings
from .events import (
    DlqEvent,
    InvestigationCompletedEvent,
    InvestigationRequestEvent,
    KafkaPosition,
    SourcePosition,
    stable_uuid,
)
from .supervisor import Supervisor
from .telemetry import Telemetry

if TYPE_CHECKING:
    from .database import FraudStore


class InvestigationWorker:
    def __init__(self, store: FraudStore, settings: Settings, *, max_attempts: int = 3):
        self.store = store
        self.settings = settings
        self.max_attempts = max_attempts
        self.telemetry = Telemetry.from_settings(settings)

    async def process(self, raw: bytes, position: KafkaPosition) -> bool:
        digest = hashlib.sha256(raw).hexdigest()
        try:
            request = InvestigationRequestEvent.model_validate_json(raw)
        except (ValidationError, ValueError, UnicodeDecodeError) as error:
            logical_id = stable_uuid(
                "invalid-investigation", f"{position.topic}:{position.partition}:{position.offset}"
            )
            source = SourcePosition(
                topic=position.topic, partition=position.partition, offset=position.offset
            )
            dlq = DlqEvent(
                event_id=stable_uuid("investigation-dlq", str(logical_id)),
                service="investigation_worker",
                failure_type=type(error).__name__,
                retryable=False,
                source=source,
                sanitised_detail={"reason": "investigation_request_validation_failed"},
            )
            self.store.record_dlq(
                consumer_name="investigation-worker",
                logical_event_id=logical_id,
                position=position,
                payload_sha256=digest,
                event_id=dlq.event_id,
                topic="fraud.investigations.dlq",
                key=str(logical_id),
                payload=dlq.model_dump(mode="json"),
            )
            return True
        claim = self.store.prepare_investigation_attempt(
            request, position, digest, self.settings.agent_mode, self.settings.models, self.max_attempts
        )
        if claim is None:
            return False
        attempt_id, _attempt_number = claim
        costs = None
        if self.settings.agent_mode == "live":
            try:
                self.store.configure_live_experiment(self.settings)
                self.store.allocate_live_investigation(
                    attempt_id, request.investigation_id, self.settings
                )
                costs = DurableCostController(self.store, attempt_id, self.settings)
            except Exception as error:
                self.store.fail_attempt(attempt_id, False, type(error).__name__)
                raise
        trace_attributes = {
            "fraud.investigation.id": str(request.investigation_id),
            "fraud.transaction.id": request.transaction_id,
            "fraud.attempt.id": str(attempt_id),
            "fraud.attempt.number": _attempt_number,
            "fraud.correlation.id": str(request.correlation_id),
            "fraud.decision.id": str(request.decision_id),
            "fraud.original_payment_verdict": request.original_payment_verdict.value,
            "messaging.source.name": position.topic,
            "messaging.kafka.partition": position.partition,
            "messaging.kafka.message.offset": position.offset,
        }
        with self.telemetry.bind(trace_attributes), self.telemetry.span(
            "fraud investigation", "CHAIN", trace_attributes
        ) as investigation_span:
            with self.telemetry.span("investigation worker", "CHAIN") as worker_span:
                self.store.mark_attempt_running(attempt_id)
                try:
                    event = self.store.load_investigation_input(request)
                    outcome = await Supervisor(
                        self.settings, costs=costs, telemetry=self.telemetry
                    ).investigate(event, investigation_id=request.investigation_id)
                    recommendation = outcome.recommendation
                    completed = InvestigationCompletedEvent(
                        event_id=stable_uuid(
                            "investigation-completed", str(request.investigation_id)
                        ),
                        investigation_id=request.investigation_id,
                        decision_id=request.decision_id,
                        transaction_id=request.transaction_id,
                        correlation_id=request.correlation_id,
                        original_payment_verdict=request.original_payment_verdict,
                        recommended_action=recommendation.verdict,
                        investigation_policy_version=(
                            outcome.audit.policy_version or "investigation-policy/unknown"
                        ),
                        triggered_rule_ids=outcome.audit.triggered_rules,
                        reason=recommendation.reason,
                        source_evidence_references=outcome.audit.canonical_evidence_references,
                        model_configuration=outcome.audit.agent_models,
                        audit_reference=f"postgresql:audit_records:{request.investigation_id}",
                        mode=self.settings.agent_mode,
                        completed_at=datetime.now(UTC),
                    )
                    with self.telemetry.span(
                        "investigation persisted",
                        "TOOL",
                        {
                            "tool.name": "postgresql.complete_investigation",
                            "messaging.destination.name": "fraud.investigations.completed",
                        },
                    ) as persistence_span:
                        self.store.complete_investigation(
                            attempt_id,
                            completed,
                            outcome.audit.model_dump(mode="json"),
                            outcome.audit.estimated_api_cost_usd,
                        )
                        persistence_span.event(
                            "completion event durably enqueued",
                            {"fraud.event.id": str(completed.event_id)},
                        )
                    investigation_span.set("fraud.recommendation", recommendation.verdict.value)
                    investigation_span.set("fraud.policy.version", outcome.audit.policy_version)
                    investigation_span.set(
                        "fraud.investigation.estimated_cost_usd",
                        outcome.audit.estimated_api_cost_usd,
                    )
                    return True
                except Exception as error:
                    worker_span.error(error)
                    retryable = isinstance(error, (TimeoutError, ConnectionError))
                    worker_span.set("fraud.attempt.retryable", retryable)
                    self.store.fail_attempt(attempt_id, retryable, type(error).__name__)
                    raise
