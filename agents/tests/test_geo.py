import pytest

from fraud_agents.schemas import EvidenceStatus, RiskLevel
from fraud_agents.tools import check_geo_distance


def test_nearby_card_present_distance_is_low():
    result = check_geo_distance(51.5074, -0.1278, 51.5100, -0.1300, "CARD_PRESENT")
    assert result.status == EvidenceStatus.AVAILABLE
    assert result.risk_level == RiskLevel.LOW
    assert result.distance_km is not None and result.distance_km < 1


def test_significant_geographic_anomaly():
    result = check_geo_distance(51.5074, -0.1278, 48.8566, 2.3522, "CARD_PRESENT")
    assert result.risk_level == RiskLevel.HIGH
    assert result.distance_km is not None and result.distance_km > 300


def test_missing_gps_is_unknown():
    result = check_geo_distance(None, None, 51.5, -0.1, "CARD_PRESENT")
    assert result.status == EvidenceStatus.UNKNOWN
    assert result.distance_km is None


def test_ecommerce_is_not_applicable():
    result = check_geo_distance(None, None, None, None, "ECOMMERCE")
    assert result.status == EvidenceStatus.NOT_APPLICABLE
    assert result.applicable is False


@pytest.mark.parametrize("coordinates", [(91, 0, 0, 0), (0, 181, 0, 0)])
def test_malformed_tool_arguments_are_rejected(coordinates):
    with pytest.raises(ValueError):
        check_geo_distance(*coordinates, "CARD_PRESENT")
