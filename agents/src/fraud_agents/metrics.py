from __future__ import annotations

import math
from collections import deque


class LatencyWindow:
    def __init__(self, size: int = 1000):
        self.values: deque[float] = deque(maxlen=size)

    def observe(self, milliseconds: float) -> None:
        self.values.append(max(0.0, milliseconds))

    def snapshot(self) -> dict[str, float | int]:
        ordered = sorted(self.values)
        if not ordered:
            return {"count": 0, "p50_ms": 0.0, "p95_ms": 0.0, "p99_ms": 0.0}

        def percentile(value: float) -> float:
            index = max(0, math.ceil(value * len(ordered)) - 1)
            return round(ordered[index], 3)

        return {
            "count": len(ordered),
            "p50_ms": percentile(0.50),
            "p95_ms": percentile(0.95),
            "p99_ms": percentile(0.99),
        }
