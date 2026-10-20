from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID, uuid4

from .anthropic_runtime import CostLimitExceeded


@dataclass(frozen=True)
class DurableReservation:
    call_id: UUID
    amount_usd: float


class DurableCostController:
    """PostgreSQL-backed guard shared by concurrent workers and process restarts."""

    def __init__(self, store, attempt_id: UUID, settings):
        self.store = store
        self.attempt_id = attempt_id
        self.settings = settings
        self.pricing = settings.pricing

    def estimate(self, model: str, input_tokens: int, output_tokens: int) -> float:
        if model not in self.pricing:
            raise CostLimitExceeded(f"no pricing metadata configured for model {model}")
        input_rate, output_rate = self.pricing[model]
        return input_tokens * input_rate / 1_000_000 + output_tokens * output_rate / 1_000_000

    async def reserve(
        self,
        model: str,
        approximate_input_tokens: int,
        max_output_tokens: int,
        *,
        agent: str = "unknown",
        call_number: int = 1,
    ) -> DurableReservation:
        safe_input = int(
            approximate_input_tokens * self.settings.live_input_token_safety_multiplier + 0.999
        )
        amount = self.estimate(model, safe_input, max_output_tokens)
        call_id = uuid4()
        try:
            self.store.reserve_model_call(
                call_id=call_id,
                attempt_id=self.attempt_id,
                agent=agent,
                model=model,
                call_number=call_number,
                approximate_input_tokens=safe_input,
                max_output_tokens=max_output_tokens,
                reserved_cost_usd=Decimal(str(amount)),
                settings=self.settings,
            )
        except RuntimeError as error:
            raise CostLimitExceeded(str(error)) from error
        return DurableReservation(call_id, amount)

    async def settle(
        self,
        model: str,
        reservation: DurableReservation,
        input_tokens: int,
        output_tokens: int,
        latency_ms: float = 0,
    ) -> float:
        actual = self.estimate(model, input_tokens, output_tokens)
        self.store.settle_model_call(
            reservation.call_id,
            input_tokens,
            output_tokens,
            Decimal(str(actual)),
            latency_ms,
        )
        return actual

    async def ambiguous(self, reservation: DurableReservation, latency_ms: float, error_type: str) -> None:
        self.store.mark_model_call_ambiguous(reservation.call_id, latency_ms, error_type)

    async def record_tools(self, reservation: DurableReservation, tool_names: list[str]) -> None:
        self.store.record_model_call_tools(reservation.call_id, tool_names)
