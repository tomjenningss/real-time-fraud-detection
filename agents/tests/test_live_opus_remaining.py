import importlib.util
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "run_live_opus_remaining",
    Path(__file__).parents[1] / "scripts" / "run_live_opus_remaining.py",
)
assert _SPEC and _SPEC.loader
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)


def test_remaining_dataset_is_exact_complement_of_pilot() -> None:
    dataset = _MODULE.selected_dataset()

    assert len(dataset.cases) == 24
    assert not ({case.case_id for case in dataset.cases} & _MODULE.PILOT_CASES)


def test_remaining_experiment_resume_states_fail_closed() -> None:
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
    assert _MODULE.resume_disposition({**complete, "allocation_status": "FAILED"}) == "FAILED"
