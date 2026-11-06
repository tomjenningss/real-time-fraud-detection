#!/usr/bin/env python3
"""Run bounded live Fraud Rule Discovery reliability measurements without deploying rules."""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import math
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
    timeout: float = 75,
) -> tuple[int, dict[str, Any]]:
    payload = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
    request = urllib.request.Request(
        f"{base_url}{path}", data=payload, method=method, headers={"Accept": "application/json", **(headers or {})}
    )
    if payload is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.load(error)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return error.code, {"error": {"message": error.reason}}


def percentile_nearest_rank(values: list[int], fraction: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def main() -> None:
    parser = argparse.ArgumentParser(description="Measure 15 live Fraud Rule Discovery attempts.")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--attempts", type=int, default=15)
    args = parser.parse_args()
    if args.attempts < 1 or args.attempts > 15:
        raise SystemExit("--attempts must be between 1 and 15")
    base_url = args.base_url.rstrip("/")
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    origin_headers = {"Origin": base_url}
    session_status, session = call(
        opener, base_url, "POST", "/api/v1/demo/session",
        body={"customerId": "fraud-analyst-alex-morgan"}, headers=origin_headers,
    )
    if session_status != 200 or session.get("session", {}).get("role") != "FRAUD_ANALYST":
        raise SystemExit(f"analyst session failed: {session_status} {session}")
    dashboard_status, dashboard = call(opener, base_url, "GET", "/api/v1/fraud-operations")
    if dashboard_status != 200 or dashboard.get("dataset", {}).get("totalTransactions") != 20_000:
        raise SystemExit(f"active 20,000-row dataset unavailable: {dashboard_status} {dashboard}")
    original_dataset_id = dashboard.get("activeDatasetId")
    known_run_ids = {item.get("id") for item in dashboard.get("runs", [])}
    results: list[dict[str, Any]] = []
    for number in range(1, args.attempts + 1):
        started = time.monotonic()
        status, body = call(
            opener, base_url, "POST", "/api/v1/fraud-operations/analyses",
            headers={**origin_headers, "Idempotency-Key": f"reliability-{uuid.uuid4()}"},
        )
        elapsed_ms = round((time.monotonic() - started) * 1000)
        run = body.get("run") if isinstance(body, dict) else None
        if not isinstance(run, dict):
            _, after = call(opener, base_url, "GET", "/api/v1/fraud-operations")
            new_runs = [item for item in after.get("runs", []) if item.get("id") not in known_run_ids]
            run_id = new_runs[0].get("id") if new_runs else None
            known_run_ids.update(item.get("id") for item in new_runs)
            if run_id:
                _, detail = call(opener, base_url, "GET", f"/api/v1/fraud-operations/runs/{run_id}")
                run = detail.get("run") if isinstance(detail, dict) else None
        if isinstance(run, dict):
            known_run_ids.add(run.get("id"))
        diagnostics = (run or {}).get("diagnostics") or {}
        candidate = (run or {}).get("candidate") or {}
        structural_valid = bool(candidate) or diagnostics.get("validationStage") == "SEMANTIC"
        evidence_valid = bool(candidate)
        result = {
            "attempt": number,
            "httpStatus": status,
            "runId": (run or {}).get("id"),
            "runStatus": (run or {}).get("status"),
            "requestElapsedMs": elapsed_ms,
            "agentLatencyMs": ((run or {}).get("agent") or {}).get("latencyMs") or diagnostics.get("latencyMs"),
            "validationStage": diagnostics.get("validationStage"),
            "validationIssues": diagnostics.get("validationIssues", []),
            "evidenceReferenceFailures": diagnostics.get("evidenceReferenceFailures"),
            "supportingEvidenceRefsState": diagnostics.get("supportingEvidenceRefsState"),
            "structuralSchemaValid": structural_valid,
            "evidenceReferencesValid": evidence_valid,
            "proposalValid": bool(candidate),
            "backtestCompleted": bool((candidate.get("backtest") if isinstance(candidate, dict) else None)),
            "errorCode": (body.get("error") or {}).get("code") if isinstance(body, dict) else None,
            "errorType": (run or {}).get("errorType"),
        }
        results.append(result)
    _, final_dashboard = call(opener, base_url, "GET", "/api/v1/fraud-operations")
    final_dataset_unchanged = final_dashboard.get("activeDatasetId") == original_dataset_id and final_dashboard.get("dataset", {}).get("totalTransactions") == 20_000
    latencies = [item["agentLatencyMs"] for item in results if isinstance(item["agentLatencyMs"], int)]
    passed = [item for item in results if item["proposalValid"] and item["evidenceReferencesValid"] and item["backtestCompleted"]]
    breakdown = {
        "invocation": sum(item["validationStage"] == "INVOCATION" for item in results),
        "structural": sum(item["validationStage"] == "STRUCTURAL" for item in results),
        "semantic": sum(item["validationStage"] == "SEMANTIC" for item in results),
        "backtest": sum(item["proposalValid"] and item["evidenceReferencesValid"] and not item["backtestCompleted"] for item in results),
    }
    print(json.dumps({
        "attempts": results,
        "summary": {
            "attemptCount": len(results),
            "firstAttemptProposalValidityRate": len(passed) / len(results),
            "passedAllStages": len(passed),
            "failureBreakdown": breakdown,
            "agentLatencyMs": {"p50": percentile_nearest_rank(latencies, 0.5), "p95": percentile_nearest_rank(latencies, 0.95)},
            "activeDatasetUnchanged": final_dataset_unchanged,
            "rulesDeployedOrApproved": False,
        },
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
