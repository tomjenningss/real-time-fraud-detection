#!/usr/bin/env python3
"""Create one fresh genuine Glaramara velocity challenge for an opt-in live Phase C check."""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import time
import urllib.request
import uuid
from typing import Any

from glaramara_smoke_test import call, require


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:13001")
    parser.add_argument("--timeout-seconds", type=float, default=120)
    parser.add_argument("--payment-count", type=int, default=5)
    args = parser.parse_args()
    require(args.payment_count >= 5, "velocity challenge probe needs at least five payments")
    base_url = args.base_url.rstrip("/")
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )

    session_status, _ = call(opener, base_url, "GET", "/api/v1/demo/session")
    dashboard_status, dashboard_before = call(opener, base_url, "GET", "/api/v1/dashboard")
    beneficiaries_status, beneficiaries = call(opener, base_url, "GET", "/api/v1/beneficiaries")
    require(session_status == 200, f"session bootstrap returned {session_status}")
    require(dashboard_status == 200, f"dashboard returned {dashboard_status}")
    require(beneficiaries_status == 200, f"beneficiaries returned {beneficiaries_status}")
    require(bool(beneficiaries.get("beneficiaries")), "demo customer has no beneficiary")

    run_id = uuid.uuid4().hex[:12]
    payment_ids: list[str] = []
    for sequence in range(1, args.payment_count + 1):
        status, body = call(
            opener,
            base_url,
            "POST",
            "/api/v1/payments",
            body={
                "beneficiaryId": beneficiaries["beneficiaries"][0]["id"],
                "amount": f"{20 + sequence}.17",
                "reference": f"C live {run_id} {sequence}",
            },
            headers={
                "Origin": base_url,
                "Idempotency-Key": f"phase-c-live-{run_id}-{sequence}",
            },
        )
        require(status == 202, f"payment {sequence} submission returned {status}: {body}")
        payment_ids.append(body["payment"]["id"])

    deadline = time.monotonic() + args.timeout_seconds
    terminal: dict[str, dict[str, Any]] = {}
    while time.monotonic() < deadline and len(terminal) < len(payment_ids):
        for payment_id in payment_ids:
            if payment_id in terminal:
                continue
            status, body = call(opener, base_url, "GET", f"/api/v1/payments/{payment_id}")
            require(status == 200, f"payment status returned {status}")
            if body["payment"]["status"] != "PENDING":
                terminal[payment_id] = body["payment"]
        if len(terminal) < len(payment_ids):
            time.sleep(1)

    require(len(terminal) == len(payment_ids), "velocity challenge payments did not finish")
    challenged = [item for item in terminal.values() if item["status"] == "CHALLENGED"]
    require(bool(challenged), f"no genuine challenge observed: {[item['status'] for item in terminal.values()]}")
    challenge = challenged[0]
    decision = challenge.get("authoritativeDecision") or {}
    require(decision.get("source") == "deterministic_fast_path", "challenge used the wrong authority")
    require(decision.get("policyVersion") == "fast-path-policy/1.0.0", "challenge used the wrong policy")

    after_status, dashboard_after = call(opener, base_url, "GET", "/api/v1/dashboard")
    require(after_status == 200, f"final dashboard returned {after_status}")
    require(
        dashboard_after["account"]["availableBalance"]
        == dashboard_before["account"]["availableBalance"],
        "fictional balance changed while creating the challenge",
    )
    print(json.dumps({
        "event": "glaramara_phase_c_live_challenge_ready",
        "payment_id": challenge["id"],
        "transaction_id": challenge["transactionId"],
        "authoritative_status": challenge["status"],
        "policy_version": decision["policyVersion"],
        "triggered_rule_ids": decision.get("triggeredRuleIds", []),
        "all_statuses": [terminal[payment_id]["status"] for payment_id in payment_ids],
        "available_balance": dashboard_after["account"]["availableBalance"],
    }, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
