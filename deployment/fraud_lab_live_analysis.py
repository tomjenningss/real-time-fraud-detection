#!/usr/bin/env python3
"""Run one live, non-deploying Fraud Rule Discovery analysis through Glaramara."""

from __future__ import annotations

import argparse
import http.cookiejar
import json
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
    timeout: float = 10,
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
        with opener.open(request, timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.load(error)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return error.code, {"error": {"message": error.reason}}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Invoke the live watsonx Orchestrate fraud-rule discovery journey."
    )
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--timeout-seconds", type=float, default=120)
    args = parser.parse_args()
    base_url = args.base_url.rstrip("/")
    require(bool(base_url), "GLARAMARA_PUBLIC_ORIGIN is empty")

    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )
    mutation_headers = {"Origin": base_url}
    session_status, session = call(
        opener,
        base_url,
        "POST",
        "/api/v1/demo/session",
        body={"customerId": "fraud-analyst-alex-morgan"},
        headers=mutation_headers,
    )
    require(session_status == 200, f"analyst session returned {session_status}: {session}")
    require(
        session.get("session", {}).get("role") == "FRAUD_ANALYST",
        "server did not issue a fraud analyst session",
    )

    dashboard_status, dashboard = call(
        opener, base_url, "GET", "/api/v1/fraud-operations"
    )
    require(dashboard_status == 200, f"fraud dashboard returned {dashboard_status}: {dashboard}")
    active_waves = dashboard.get("waves", [])
    require(active_waves, "fraud lab has no active waves")

    analysis_status, analysis = call(
        opener,
        base_url,
        "POST",
        "/api/v1/fraud-operations/analyses",
        headers={
            **mutation_headers,
            "Idempotency-Key": f"make-live-orchestrate-{uuid.uuid4()}",
        },
        timeout=args.timeout_seconds,
    )
    require(analysis_status == 200, f"live analysis returned {analysis_status}: {analysis}")
    run = analysis.get("run", {})
    require(run.get("status") == "COMPLETED", f"analysis did not complete: {run}")
    agent = run.get("agent") or {}
    require(
        agent.get("provider") == "watsonx-orchestrate-rest",
        f"analysis did not use live watsonx Orchestrate: {agent.get('provider')!r}",
    )
    candidate = run.get("candidate") or {}
    proposal = candidate.get("proposal") or {}
    backtest = candidate.get("backtest") or {}
    metrics = backtest.get("metrics") or {}
    require(candidate and proposal and metrics, "successful run is missing proposal or backtest data")

    result = {
        "event": "fraud_lab_live_analysis_succeeded",
        "runId": run.get("id"),
        "snapshot": {
            "rowCount": run.get("snapshotRowCount"),
            "sha256": run.get("snapshotSha256"),
            "waves": run.get("snapshot", {}).get("waves", []),
        },
        "currentDataset": {
            "rowCount": dashboard.get("dataset", {}).get("totalTransactions"),
            "waveIds": [wave.get("id") for wave in active_waves],
        },
        "agent": agent,
        "candidate": {
            "id": candidate.get("id"),
            "status": candidate.get("status"),
            "ruleIdentifier": proposal.get("ruleIdentifier"),
            "name": proposal.get("name"),
            "conditions": proposal.get("conditions"),
            "action": proposal.get("action"),
            "fingerprint": candidate.get("fingerprint"),
            "duplicateOfCandidateId": candidate.get("duplicateOfCandidateId"),
        },
        "backtest": metrics,
        "reviewOrDeploymentPerformed": False,
    }
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
