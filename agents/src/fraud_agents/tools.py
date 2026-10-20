from __future__ import annotations

from math import asin, cos, radians, sin, sqrt

from .schemas import EvidenceStatus, GeoToolResult, RiskLevel


def check_geo_distance(
    device_lat: float | None,
    device_lon: float | None,
    merchant_lat: float | None,
    merchant_lon: float | None,
    payment_channel: str = "UNKNOWN",
) -> GeoToolResult:
    """Calculate authoritative great-circle distance; Claude never supplies the result."""
    if payment_channel == "ECOMMERCE":
        return GeoToolResult(
            distance_km=None,
            risk_level=RiskLevel.LOW,
            applicable=False,
            status=EvidenceStatus.NOT_APPLICABLE,
            confidence="HIGH",
            explanation="Merchant distance is not applicable to an e-commerce transaction.",
        )
    coordinates = (device_lat, device_lon, merchant_lat, merchant_lon)
    if any(value is None for value in coordinates):
        return GeoToolResult(
            distance_km=None,
            risk_level=RiskLevel.UNKNOWN,
            applicable=True,
            status=EvidenceStatus.UNKNOWN,
            confidence="NONE",
            explanation="One or more required GPS coordinates are missing.",
        )
    assert all(value is not None for value in coordinates)
    if not (-90 <= device_lat <= 90 and -90 <= merchant_lat <= 90):
        raise ValueError("latitude must be between -90 and 90")
    if not (-180 <= device_lon <= 180 and -180 <= merchant_lon <= 180):
        raise ValueError("longitude must be between -180 and 180")
    lat1, lon1, lat2, lon2 = map(radians, coordinates)
    dlat, dlon = lat2 - lat1, lon2 - lon1
    hav = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    distance = 2 * 6371.0088 * asin(sqrt(hav))
    rounded = round(distance, 3)
    risk = RiskLevel.HIGH if distance >= 100 else RiskLevel.MEDIUM if distance >= 25 else RiskLevel.LOW
    return GeoToolResult(
        distance_km=rounded,
        risk_level=risk,
        applicable=True,
        status=EvidenceStatus.AVAILABLE,
        confidence="HIGH",
        explanation=f"Deterministic Haversine distance is {rounded:.3f} km.",
    )
