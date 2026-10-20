from __future__ import annotations

from dataclasses import dataclass

from .schemas import FlinkEvidence, Verdict

POLICY_VERSION = "fast-path-policy/1.0.0"


@dataclass(frozen=True)
class FastPathResult:
    payment_verdict: Verdict
    investigation_required: bool
    investigation_reason: str | None
    triggered_rule_ids: tuple[str, ...]
    policy_version: str = POLICY_VERSION


def decide(evidence: FlinkEvidence, *, sample_normal: bool = False) -> FastPathResult:
    """Deterministic demonstration policy; thresholds originate in Flink, not industry guidance."""
    signals = set(evidence.signals)
    velocity = "HIGH_VELOCITY" in signals
    hopping = "MERCHANT_HOPPING" in signals
    if velocity and hopping:
        return FastPathResult(
            Verdict.BLOCKED,
            True,
            "HIGH_VELOCITY_AND_MERCHANT_HOPPING",
            ("FP-BLOCK-VELOCITY-HOPPING",),
        )
    if hopping:
        return FastPathResult(Verdict.CHALLENGED, True, "MERCHANT_HOPPING", ("FP-CHALLENGE-HOPPING",))
    if velocity:
        return FastPathResult(Verdict.CHALLENGED, True, "HIGH_VELOCITY", ("FP-CHALLENGE-VELOCITY",))
    return FastPathResult(
        Verdict.APPROVED,
        sample_normal,
        "POLICY_SAMPLE" if sample_normal else None,
        ("FP-APPROVE-NO-SIGNAL",),
    )
