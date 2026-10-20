from __future__ import annotations

from .evidence import EvidenceRepository
from .schemas import EvidenceReference, EvidenceStatus, PolicyResult, RiskLevel, Verdict

POLICY_VERSION = "investigation-policy/1.0.0"


def apply_decision_rules(
    transaction_id: str,
    evidence_reference: EvidenceReference,
    repository: EvidenceRepository,
) -> PolicyResult:
    """Deterministic investigation recommendation; never mutates payment authority."""
    bundle = repository.get(evidence_reference)
    if transaction_id != bundle.transaction_id:
        raise ValueError("transaction_id does not match canonical evidence")

    geo, behaviour = bundle.geo, bundle.behaviour
    rules: list[str] = []
    failures = {EvidenceStatus.FAILED, EvidenceStatus.UNKNOWN, EvidenceStatus.CONFLICTING}
    if geo.status in failures or behaviour.status in failures:
        rules.append("POL-FAILSAFE-INCOMPLETE-EVIDENCE")
        return _result(
            transaction_id,
            Verdict.CHALLENGED,
            rules,
            "Required investigation evidence is missing, conflicting, or unavailable.",
        )

    signals = set(behaviour.canonical.signals)
    geo_high = geo.canonical.applicable and geo.canonical.risk_level == RiskLevel.HIGH
    velocity = "HIGH_VELOCITY" in signals
    hopping = "MERCHANT_HOPPING" in signals

    if geo_high and velocity and hopping:
        rules.append("POL-BLOCK-COMBINED-GEO-VELOCITY-HOPPING")
        return _result(
            transaction_id,
            Verdict.BLOCKED,
            rules,
            "Deterministic policy found combined geographic, velocity, and merchant-hopping risk.",
        )
    if geo_high and (velocity or hopping):
        rules.append("POL-BLOCK-COMBINED-GEO-BEHAVIOUR")
        return _result(
            transaction_id,
            Verdict.BLOCKED,
            rules,
            "Deterministic policy found both geographic and behavioural anomalies.",
        )
    if geo_high:
        rules.append("POL-CHALLENGE-GEO")
        return _result(
            transaction_id,
            Verdict.CHALLENGED,
            rules,
            "Deterministic policy found a significant card-present geographic anomaly.",
        )
    if velocity and hopping:
        rules.append("POL-CHALLENGE-VELOCITY-HOPPING")
        return _result(
            transaction_id,
            Verdict.CHALLENGED,
            rules,
            "Deterministic policy found high velocity across multiple merchants.",
        )
    if velocity:
        rules.append("POL-CHALLENGE-VELOCITY")
        return _result(
            transaction_id, Verdict.CHALLENGED, rules, "Deterministic policy found high transaction velocity."
        )
    rules.append("POL-APPROVE-NO-QUALIFYING-RISK")
    return _result(
        transaction_id, Verdict.APPROVED, rules, "No qualifying deterministic fraud rule was triggered."
    )


def _result(transaction_id: str, verdict: Verdict, rules: list[str], reason: str) -> PolicyResult:
    return PolicyResult(
        transaction_id=transaction_id,
        verdict=verdict,
        triggered_rule_ids=rules,
        policy_version=POLICY_VERSION,
        reason=reason,
    )
