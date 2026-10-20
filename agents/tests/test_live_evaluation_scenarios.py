import pytest

from fraud_agents.evaluation_scenarios import live_evaluation_scenarios
from fraud_agents.supervisor import Supervisor


@pytest.mark.asyncio
async def test_five_reproducible_scenarios_match_deterministic_expected_outcomes(dry_settings):
    scenarios = live_evaluation_scenarios()
    assert len(scenarios) == 5
    assert len({event.flink.transaction_id for _, event, _, _ in scenarios}) == 5
    for _name, event, expected_verdict, expected_rule in scenarios:
        result = await Supervisor(dry_settings).investigate(event)
        assert result.recommendation.verdict == expected_verdict
        assert result.audit.triggered_rules == [expected_rule]
