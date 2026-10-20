import importlib.util
from pathlib import Path
from types import SimpleNamespace

_SPEC = importlib.util.spec_from_file_location(
    "run_live_evaluation_pilot",
    Path(__file__).parents[1] / "scripts" / "run_live_evaluation_pilot.py",
)
assert _SPEC and _SPEC.loader
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
_verify_phoenix_trace = _MODULE._verify_phoenix_trace
_resume_disposition = _MODULE._resume_disposition


class _Spans:
    def __init__(self, values):
        self.values = values

    def get_spans(self, **_kwargs):
        return self.values


def test_phoenix_trace_verifier_accepts_dictionary_spans() -> None:
    client = SimpleNamespace(
        spans=_Spans(
            [
                {"name": "supervisor agent"},
                {"name": "anthropic.messages claude-opus-5-5"},
                {"name": "tool run_geo_investigation"},
            ]
        )
    )
    settings = SimpleNamespace(phoenix_project_name="fraud-investigations")

    assert _verify_phoenix_trace(client, settings, "trace-id") == 3


def test_phoenix_trace_verifier_accepts_object_spans() -> None:
    client = SimpleNamespace(
        spans=_Spans(
            [
                SimpleNamespace(name="supervisor agent"),
                SimpleNamespace(name="anthropic.messages claude-opus-5-5"),
                SimpleNamespace(name="tool run_geo_investigation"),
            ]
        )
    )
    settings = SimpleNamespace(phoenix_project_name="fraud-investigations")

    assert _verify_phoenix_trace(client, settings, "trace-id") == 3


def test_resume_disposition_distinguishes_paid_states() -> None:
    assert _resume_disposition(None) == "NEW"
    completed = {
        "experiment_id": "part4b-live-opus-baseline-001",
        "allocation_status": "COMPLETED",
        "investigation_status": "COMPLETED",
        "attempt_status": "SUCCEEDED",
        "has_audit": True,
        "calls": 9,
        "succeeded": 9,
        "ambiguous": 0,
        "unsettled": 0,
    }
    assert _resume_disposition(completed) == "REUSE_COMPLETED"
    assert _resume_disposition({**completed, "ambiguous": 1}) == "AMBIGUOUS"
    assert _resume_disposition({**completed, "allocation_status": "FAILED"}) == "FAILED"
    assert _resume_disposition({**completed, "unsettled": 1}) == "PARTIAL"
    assert _resume_disposition({**completed, "experiment_id": "other"}) == "EXPERIMENT_MISMATCH"
