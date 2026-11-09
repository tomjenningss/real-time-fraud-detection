from __future__ import annotations

from dataclasses import dataclass, replace

from .schemas import FlinkEvidence, Verdict

POLICY_VERSION = "fast-path-policy/1.1.0"
SLOW_BUILDING_DEMO_POLICY_VERSION = "fast-path-policy/1.2.0-slow-building-demo"
NEW_BENEFICIARY_HIGH_VALUE_RULE = "FP-CHALLENGE-NEW-BENEFICIARY-HIGH-VALUE/1.0.0"
SLOW_BUILDING_BENEFICIARY_RULE = "FP-DEMO-CHALLENGE-SLOW-BUILDING-BENEFICIARY/1.0.0"


@dataclass(frozen=True)
class FastPathResult:
    payment_verdict: Verdict
    investigation_required: bool
    investigation_reason: str | None
    triggered_rule_ids: tuple[str, ...]
    policy_version: str = POLICY_VERSION
    baseline_policy_version: str | None = None
    baseline_payment_verdict: Verdict | None = None


def decide(
    evidence: FlinkEvidence,
    *,
    sample_normal: bool = False,
    slow_building_demo_policy_enabled: bool = False,
) -> FastPathResult:
    """Deterministic demonstration policy; thresholds originate in Flink, not industry guidance."""
    signals = set(evidence.signals)
    demo_policy = slow_building_demo_policy_enabled and evidence.assessment_stream == "slow-building-replay"
    result = _decide_signals(
        signals,
        sample_normal=sample_normal,
        allow_slow_building=demo_policy,
        policy_version=SLOW_BUILDING_DEMO_POLICY_VERSION if demo_policy else POLICY_VERSION,
    )
    if not demo_policy:
        return result
    baseline = _decide_signals(
        signals,
        sample_normal=sample_normal,
        allow_slow_building=False,
        policy_version=POLICY_VERSION,
    )
    return replace(
        result,
        baseline_policy_version=baseline.policy_version,
        baseline_payment_verdict=baseline.payment_verdict,
    )


def _decide_signals(
    signals: set[str],
    *,
    sample_normal: bool,
    allow_slow_building: bool,
    policy_version: str,
) -> FastPathResult:
    velocity = "HIGH_VELOCITY" in signals
    hopping = "MERCHANT_HOPPING" in signals
    new_beneficiary_high_value = "NEW_BENEFICIARY_HIGH_VALUE" in signals
    slow_building = "SLOW_BUILDING_BENEFICIARY_RISK" in signals
    if velocity and hopping:
        return FastPathResult(
            Verdict.BLOCKED,
            True,
            "HIGH_VELOCITY_AND_MERCHANT_HOPPING",
            ("FP-BLOCK-VELOCITY-HOPPING",),
            policy_version,
        )
    if hopping:
        return FastPathResult(
            Verdict.CHALLENGED, True, "MERCHANT_HOPPING", ("FP-CHALLENGE-HOPPING",), policy_version
        )
    if new_beneficiary_high_value:
        return FastPathResult(
            Verdict.CHALLENGED,
            True,
            "NEW_BENEFICIARY_HIGH_VALUE",
            (NEW_BENEFICIARY_HIGH_VALUE_RULE,),
            policy_version,
        )
    if velocity:
        return FastPathResult(
            Verdict.CHALLENGED, True, "HIGH_VELOCITY", ("FP-CHALLENGE-VELOCITY",), policy_version
        )
    if slow_building and allow_slow_building:
        return FastPathResult(
            Verdict.CHALLENGED,
            True,
            "SLOW_BUILDING_BENEFICIARY_RISK",
            (SLOW_BUILDING_BENEFICIARY_RULE,),
            policy_version,
        )
    return FastPathResult(
        Verdict.APPROVED,
        sample_normal,
        "POLICY_SAMPLE" if sample_normal else None,
        ("FP-APPROVE-NO-SIGNAL",),
        policy_version,
    )
