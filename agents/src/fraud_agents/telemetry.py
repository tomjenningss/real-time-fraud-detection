from __future__ import annotations

import json
import logging
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from openinference.semconv.trace import SpanAttributes
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter
from opentelemetry.trace import SpanKind, Status, StatusCode

LOGGER = logging.getLogger(__name__)

# OpenInference attribute names are kept here rather than importing an agent framework. They are
# the stable wire-level semantic conventions understood by Phoenix.
OPENINFERENCE_SPAN_KIND = SpanAttributes.OPENINFERENCE_SPAN_KIND
LLM_MODEL_NAME = SpanAttributes.LLM_MODEL_NAME
LLM_TOKEN_COUNT_INPUT = SpanAttributes.LLM_TOKEN_COUNT_PROMPT
LLM_TOKEN_COUNT_OUTPUT = SpanAttributes.LLM_TOKEN_COUNT_COMPLETION
LLM_TOKEN_COUNT_TOTAL = SpanAttributes.LLM_TOKEN_COUNT_TOTAL
INPUT_VALUE = SpanAttributes.INPUT_VALUE
OUTPUT_VALUE = SpanAttributes.OUTPUT_VALUE
INPUT_MIME_TYPE = SpanAttributes.INPUT_MIME_TYPE
OUTPUT_MIME_TYPE = SpanAttributes.OUTPUT_MIME_TYPE

_SAFE_CONTEXT: ContextVar[dict[str, Any] | None] = ContextVar(
    "fraud_trace_context", default=None
)
_SENSITIVE_KEYS = frozenset(
    {
        "api_key",
        "authorization",
        "cookie",
        "database_url",
        "device_lat",
        "device_lon",
        "email",
        "full_name",
        "merchant_lat",
        "merchant_lon",
        "payment_card",
        "password",
        "secret",
        "token",
        "user_id",
    }
)


def _safe_value(value: Any) -> str | bool | int | float | list[str]:
    if isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, (list, tuple, set)):
        return [str(item) for item in value]
    return str(value)


def redact(value: Any) -> Any:
    """Recursively remove secrets and location/customer data from opt-in trace content."""
    if isinstance(value, Mapping):
        return {
            str(key): (
                "[REDACTED]"
                if _sensitive_key(str(key))
                else redact(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact(item) for item in value)
    return value


def _sensitive_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_").replace(".", "_")
    return normalized in _SENSITIVE_KEYS or any(
        normalized.endswith(f"_{suffix}")
        for suffix in ("api_key", "authorization", "password", "secret")
    )


class SafeSpan:
    def __init__(self, span: trace.Span | None = None):
        self._span = span

    def set(self, key: str, value: Any) -> None:
        if self._span is None or value is None:
            return
        try:
            self._span.set_attribute(key, _safe_value(value))
        except Exception:
            LOGGER.debug("unable to set telemetry attribute", exc_info=True)

    def event(self, name: str, attributes: Mapping[str, Any] | None = None) -> None:
        if self._span is None:
            return
        try:
            safe = {key: _safe_value(value) for key, value in (attributes or {}).items()}
            self._span.add_event(name, safe)
        except Exception:
            LOGGER.debug("unable to add telemetry event", exc_info=True)

    def error(self, error: BaseException, *, ambiguous: bool = False) -> None:
        if self._span is None:
            return
        try:
            self._span.record_exception(error)
            self._span.set_status(Status(StatusCode.ERROR, type(error).__name__))
            self._span.set_attribute("fraud.error.type", type(error).__name__)
            self._span.set_attribute("fraud.api_outcome_ambiguous", ambiguous)
        except Exception:
            LOGGER.debug("unable to record telemetry error", exc_info=True)

    @property
    def trace_id(self) -> str | None:
        if self._span is None:
            return None
        context = self._span.get_span_context()
        return f"{context.trace_id:032x}" if context.is_valid else None

    @property
    def span_id(self) -> str | None:
        if self._span is None:
            return None
        context = self._span.get_span_context()
        return f"{context.span_id:016x}" if context.is_valid else None


@dataclass
class Telemetry:
    enabled: bool = False
    capture_synthetic_content: bool = False
    tracer: trace.Tracer | None = None
    provider: TracerProvider | None = None

    @classmethod
    def from_settings(
        cls, settings: Any, *, exporter: SpanExporter | None = None
    ) -> Telemetry:
        if not settings.otel_enabled:
            return cls()
        try:
            provider = TracerProvider(
                resource=Resource.create(
                    {
                        "service.name": settings.otel_service_name,
                        "openinference.project.name": settings.phoenix_project_name,
                    }
                )
            )
            selected_exporter = exporter or OTLPSpanExporter(
                endpoint=settings.otel_exporter_otlp_endpoint,
                timeout=settings.otel_export_timeout_seconds,
            )
            # Tests use a simple processor to make span completion deterministic.
            if exporter is not None:
                from opentelemetry.sdk.trace.export import SimpleSpanProcessor

                provider.add_span_processor(SimpleSpanProcessor(selected_exporter))
            else:
                provider.add_span_processor(
                    BatchSpanProcessor(
                        selected_exporter,
                        max_queue_size=512,
                        max_export_batch_size=128,
                    )
                )
            return cls(
                enabled=True,
                capture_synthetic_content=settings.otel_capture_synthetic_content,
                tracer=provider.get_tracer("fraud_agents", "0.1.0"),
                provider=provider,
            )
        except Exception:
            LOGGER.warning("telemetry initialization failed; continuing without tracing", exc_info=True)
            return cls()

    @contextmanager
    def bind(self, attributes: Mapping[str, Any]) -> Iterator[None]:
        if not self.enabled:
            yield
            return
        merged = {**(_SAFE_CONTEXT.get() or {}), **dict(attributes)}
        token = _SAFE_CONTEXT.set(merged)
        try:
            yield
        finally:
            _SAFE_CONTEXT.reset(token)

    @contextmanager
    def span(
        self,
        name: str,
        span_kind: str,
        attributes: Mapping[str, Any] | None = None,
        *,
        kind: SpanKind = SpanKind.INTERNAL,
    ) -> Iterator[SafeSpan]:
        if not self.enabled or self.tracer is None:
            yield SafeSpan()
            return
        combined = {**(_SAFE_CONTEXT.get() or {}), **dict(attributes or {})}
        combined[OPENINFERENCE_SPAN_KIND] = span_kind
        try:
            manager = self.tracer.start_as_current_span(name, kind=kind)
            raw_span = manager.__enter__()
        except Exception:
            LOGGER.warning("telemetry span failed", exc_info=True)
            yield SafeSpan()
            return
        safe_span = SafeSpan(raw_span)
        for key, value in combined.items():
            safe_span.set(key, value)
        safe_span.set("fraud.trace_id", safe_span.trace_id)
        safe_span.set("fraud.span_id", safe_span.span_id)
        try:
            yield safe_span
        except BaseException as error:
            # Let the OpenTelemetry context manager record the application error, but preserve it.
            try:
                manager.__exit__(type(error), error, error.__traceback__)
            except Exception:
                LOGGER.warning("telemetry span close failed", exc_info=True)
            raise
        else:
            try:
                manager.__exit__(None, None, None)
            except Exception:
                LOGGER.warning("telemetry span close failed", exc_info=True)

    def content_attributes(self, *, input_value: Any = None, output_value: Any = None) -> dict[str, str]:
        if not self.enabled or not self.capture_synthetic_content:
            return {}
        attributes: dict[str, str] = {}
        if input_value is not None:
            attributes[INPUT_VALUE] = json.dumps(redact(input_value), sort_keys=True, default=str)
            attributes[INPUT_MIME_TYPE] = "application/json"
        if output_value is not None:
            attributes[OUTPUT_VALUE] = json.dumps(redact(output_value), sort_keys=True, default=str)
            attributes[OUTPUT_MIME_TYPE] = "application/json"
        return attributes

    def force_flush(self, timeout_millis: int = 5000) -> bool:
        if self.provider is None:
            return True
        try:
            return bool(self.provider.force_flush(timeout_millis=timeout_millis))
        except Exception:
            LOGGER.warning("telemetry flush failed", exc_info=True)
            return False
