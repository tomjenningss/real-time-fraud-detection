import importlib.util
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "run_live_sonnet_comparison",
    Path(__file__).parents[1] / "scripts" / "run_live_sonnet_comparison.py",
)
assert _SPEC and _SPEC.loader
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)


def test_sonnet_override_is_isolated_to_supervisor() -> None:
    settings = _MODULE.live_settings()

    assert settings.models == {
        "supervisor": "claude-sonnet-5-5",
        "behaviour": "claude-sonnet-5-5",
        "geo": "claude-haiku-5-5",
        "action": "claude-haiku-5-5",
    }
    assert settings.live_experiment_id == "part4b-live-sonnet-supervisor-30-001"
    assert settings.live_budget_usd == 6.5
    assert settings.live_max_investigations == 30


def test_sonnet_resume_states_never_retry_ambiguous_or_partial() -> None:
    complete = {
        "experiment_id": _MODULE.EXPERIMENT_ID,
        "allocation_status": "COMPLETED",
        "investigation_status": "COMPLETED",
        "attempt_status": "SUCCEEDED",
        "has_audit": True,
        "calls": 9,
        "succeeded": 9,
        "ambiguous": 0,
        "unsettled": 0,
    }
    assert _MODULE.resume_disposition(None) == "NEW"
    assert _MODULE.resume_disposition(complete) == "REUSE_COMPLETED"
    assert _MODULE.resume_disposition({**complete, "ambiguous": 1}) == "AMBIGUOUS"
    assert _MODULE.resume_disposition({**complete, "unsettled": 1}) == "PARTIAL"
