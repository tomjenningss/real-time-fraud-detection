#!/usr/bin/env python3
"""Read-only Flink job identity and capacity checks for local lifecycle scripts."""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

EXPECTED = {
    "java": "Per-transaction behavioural enrichment",
    "sql": "Fraud SQL signals analytics",
}
REQUIRED_REGISTERED_SLOTS = 2


def fetch(base_url: str, path: str) -> dict:
    # Flink is reached over the private Compose network. Podman can propagate host
    # proxy variables into containers, so urlopen() must not route this request to
    # a workstation or corporate HTTP proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(base_url.rstrip("/") + path, timeout=5) as response:
        return json.load(response)


def assess(overview: dict, jobs_payload: dict) -> dict:
    total_slots = int(overview.get("slots-total", 0))
    taskmanagers = int(overview.get("taskmanagers", 0))
    jobs = jobs_payload.get("jobs", [])
    expected = {}
    errors = []
    for key, name in EXPECTED.items():
        matches = [job for job in jobs if job.get("name") == name]
        running = [job for job in matches if job.get("state") == "RUNNING"]
        if len(running) > 1:
            errors.append(f"duplicate running expected job: {name} ({len(running)} running matches)")
        expected[key] = {
            "name": name,
            "matches": len(matches),
            "running": len(running),
            "job_id": running[0].get("jid") if len(running) == 1 else None,
        }
    if taskmanagers < 1:
        errors.append("no registered TaskManager")
    if total_slots < REQUIRED_REGISTERED_SLOTS:
        errors.append(
            f"insufficient registered slot capacity: {total_slots} < {REQUIRED_REGISTERED_SLOTS}"
        )
    return {
        "taskmanagers": taskmanagers,
        "registered_slots": total_slots,
        "required_registered_slots": REQUIRED_REGISTERED_SLOTS,
        "expected_jobs": expected,
        "errors": errors,
    }


def load(base_url: str) -> dict:
    return assess(fetch(base_url, "/overview"), fetch(base_url, "/jobs/overview"))


def report(command: str, status: dict) -> int:
    if status["errors"]:
        for error in status["errors"]:
            print(error, file=sys.stderr)
        return 1
    missing = [key for key, value in status["expected_jobs"].items() if value["running"] == 0]
    if command == "plan":
        print("\n".join(missing))
        return 0
    if command == "ids":
        for key, value in status["expected_jobs"].items():
            if value["job_id"]:
                print(f"{key}={value['job_id']}")
        return 0
    print(json.dumps(status, separators=(",", ":"), sort_keys=True))
    return 0 if not missing else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("check", "plan", "ids"))
    parser.add_argument("--url", default="http://localhost:8081")
    args = parser.parse_args()
    try:
        status = load(args.url)
    except (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError) as error:
        print(f"Flink REST unavailable: {type(error).__name__}", file=sys.stderr)
        return 2
    return report(args.command, status)


if __name__ == "__main__":
    raise SystemExit(main())
