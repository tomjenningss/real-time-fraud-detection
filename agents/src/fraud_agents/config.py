from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel, Field, model_validator


class Settings(BaseModel):
    api_key: str | None = Field(default=None, repr=False)
    supervisor_model: str = "claude-opus-5-5"
    geo_model: str = "claude-haiku-5-5"
    behaviour_model: str = "claude-sonnet-5-5"
    action_model: str = "claude-haiku-5-5"
    agent_mode: str = "dry-run"
    max_tool_iterations: int = Field(default=6, ge=1, le=12)
    timeout_seconds: float = Field(default=30, gt=0, le=300)
    max_output_tokens: int = Field(default=1024, ge=64, le=8192)
    max_cost_usd: float = Field(default=0.20, gt=0, le=20)
    live_smoke_test_limit: int = Field(default=1, ge=1, le=10)
    live_experiment_id: str = "part3-live-eval-001"
    live_budget_gbp: float = Field(default=1.0, gt=0)
    live_usd_per_gbp: float = Field(default=1.30, gt=0)
    live_baseline_cost_usd: float = Field(default=0.0274, ge=0)
    live_max_investigations: int = Field(default=5, ge=1, le=10)
    live_investigation_reserve_usd: float = Field(default=0.20, gt=0)
    live_max_model_calls: int = Field(default=12, ge=1, le=100)
    live_remaining_call_reserve_usd: float = Field(default=0.005, gt=0)
    live_input_token_safety_multiplier: float = Field(default=1.5, ge=1, le=5)
    price_opus_input: float = Field(default=4.0, ge=0)
    price_opus_output: float = Field(default=20.0, ge=0)
    price_sonnet_input: float = Field(default=2.0, ge=0)
    price_sonnet_output: float = Field(default=10.0, ge=0)
    price_haiku_input: float = Field(default=0.10, ge=0)
    price_haiku_output: float = Field(default=0.50, ge=0)
    audit_enabled: bool = True
    audit_directory: Path = Path("audit_records")

    @model_validator(mode="after")
    def validate_mode(self) -> Settings:
        if self.agent_mode not in {"dry-run", "live"}:
            raise ValueError("AGENT_MODE must be dry-run or live")
        if self.agent_mode == "live" and not self.api_key:
            raise ValueError("ANTHROPIC_API_KEY is required in live mode")
        return self

    @property
    def models(self) -> dict[str, str]:
        return {
            "supervisor": self.supervisor_model,
            "geo": self.geo_model,
            "behaviour": self.behaviour_model,
            "action": self.action_model,
        }

    @property
    def pricing(self) -> dict[str, tuple[float, float]]:
        return {
            self.supervisor_model: (self.price_opus_input, self.price_opus_output),
            self.behaviour_model: (self.price_sonnet_input, self.price_sonnet_output),
            self.geo_model: (self.price_haiku_input, self.price_haiku_output),
            self.action_model: (self.price_haiku_input, self.price_haiku_output),
        }


def load_settings(env_file: Path | None = None, mode_override: str | None = None) -> Settings:
    path = env_file or Path(__file__).resolve().parents[2] / ".env"
    load_dotenv(path, override=False)
    raw = {
        "api_key": os.getenv("ANTHROPIC_API_KEY"),
        "supervisor_model": os.getenv("ANTHROPIC_SUPERVISOR_MODEL", "claude-opus-5-5"),
        "geo_model": os.getenv("ANTHROPIC_GEO_MODEL", "claude-haiku-5-5"),
        "behaviour_model": os.getenv("ANTHROPIC_BEHAVIOUR_MODEL", "claude-sonnet-5-5"),
        "action_model": os.getenv("ANTHROPIC_ACTION_MODEL", "claude-haiku-5-5"),
        "agent_mode": mode_override or os.getenv("AGENT_MODE", "dry-run"),
        "max_tool_iterations": os.getenv("MAX_TOOL_ITERATIONS", "6"),
        "timeout_seconds": os.getenv("AGENT_TIMEOUT_SECONDS", "30"),
        "max_output_tokens": os.getenv("MAX_OUTPUT_TOKENS", "1024"),
        "max_cost_usd": os.getenv("MAX_INVESTIGATION_COST_USD", "0.20"),
        "live_smoke_test_limit": os.getenv("LIVE_SMOKE_TEST_LIMIT", "1"),
        "live_experiment_id": os.getenv("LIVE_EXPERIMENT_ID", "part3-live-eval-001"),
        "live_budget_gbp": os.getenv("LIVE_EXPERIMENT_BUDGET_GBP", "1.00"),
        "live_usd_per_gbp": os.getenv("LIVE_USD_PER_GBP", "1.30"),
        "live_baseline_cost_usd": os.getenv("LIVE_BASELINE_COST_USD", "0.0274"),
        "live_max_investigations": os.getenv("LIVE_MAX_INVESTIGATIONS", "5"),
        "live_investigation_reserve_usd": os.getenv(
            "LIVE_INVESTIGATION_RESERVE_USD", "0.20"
        ),
        "live_max_model_calls": os.getenv("LIVE_MAX_MODEL_CALLS", "12"),
        "live_remaining_call_reserve_usd": os.getenv(
            "LIVE_REMAINING_CALL_RESERVE_USD", "0.005"
        ),
        "live_input_token_safety_multiplier": os.getenv(
            "LIVE_INPUT_TOKEN_SAFETY_MULTIPLIER", "1.5"
        ),
        "price_opus_input": os.getenv("PRICE_OPUS_INPUT_MTOK_USD", "4.00"),
        "price_opus_output": os.getenv("PRICE_OPUS_OUTPUT_MTOK_USD", "20.00"),
        "price_sonnet_input": os.getenv("PRICE_SONNET_INPUT_MTOK_USD", "2.00"),
        "price_sonnet_output": os.getenv("PRICE_SONNET_OUTPUT_MTOK_USD", "10.00"),
        "price_haiku_input": os.getenv("PRICE_HAIKU_INPUT_MTOK_USD", "0.10"),
        "price_haiku_output": os.getenv("PRICE_HAIKU_OUTPUT_MTOK_USD", "0.50"),
        "audit_enabled": os.getenv("AUDIT_ENABLED", "true").lower() == "true",
    }
    return Settings.model_validate(raw)
