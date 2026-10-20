import json

import pytest
from pydantic import ValidationError

from fraud_agents.anthropic_runtime import CostController, CostLimitExceeded
from fraud_agents.audit import persist_audit
from fraud_agents.schemas import AuditRecord, InvestigationInput


def test_inconsistent_signal_ids_are_rejected(normal_dict):
    normal_dict["flink"]["signals"] = ["HIGH_VELOCITY"]
    normal_dict["flink"]["risk_level"] = "HIGH"
    with pytest.raises(ValidationError):
        InvestigationInput.model_validate(normal_dict)


@pytest.mark.asyncio
async def test_cost_limit_is_checked_before_call():
    controller = CostController(0.000001)
    with pytest.raises(CostLimitExceeded):
        await controller.reserve("claude-opus-5-5", 1000, 1024)


def test_audit_record_is_private_json(tmp_path):
    record = AuditRecord(transaction_id="audit-test", mode="dry-run", agent_models={})
    path = persist_audit(record, tmp_path / "audit_records")
    assert path.stat().st_mode & 0o777 == 0o600
    assert json.loads(path.read_text())["transaction_id"] == "audit-test"
