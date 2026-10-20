from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime

from .schemas import InvestigationInput, Verdict

FIXED_TIME = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)


def _scenario(name: str, signals: list[str], merchants: int, context: dict) -> InvestigationInput:
    tx = f"live-eval-{name}-001"
    count = 6 if signals else 2
    payload = {
        "flink": {
            "assessment_type": "transaction",
            "transaction_id": tx,
            "user_id": f"live-eval-user-{name}",
            "amount": 75.0,
            "merchant_id": f"live-eval-merchant-{name}",
            "transaction_timestamp": FIXED_TIME,
            "transactions_1m": count,
            "transactions_2m": count,
            "transactions_10m": count,
            "distinct_merchants_2m": merchants,
            "total_amount_2m": 450.0 if signals else 150.0,
            "signals": signals,
            "signal_ids": [f"txn:{tx}:{signal}" for signal in signals],
            "risk_level": "HIGH" if signals else "LOW",
            "assessment_timestamp": FIXED_TIME,
            "evidence_source": "flink",
        },
        "context": context,
    }
    return InvestigationInput.model_validate(payload)


def live_evaluation_scenarios() -> list[tuple[str, InvestigationInput, Verdict, str]]:
    london = {"payment_channel": "CARD_PRESENT", "device_lat": 51.5074, "device_lon": -0.1278,
              "merchant_lat": 51.5100, "merchant_lon": -0.1300, "metadata": {}}
    paris = {**deepcopy(london), "merchant_lat": 48.8566, "merchant_lon": 2.3522}
    missing = {"payment_channel": "CARD_PRESENT", "device_lat": None, "device_lon": None,
               "merchant_lat": None, "merchant_lon": None, "metadata": {}}
    return [
        ("velocity-local", _scenario("velocity-local", ["HIGH_VELOCITY"], 1, london),
         Verdict.CHALLENGED, "POL-CHALLENGE-VELOCITY"),
        ("combined-far", _scenario("combined-far", ["HIGH_VELOCITY", "MERCHANT_HOPPING"], 6, paris),
         Verdict.BLOCKED, "POL-BLOCK-COMBINED-GEO-VELOCITY-HOPPING"),
        ("combined-local", _scenario("combined-local", ["HIGH_VELOCITY", "MERCHANT_HOPPING"], 6, london),
         Verdict.CHALLENGED, "POL-CHALLENGE-VELOCITY-HOPPING"),
        ("normal-far", _scenario("normal-far", [], 2, paris),
         Verdict.CHALLENGED, "POL-CHALLENGE-GEO"),
        ("velocity-missing-geo", _scenario("velocity-missing-geo", ["HIGH_VELOCITY"], 1, missing),
         Verdict.CHALLENGED, "POL-FAILSAFE-INCOMPLETE-EVIDENCE"),
    ]
