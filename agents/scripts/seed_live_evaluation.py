#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import os
from datetime import UTC, datetime

from fraud_agents.database import FraudStore
from fraud_agents.evaluation_scenarios import live_evaluation_scenarios
from fraud_agents.events import KafkaPosition, SourcePosition, build_decision
from fraud_agents.fast_path_policy import decide

parser = argparse.ArgumentParser()
parser.add_argument("--approve-seed", action="store_true")
args = parser.parse_args()
if not args.approve_seed:
    raise SystemExit("--approve-seed is required; no records were written")
database_url = os.getenv("DATABASE_URL")
if not database_url:
    raise SystemExit("DATABASE_URL is required")

store = FraudStore(database_url)
for offset, (name, event, expected, rule) in enumerate(live_evaluation_scenarios()):
    source = SourcePosition(topic="live-evaluation.scenario", partition=0, offset=offset)
    now = datetime.now(UTC)
    decision, request = build_decision(
        event.flink, decide(event.flink, sample_normal=True), source, now, now
    )
    if request is None:
        raise RuntimeError(f"scenario {name} was not routed")
    raw = event.flink.model_dump_json().encode()
    store.record_router_result(
        position=KafkaPosition(source.topic, source.partition, source.offset),
        payload_sha256=hashlib.sha256(raw).hexdigest(),
        decision=decision,
        request=request,
    )
    store.record_investigation_context(
        request.investigation_id,
        event.context,
        event.historical,
        provenance=f"synthetic-live-evaluation:{name}:expected={expected.value}:rule={rule}",
    )
print("seeded=5 live_calls=0")
