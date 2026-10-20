from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

import pytest

from fraud_agents.anthropic_runtime import AnthropicToolRuntime, CostController
from fraud_agents.config import Settings


class FakeBlock:
    def __init__(self, value):
        self.value = value

    def model_dump(self, mode="json"):
        return self.value


class FakeMessages:
    def __init__(self):
        self.calls = []
        self.responses = [
            SimpleNamespace(
                usage=SimpleNamespace(input_tokens=100, output_tokens=20),
                content=[
                    FakeBlock(
                        {
                            "type": "tool_use",
                            "id": "tool-1",
                            "name": "lookup",
                            "input": {"transaction_id": "tx-1"},
                        }
                    )
                ],
            ),
            SimpleNamespace(
                usage=SimpleNamespace(input_tokens=130, output_tokens=15),
                content=[FakeBlock({"type": "text", "text": "Evidence reviewed."})],
            ),
        ]

    async def create(self, **kwargs):
        self.calls.append(deepcopy(kwargs))
        return self.responses.pop(0)


@pytest.mark.asyncio
async def test_official_sdk_style_tool_loop_tracks_usage_without_network():
    settings = Settings(agent_mode="live", api_key="test-key", max_output_tokens=64)
    runtime = AnthropicToolRuntime(settings, CostController(1.0, settings.pricing))
    fake = FakeMessages()
    runtime.client = SimpleNamespace(messages=fake)

    async def handler(arguments):
        assert arguments == {"transaction_id": "tx-1"}
        return {"status": "AVAILABLE", "_audit_source": "canonical_fixture"}

    result = await runtime.run(
        agent="test-agent",
        model=settings.geo_model,
        system="Use the tool.",
        user_content="Investigate tx-1.",
        tools=[{"name": "lookup", "description": "lookup", "input_schema": {"type": "object"}}],
        handlers={"lookup": handler},
    )
    assert result.called_tools == {"lookup"}
    assert result.final_text == "Evidence reviewed."
    assert sum(item.input_tokens for item in result.usages) == 230
    assert len(fake.calls) == 2
    tool_result = fake.calls[1]["messages"][-1]["content"][0]
    assert tool_result["type"] == "tool_result"
    assert result.tool_audits[0].source == "canonical_fixture"
