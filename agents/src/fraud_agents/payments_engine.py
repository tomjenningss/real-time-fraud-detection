from __future__ import annotations

from typing import Protocol

from .schemas import HistoricalEvidence


class PaymentsEngineClient(Protocol):
    """Future HTTP boundary; implementations must validate responses before use."""

    async def get_transaction_velocity(self, transaction_id: str) -> dict[str, object]:
        """GET /v1/transactions/{transaction_id}/velocity (future Java endpoint)."""
        ...

    async def get_historical_spending_anomaly(self, user_id: str) -> HistoricalEvidence:
        """GET /v1/users/{user_id}/spending-anomaly (future Java endpoint)."""
        ...


class DisabledPaymentsEngineClient:
    async def get_transaction_velocity(self, transaction_id: str) -> dict[str, object]:
        raise RuntimeError("live Payments Engine integration is not enabled")

    async def get_historical_spending_anomaly(self, user_id: str) -> HistoricalEvidence:
        raise RuntimeError("live Payments Engine integration is not enabled")
