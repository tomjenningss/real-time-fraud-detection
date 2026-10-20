from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from anthropic import AsyncAnthropic

from .config import Settings
from .schemas import ModelUsage, ToolAudit

ToolHandler = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]

# USD per million tokens. Haiku is the published base tier; runtime metadata is configurable.
DEFAULT_PRICING = {
    "claude-opus-5-5": (4.0, 20.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-haiku-5-5": (0.10, 0.50),
}


class CostLimitExceeded(RuntimeError):
    pass


@dataclass(frozen=True)
class CostReservation:
    amount_usd: float


class CostController:
    def __init__(self, limit_usd: float, pricing: dict[str, tuple[float, float]] | None = None):
        self.limit_usd = limit_usd
        self.pricing = pricing or DEFAULT_PRICING
        self.actual_cost_usd = 0.0
        self._reserved_usd = 0.0
        self._lock = asyncio.Lock()

    def estimate(self, model: str, input_tokens: int, output_tokens: int) -> float:
        if model not in self.pricing:
            raise ValueError(f"No pricing metadata configured for model {model}")
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
    ) -> CostReservation:
        estimate = self.estimate(model, approximate_input_tokens, max_output_tokens)
        async with self._lock:
            if self.actual_cost_usd + self._reserved_usd + estimate > self.limit_usd:
                raise CostLimitExceeded("estimated investigation cost limit would be exceeded")
            self._reserved_usd += estimate
        return CostReservation(estimate)

    async def settle(
        self,
        model: str,
        reservation: CostReservation,
        input_tokens: int,
        output_tokens: int,
        latency_ms: float = 0,
    ) -> float:
        actual = self.estimate(model, input_tokens, output_tokens)
        async with self._lock:
            self._reserved_usd = max(0.0, self._reserved_usd - reservation.amount_usd)
            self.actual_cost_usd += actual
        return actual

    async def ambiguous(self, reservation: CostReservation, latency_ms: float, error_type: str) -> None:
        async with self._lock:
            self._reserved_usd = max(0.0, self._reserved_usd - reservation.amount_usd)
            self.actual_cost_usd += reservation.amount_usd

    async def record_tools(self, reservation: CostReservation, tool_names: list[str]) -> None:
        return None


@dataclass
class AgentLoopResult:
    final_text: str = ""
    called_tools: set[str] = field(default_factory=set)
    usages: list[ModelUsage] = field(default_factory=list)
    tool_audits: list[ToolAudit] = field(default_factory=list)


class AnthropicToolRuntime:
    def __init__(self, settings: Settings, costs: CostController):
        self.settings = settings
        self.costs = costs
        self.client = AsyncAnthropic(api_key=settings.api_key, timeout=settings.timeout_seconds)

    async def run(
        self,
        *,
        agent: str,
        model: str,
        system: str,
        user_content: str,
        tools: list[dict[str, Any]],
        handlers: dict[str, ToolHandler],
    ) -> AgentLoopResult:
        result = AgentLoopResult()
        messages: list[dict[str, Any]] = [{"role": "user", "content": user_content}]
        for call_number in range(1, self.settings.max_tool_iterations + 1):
            approximate = max(1, len(json.dumps(messages) + system + json.dumps(tools)) // 4)
            reservation = await self.costs.reserve(
                model,
                approximate,
                self.settings.max_output_tokens,
                agent=agent,
                call_number=call_number,
            )
            started = time.perf_counter()
            try:
                response = await self.client.messages.create(
                    model=model,
                    max_tokens=self.settings.max_output_tokens,
                    system=system,
                    messages=messages,
                    tools=tools,
                )
            except Exception as error:
                latency_ms = (time.perf_counter() - started) * 1000
                await self.costs.ambiguous(reservation, latency_ms, type(error).__name__)
                raise
            latency_ms = (time.perf_counter() - started) * 1000
            try:
                input_tokens = int(response.usage.input_tokens)
                output_tokens = int(response.usage.output_tokens)
                if input_tokens < 0 or output_tokens < 0:
                    raise ValueError("negative Anthropic usage")
            except Exception as error:
                await self.costs.ambiguous(reservation, latency_ms, type(error).__name__)
                raise RuntimeError("Anthropic response usage could not be accounted for") from error
            cost = await self.costs.settle(
                model, reservation, input_tokens, output_tokens, latency_ms
            )
            result.usages.append(
                ModelUsage(
                    agent=agent,
                    model=model,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    latency_ms=latency_ms,
                    estimated_cost_usd=cost,
                    call_number=call_number,
                )
            )
            blocks = [block.model_dump(mode="json") for block in response.content]
            messages.append({"role": "assistant", "content": blocks})
            text_blocks = [block.get("text", "") for block in blocks if block.get("type") == "text"]
            if text_blocks:
                result.final_text = "\n".join(text_blocks).strip()
            calls = [block for block in blocks if block.get("type") == "tool_use"]
            await self.costs.record_tools(
                reservation, [str(block.get("name")) for block in calls]
            )
            if not calls:
                return result

            async def dispatch(call: dict[str, Any]) -> dict[str, Any]:
                name = str(call.get("name"))
                result.called_tools.add(name)
                handler = handlers.get(name)
                if handler is None:
                    result.tool_audits.append(
                        ToolAudit(
                            agent=agent,
                            tool_name=name,
                            status="rejected",
                            source="tool_registry",
                            detail={"reason": "tool is not registered for this agent"},
                        )
                    )
                    return {
                        "type": "tool_result",
                        "tool_use_id": call["id"],
                        "content": "Tool rejected by restricted registry.",
                        "is_error": True,
                    }
                try:
                    payload = await handler(call.get("input", {}))
                    audit_source = str(payload.pop("_audit_source", "validated_python_tool"))
                    audit_detail = {
                        key: payload[key]
                        for key in ("status", "canonical_source", "policy_version", "verdict")
                        if key in payload
                    }
                    result.tool_audits.append(
                        ToolAudit(
                            agent=agent,
                            tool_name=name,
                            status="ok",
                            source=audit_source,
                            detail=audit_detail,
                        )
                    )
                    return {
                        "type": "tool_result",
                        "tool_use_id": call["id"],
                        "content": json.dumps(payload, separators=(",", ":")),
                    }
                except Exception as error:
                    result.tool_audits.append(
                        ToolAudit(
                            agent=agent,
                            tool_name=name,
                            status="error",
                            source="validated_python_tool",
                            detail={"error_type": type(error).__name__},
                        )
                    )
                    return {
                        "type": "tool_result",
                        "tool_use_id": call["id"],
                        "content": f"Tool error: {type(error).__name__}",
                        "is_error": True,
                    }

            tool_results = await asyncio.gather(*(dispatch(call) for call in calls))
            messages.append({"role": "user", "content": list(tool_results)})
        raise RuntimeError(f"{agent} exceeded MAX_TOOL_ITERATIONS")
