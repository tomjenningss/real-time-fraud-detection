#!/usr/bin/env python3
"""Bounded Glaramara Phase B acceptance probe; publishes one simulated payment."""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import time
import urllib.error
import urllib.request
import uuid
from typing import Any


def call(
    opener: urllib.request.OpenerDirector,
    base_url: str,
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, Any]]:
    payload = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=payload,
        method=method,
        headers={"Accept": "application/json", **(headers or {})},
    )
    if payload is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with opener.open(request, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:13000")
    parser.add_argument("--timeout-seconds", type=float, default=120)
    args = parser.parse_args()
    base_url = args.base_url.rstrip("/")
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )

    session_status, _session = call(opener, base_url, "GET", "/api/v1/demo/session")
    require(session_status == 200, f"session bootstrap returned {session_status}")
    dashboard_status, dashboard_before = call(opener, base_url, "GET", "/api/v1/dashboard")
    beneficiaries_status, beneficiaries = call(
        opener, base_url, "GET", "/api/v1/beneficiaries"
    )
    require(dashboard_status == 200, f"dashboard returned {dashboard_status}")
    require(beneficiaries_status == 200, f"beneficiaries returned {beneficiaries_status}")
    require(bool(beneficiaries.get("beneficiaries")), "demo customer has no beneficiary")

    idempotency_key = f"phase-b-smoke-{uuid.uuid4()}"
    payment_request = {
        "beneficiaryId": beneficiaries["beneficiaries"][0]["id"],
        "amount": "42.17",
        "reference": "Phase B smoke",
    }
    mutation_headers = {"Origin": base_url, "Idempotency-Key": idempotency_key}
    accepted_status, accepted = call(
        opener,
        base_url,
        "POST",
        "/api/v1/payments",
        body=payment_request,
        headers=mutation_headers,
    )
    require(accepted_status == 202, f"payment submission returned {accepted_status}: {accepted}")
    payment_id = accepted["payment"]["id"]
    require(accepted["payment"]["status"] == "PENDING", "new payment was not pending")

    replay_status, replay = call(
        opener,
        base_url,
        "POST",
        "/api/v1/payments",
        body=payment_request,
        headers=mutation_headers,
    )
    require(replay_status == 200, f"idempotent replay returned {replay_status}")
    require(replay.get("replayed") is True, "idempotent replay was not identified")
    require(replay["payment"]["id"] == payment_id, "idempotent replay changed payment identity")

    conflict_status, conflict = call(
        opener,
        base_url,
        "POST",
        "/api/v1/payments",
        body={**payment_request, "amount": "42.18"},
        headers=mutation_headers,
    )
    require(conflict_status == 409, f"idempotency conflict returned {conflict_status}")
    require(
        conflict.get("error", {}).get("code") == "IDEMPOTENCY_KEY_REUSED",
        "idempotency conflict returned the wrong error",
    )

    deadline = time.monotonic() + args.timeout_seconds
    final: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        status_code, status_body = call(
            opener, base_url, "GET", f"/api/v1/payments/{payment_id}"
        )
        require(status_code == 200, f"status endpoint returned {status_code}")
        final = status_body["payment"]
        if (
            final["status"] != "PENDING"
            and (final.get("experimentalShadow") or {}).get("status") == "EVALUATED"
        ):
            break
        time.sleep(1)
    require(final is not None and final["status"] != "PENDING", "authoritative verdict timed out")
    require(final["status"] == "APPROVED", f"unexpected deterministic verdict {final['status']}")
    decision = final.get("authoritativeDecision") or {}
    require(decision.get("source") == "deterministic_fast_path", "wrong decision authority")
    require(decision.get("policyVersion") == "fast-path-policy/1.0.0", "wrong policy version")
    shadow = final.get("experimentalShadow") or {}
    require(shadow.get("status") == "EVALUATED", "shadow evaluation timed out")
    require(shadow.get("originalPaymentVerdict") == final["status"], "shadow lost original verdict")
    require(str(shadow.get("modelVersion", "")).startswith("lgbm-baseline-"), "model provenance missing")
    require(shadow.get("featureSchemaVersion") == "fraud-features-1.0.0", "feature provenance missing")

    after_status, dashboard_after = call(opener, base_url, "GET", "/api/v1/dashboard")
    require(after_status == 200, f"final dashboard returned {after_status}")
    require(
        dashboard_after["account"]["availableBalance"]
        == dashboard_before["account"]["availableBalance"],
        "fictional balance changed",
    )

    print(
        json.dumps(
            {
                "event": "glaramara_phase_b_smoke_passed",
                "payment_id": payment_id,
                "transaction_id": final["transactionId"],
                "authoritative_status": final["status"],
                "policy_version": decision["policyVersion"],
                "correlation_revision": (final.get("correlation") or {}).get("revision"),
                "shadow_action": shadow.get("proposedAction"),
                "shadow_policy_version": shadow.get("policyVersion"),
                "model_version": shadow.get("modelVersion"),
                "balance_unchanged": True,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
