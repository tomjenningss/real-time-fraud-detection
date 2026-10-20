from __future__ import annotations

import asyncio
import threading
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

import pytest

from fraud_agents.anthropic_runtime import AnthropicToolRuntime, CostLimitExceeded
from fraud_agents.budget import DurableCostController
from fraud_agents.config import Settings
from fraud_agents.supervisor import Supervisor


class FakeLedger:
    def __init__(self, capacity: Decimal = Decimal("1")):
        self.capacity = capacity
        self.lock = threading.Lock()
        self.calls = {}
        self.actual = Decimal("0")

    def reserve_model_call(self, **values):
        key = (values["attempt_id"], values["agent"], values["call_number"])
        with self.lock:
            active = sum(
                row["reserved_cost_usd"] for row in self.calls.values() if row["status"] == "RESERVED"
            )
            projected = self.actual + active + values["reserved_cost_usd"]
            if projected > self.capacity:
                raise RuntimeError("cumulative live experiment budget exhausted")
            if key in self.calls:
                raise RuntimeError("duplicate model call")
            self.calls[values["call_id"]] = {**values, "status": "RESERVED"}

    def settle_model_call(self, call_id, input_tokens, output_tokens, cost_usd, latency_ms):
        with self.lock:
            row = self.calls[call_id]
            row.update(status="SUCCEEDED", input_tokens=input_tokens, output_tokens=output_tokens)
            self.actual += cost_usd

    def mark_model_call_ambiguous(self, call_id, latency_ms, error_type):
        with self.lock:
            row = self.calls[call_id]
            row.update(status="AMBIGUOUS", error_type=error_type)
            self.actual += row["reserved_cost_usd"]

    def record_model_call_tools(self, call_id, tool_names):
        self.calls[call_id]["tool_names"] = tool_names


def live_settings(**updates):
    return Settings(
        agent_mode="live",
        api_key="offline-test-key",
        max_output_tokens=64,
        live_max_model_calls=4,
        live_remaining_call_reserve_usd=0.000001,
        **updates,
    )


def test_live_supervisor_fails_closed_without_durable_controller():
    with pytest.raises(RuntimeError, match="durable PostgreSQL cost controller"):
        Supervisor(live_settings())


@pytest.mark.asyncio
async def test_budget_exhaustion_fails_before_api_call():
    settings = live_settings()
    store = FakeLedger(capacity=Decimal("0"))
    controller = DurableCostController(store, uuid4(), settings)
    with pytest.raises(CostLimitExceeded, match="budget exhausted"):
        await controller.reserve(settings.supervisor_model, 100, 64, agent="supervisor")


@pytest.mark.asyncio
async def test_concurrent_reservations_are_serialised_and_restart_state_is_retained():
    settings = live_settings()
    estimate = Decimal(str(settings.max_output_tokens * settings.price_opus_output / 1_000_000))
    store = FakeLedger(capacity=estimate * 2)
    attempt = uuid4()
    first = DurableCostController(store, attempt, settings)
    reservation = await first.reserve(settings.supervisor_model, 1, 64, agent="supervisor")
    await first.settle(settings.supervisor_model, reservation, 1, 1, 2.0)
    restarted = DurableCostController(store, attempt, settings)
    results = await asyncio.gather(
        restarted.reserve(settings.supervisor_model, 1, 64, agent="geo"),
        restarted.reserve(settings.supervisor_model, 1, 64, agent="behaviour"),
        return_exceptions=True,
    )
    assert sum(not isinstance(item, Exception) for item in results) == 1
    assert store.actual > 0


@pytest.mark.asyncio
async def test_api_failure_is_accounted_as_ambiguous_and_not_refunded():
    settings = live_settings()
    store = FakeLedger()
    controller = DurableCostController(store, uuid4(), settings)
    runtime = AnthropicToolRuntime(settings, controller)

    class FailingMessages:
        async def create(self, **_kwargs):
            raise TimeoutError("offline simulated timeout")

    runtime.client = SimpleNamespace(messages=FailingMessages())
    with pytest.raises(TimeoutError):
        await runtime.run(
            agent="supervisor",
            model=settings.supervisor_model,
            system="test",
            user_content="test",
            tools=[],
            handlers={},
        )
    row = next(iter(store.calls.values()))
    assert row["status"] == "AMBIGUOUS"
    assert store.actual == row["reserved_cost_usd"]
