#!/usr/bin/env python3
"""Emit one synthetic investigation trace with mocked model calls to local Phoenix."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import NAMESPACE_URL, uuid5

from fraud_agents.anthropic_runtime import CostController
from fraud_agents.config import Settings
from fraud_agents.schemas import InvestigationInput
from fraud_agents.supervisor import Supervisor
from fraud_agents.telemetry import Telemetry


class FakeBlock:
    def __init__(self, value: dict[str, object]):
        self.value = value

    def model_dump(self, mode: str = "json") -> dict[str, object]:
        return self.value


class MockAnthropicMessages:
    """Deterministic model/tool conversation; never opens a network connection."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.calls: dict[str, int] = {}

    async def create(self, **request):
        model = str(request["model"])
        sequence = self.calls.get(model, 0) + 1
        self.calls[model] = sequence
        transaction_id = "phoenix-smoke-synthetic-001"
        if model == self.settings.supervisor_model:
            content = self._supervisor(sequence, transaction_id)
        elif model == self.settings.geo_model:
            # Geo and Action intentionally share Haiku, so their tool registry identifies the role.
            tool_names = {tool["name"] for tool in request["tools"]}
            content = self._specialist(sequence, transaction_id, tool_names)
        else:
            content = self._specialist(sequence, transaction_id, {"get_canonical_behaviour_evidence"})
        return SimpleNamespace(
            usage=SimpleNamespace(input_tokens=100 + sequence, output_tokens=20),
            content=[FakeBlock(item) for item in content],
        )

    @staticmethod
    def _supervisor(sequence: int, transaction_id: str) -> list[dict[str, object]]:
        if sequence == 1:
            return [
                {
                    "type": "tool_use",
                    "id": "supervisor-geo",
                    "name": "run_geo_investigation",
                    "input": {"transaction_id": transaction_id},
                },
                {
                    "type": "tool_use",
                    "id": "supervisor-behaviour",
                    "name": "run_behaviour_investigation",
                    "input": {"transaction_id": transaction_id},
                },
            ]
        if sequence == 2:
            return [
                {
                    "type": "tool_use",
                    "id": "supervisor-action",
                    "name": "run_action_policy",
                    "input": {"transaction_id": transaction_id},
                }
            ]
        return [{"type": "text", "text": "Synthetic investigation complete."}]

    @staticmethod
    def _specialist(
        sequence: int, transaction_id: str, tool_names: set[str]
    ) -> list[dict[str, object]]:
        # Each specialist's own message list reveals whether it has already returned a tool result;
        # shared-model sequence numbers do not, so choose tool use only on odd calls for Haiku.
        tool = next(iter(tool_names))
        should_call_tool = sequence == 1 or (tool == "apply_decision_rules" and sequence == 3)
        if should_call_tool:
            tool_input: dict[str, object] = {"transaction_id": transaction_id}
            if tool == "apply_decision_rules":
                investigation_id = uuid5(NAMESPACE_URL, f"fraud-demo:{transaction_id}")
                tool_input["investigation_id"] = str(investigation_id)
            return [
                {
                    "type": "tool_use",
                    "id": f"{tool}-mock",
                    "name": tool,
                    "input": tool_input,
                }
            ]
        return [{"type": "text", "text": "Synthetic evidence interpreted."}]


async def run(endpoint: str) -> dict[str, object]:
    fixture = Path(__file__).parents[1] / "fixtures" / "combined.json"
    event = InvestigationInput.model_validate_json(fixture.read_text())
    event.flink.transaction_id = "phoenix-smoke-synthetic-001"
    event.flink.signal_ids = [
        f"txn:{event.flink.transaction_id}:{signal}" for signal in event.flink.signals
    ]
    investigation_id = uuid5(NAMESPACE_URL, f"fraud-demo:{event.flink.transaction_id}")
    settings = Settings(
        agent_mode="live",
        api_key="offline-mock-key",
        max_output_tokens=64,
        otel_enabled=True,
        otel_exporter_otlp_endpoint=endpoint,
        otel_service_name="fraud-investigation-smoke",
        phoenix_project_name="fraud-investigations",
        otel_capture_synthetic_content=False,
    )
    telemetry = Telemetry.from_settings(settings)
    supervisor = Supervisor(
        settings,
        costs=CostController(settings.max_cost_usd, settings.pricing),
        telemetry=telemetry,
    )
    assert supervisor.runtime is not None
    mock_messages = MockAnthropicMessages(settings)
    supervisor.runtime.client = SimpleNamespace(messages=mock_messages)
    result = await supervisor.investigate(
        event, investigation_id=investigation_id
    )
    exported = telemetry.force_flush()
    return {
        "investigation_id": str(investigation_id),
        "transaction_id": event.flink.transaction_id,
        "recommendation": result.recommendation.verdict.value,
        "model_calls": len(result.audit.model_usage),
        "mock_sdk_calls": sum(mock_messages.calls.values()),
        "estimated_cost_usd": result.audit.estimated_api_cost_usd,
        "telemetry_flush_succeeded": exported,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--endpoint", default="http://127.0.0.1:6006/v1/traces", help="OTLP/HTTP traces endpoint"
    )
    args = parser.parse_args()
    print(json.dumps(asyncio.run(run(args.endpoint)), sort_keys=True))


if __name__ == "__main__":
    main()
