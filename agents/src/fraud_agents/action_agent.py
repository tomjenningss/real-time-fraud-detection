from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from .anthropic_runtime import AgentLoopResult, AnthropicToolRuntime
from .config import Settings
from .evidence import EvidenceRepository
from .policy_engine import apply_decision_rules
from .schemas import EvidenceReference, PolicyResult


class ActionToolInput(BaseModel):
    transaction_id: str
    investigation_id: str


ACTION_TOOL = {
    "name": "apply_decision_rules",
    "description": "Run the authoritative deterministic policy using a canonical evidence reference.",
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "transaction_id": {"type": "string"},
            "investigation_id": {"type": "string", "format": "uuid"},
        },
        "required": ["transaction_id", "investigation_id"],
    },
}


class ActionAgent:
    def __init__(
        self,
        settings: Settings,
        repository: EvidenceRepository,
        runtime: AnthropicToolRuntime | None = None,
    ):
        self.settings, self.repository, self.runtime = settings, repository, runtime

    async def decide(self, reference: EvidenceReference) -> tuple[PolicyResult, AgentLoopResult | None]:
        authoritative = apply_decision_rules(reference.transaction_id, reference, self.repository)
        if self.settings.agent_mode == "dry-run":
            return authoritative, None
        if self.runtime is None:
            raise RuntimeError("live Action Agent requires Anthropic runtime")
        observed: PolicyResult | None = None

        async def tool_handler(arguments: dict[str, Any]) -> dict[str, Any]:
            nonlocal observed
            parsed = ActionToolInput.model_validate(arguments)
            candidate = EvidenceReference.model_validate(
                {
                    "investigation_id": parsed.investigation_id,
                    "transaction_id": parsed.transaction_id,
                }
            )
            if candidate != reference:
                raise ValueError("canonical evidence reference mismatch")
            observed = apply_decision_rules(parsed.transaction_id, candidate, self.repository)
            return {**observed.model_dump(mode="json"), "_audit_source": "policy_engine"}

        run = await self.runtime.run(
            agent="action",
            model=self.settings.action_model,
            system=(
                "You are the Action Agent. You must call apply_decision_rules exactly once. "
                "Only the tool can decide APPROVED, CHALLENGED, or BLOCKED. You cannot override it. "
                "After it runs, briefly restate its deterministic reason."
            ),
            user_content=(
                f"Apply policy for transaction {reference.transaction_id} using investigation "
                f"{reference.investigation_id}."
            ),
            tools=[ACTION_TOOL],
            handlers={"apply_decision_rules": tool_handler},
        )
        if observed is None or "apply_decision_rules" not in run.called_tools:
            raise RuntimeError("Action Agent did not invoke deterministic policy")
        # Re-evaluate and compare so a model/tool-loop mutation cannot alter the result.
        verified = apply_decision_rules(reference.transaction_id, reference, self.repository)
        if observed != verified or authoritative != verified:
            raise RuntimeError("policy result consistency check failed")
        return verified, run
