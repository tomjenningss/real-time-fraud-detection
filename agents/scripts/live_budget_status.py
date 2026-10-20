#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from datetime import date, datetime
from decimal import Decimal

from fraud_agents.database import FraudStore


def encode(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    raise TypeError(type(value).__name__)


database_url = os.getenv("DATABASE_URL")
experiment_id = os.getenv("LIVE_EXPERIMENT_ID", "part3-live-eval-001")
if not database_url:
    raise SystemExit("DATABASE_URL is required")
print(json.dumps(FraudStore(database_url).live_budget_status(experiment_id), default=encode, sort_keys=True))
