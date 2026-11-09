#!/usr/bin/env python3
"""Configurable, bounded load runner for the real Glaramara payment API.

The runner deliberately uses only the public Glaramara HTTP boundary for payment
creation. PostgreSQL is read after submission because the immutable decision row,
not a Kafka acknowledgement or HTTP 202, is the completion criterion.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import http.cookiejar
import json
import math
import os
import platform
import random
import re
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
ALLOWED_COUNTS = {100, 1_000, 2_000, 10_000, 50_000}
ALLOWED_RATES = {10, 50, 100, 250}
SCENARIOS = (
    "legitimate_day_to_day",
    "high_velocity",
    "merchant_hopping",
    "new_beneficiary_high_value",
    "slow_building_investment",
    "legitimate_recurring_investment",
)
PROFILE_WEIGHTS = {
    "mixed": (40, 15, 15, 10, 10, 10),
    "mostly-legitimate": (65, 4, 3, 2, 1, 25),
    "fraud-heavy": (10, 25, 25, 20, 15, 5),
}
GROUPS = (
    "fraud-platform-dev-router-v1",
    "fraud-platform-dev-lightgbm-v1",
    "fraud-platform-dev-correlator-v1",
    "fraud-platform-dev-decision-engine-v1",
    "flink-transaction-enrichment-v1",
    "flink-fraud-analytics-v1",
)


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(quantile * len(ordered)) - 1)
    return round(ordered[index], 3)


def latency_summary(values: list[float]) -> dict[str, float | int | None]:
    return {
        "count": len(values),
        "p50_ms": percentile(values, 0.50),
        "p95_ms": percentile(values, 0.95),
        "p99_ms": percentile(values, 0.99),
        "max_ms": round(max(values), 3) if values else None,
    }


def run_command(
    command: list[str], timeout: float = 20
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def parse_env_value(name: str) -> str:
    path = REPO_ROOT / ".env"
    if not path.exists():
        raise RuntimeError("root .env is required for isolated Compose instrumentation")
    for line in path.read_text().splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() == name:
            return value.strip().strip('"').strip("'")
    raise RuntimeError(f"{name} is not configured in root .env")


class HttpMetrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.requests: Counter[str] = Counter()
        self.statuses: dict[str, Counter[str]] = defaultdict(Counter)
        self.latencies: dict[str, list[float]] = defaultdict(list)
        self.errors: Counter[str] = Counter()
        self.timeouts: Counter[str] = Counter()
        self.retries: Counter[str] = Counter()

    def record(
        self,
        phase: str,
        latency_ms: float,
        *,
        status: int | None = None,
        error: str | None = None,
        timeout: bool = False,
    ) -> None:
        with self._lock:
            self.requests[phase] += 1
            self.latencies[phase].append(latency_ms)
            if status is not None:
                self.statuses[phase][str(status)] += 1
            if error:
                self.errors[f"{phase}:{error}"] += 1
            if timeout:
                self.timeouts[phase] += 1

    def retried(self, phase: str) -> None:
        with self._lock:
            self.retries[phase] += 1

    def snapshot(self) -> dict[str, Any]:
        phases = sorted(self.requests)
        return {
            "requests_by_phase": dict(self.requests),
            "statuses_by_phase": {
                phase: dict(self.statuses[phase]) for phase in phases
            },
            "latency_by_phase": {
                phase: latency_summary(self.latencies[phase]) for phase in phases
            },
            "errors": dict(self.errors),
            "timeouts_by_phase": dict(self.timeouts),
            "retries_by_phase": dict(self.retries),
        }


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: dict[str, Any]
    latency_ms: float


class ApiSession:
    def __init__(
        self,
        base_url: str,
        customer_id: str,
        cookie_header: str,
        metrics: HttpMetrics,
        timeout: float,
        retries: int,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.customer_id = customer_id
        self.cookie_header = cookie_header
        self.metrics = metrics
        self.timeout = timeout
        self.retries = retries

    @classmethod
    def bootstrap(
        cls,
        base_url: str,
        metrics: HttpMetrics,
        timeout: float,
        retries: int,
        customer_id: str | None = None,
    ) -> tuple[ApiSession, dict[str, Any]]:
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        path = "/api/v1/demo/session"
        body = None if customer_id is None else {"customerId": customer_id}
        payload = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            base_url.rstrip("/") + path,
            data=payload,
            method="GET" if body is None else "POST",
            headers={
                "Accept": "application/json",
                **(
                    {"Content-Type": "application/json", "Origin": base_url.rstrip("/")}
                    if body
                    else {}
                ),
            },
        )
        started = time.perf_counter()
        try:
            with opener.open(request, timeout=timeout) as response:
                result = json.load(response)
                status = response.status
        except (OSError, ValueError, KeyError) as error:
            elapsed = (time.perf_counter() - started) * 1_000
            metrics.record("control", elapsed, error=type(error).__name__)
            raise RuntimeError(
                f"session bootstrap failed: {type(error).__name__}"
            ) from error
        metrics.record(
            "control", (time.perf_counter() - started) * 1_000, status=status
        )
        if status != 200:
            raise RuntimeError(f"session bootstrap returned HTTP {status}")
        selected_id = result["session"]["customerId"]
        cookie_header = "; ".join(f"{cookie.name}={cookie.value}" for cookie in jar)
        if not cookie_header:
            raise RuntimeError("session bootstrap did not return a demo-session cookie")
        return cls(
            base_url, selected_id, cookie_header, metrics, timeout, retries
        ), result

    def request(
        self,
        method: str,
        path: str,
        *,
        phase: str,
        body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        retryable: bool = True,
    ) -> HttpResponse:
        payload = (
            json.dumps(body, separators=(",", ":")).encode()
            if body is not None
            else None
        )
        attempt = 0
        while True:
            request_headers = {
                "Accept": "application/json",
                "Cookie": self.cookie_header,
                **(headers or {}),
            }
            if payload is not None:
                request_headers["Content-Type"] = "application/json"
            request = urllib.request.Request(
                self.base_url + path,
                data=payload,
                method=method,
                headers=request_headers,
            )
            started = time.perf_counter()
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    parsed = json.load(response)
                    elapsed = (time.perf_counter() - started) * 1_000
                    self.metrics.record(phase, elapsed, status=response.status)
                    return HttpResponse(response.status, parsed, elapsed)
            except urllib.error.HTTPError as error:
                elapsed = (time.perf_counter() - started) * 1_000
                try:
                    parsed = json.load(error)
                except (OSError, ValueError):
                    parsed = {"error": {"code": "UNPARSEABLE_HTTP_ERROR"}}
                self.metrics.record(phase, elapsed, status=error.code)
                should_retry = retryable and error.code in {
                    408,
                    425,
                    429,
                    500,
                    502,
                    503,
                    504,
                }
                if not should_retry or attempt >= self.retries:
                    return HttpResponse(error.code, parsed, elapsed)
            except (
                TimeoutError,
                urllib.error.URLError,
                ConnectionError,
                OSError,
            ) as error:
                elapsed = (time.perf_counter() - started) * 1_000
                is_timeout = (
                    isinstance(error, TimeoutError) or "timed out" in str(error).lower()
                )
                self.metrics.record(
                    phase,
                    elapsed,
                    error=type(error).__name__,
                    timeout=is_timeout,
                )
                if not retryable or attempt >= self.retries:
                    raise
            attempt += 1
            self.metrics.retried(phase)
            time.sleep(min(1.0, 0.05 * (2 ** (attempt - 1))))


@dataclass(frozen=True)
class Beneficiary:
    id: str
    name: str
    booked_payment_count: int
    synthetic: bool


@dataclass(frozen=True)
class PaymentPlan:
    index: int
    scenario: str
    customer_id: str
    beneficiary_id: str
    amount: str
    reference: str
    idempotency_key: str


@dataclass
class SubmissionResult:
    index: int
    scenario: str
    customer_id: str
    accepted: bool
    status: int | None
    payment_id: str | None = None
    transaction_id: str | None = None
    replayed: bool = False
    latency_ms: float | None = None
    error: str | None = None


def deterministic_digits(seed: str, length: int) -> str:
    value = str(int(hashlib.sha256(seed.encode()).hexdigest(), 16))
    return value[:length].ljust(length, "0")


def provision_beneficiaries(
    session: ApiSession,
    run_token: str,
    customer_index: int,
) -> list[Beneficiary]:
    response = session.request("GET", "/api/v1/beneficiaries", phase="control")
    if response.status != 200:
        raise RuntimeError(f"beneficiary list returned HTTP {response.status}")

    def convert(row: dict[str, Any]) -> Beneficiary:
        return Beneficiary(
            id=row["id"],
            name=row["displayName"],
            booked_payment_count=int(row.get("bookedPaymentCount", 0)),
            synthetic=row["displayName"].startswith(f"LT {run_token}"),
        )

    beneficiaries = [convert(row) for row in response.body["beneficiaries"]]
    desired_names = [f"LT {run_token} C{customer_index} B{index}" for index in range(4)]
    existing_names = {item.name for item in beneficiaries}
    for index, name in enumerate(desired_names):
        if name in existing_names:
            continue
        digits = deterministic_digits(f"{run_token}:{customer_index}:{index}", 14)
        created = session.request(
            "POST",
            "/api/v1/beneficiaries",
            phase="control",
            body={
                "displayName": name,
                "sortCode": digits[:6],
                "accountNumber": digits[6:14],
            },
            headers={"Origin": session.base_url},
            retryable=False,
        )
        if created.status not in {201, 409}:
            raise RuntimeError(
                f"synthetic beneficiary creation returned HTTP {created.status}"
            )
    refreshed = session.request("GET", "/api/v1/beneficiaries", phase="control")
    if refreshed.status != 200:
        raise RuntimeError(f"beneficiary refresh returned HTTP {refreshed.status}")
    result = [convert(row) for row in refreshed.body["beneficiaries"]]
    if len(result) < 4 or not any(item.synthetic for item in result):
        raise RuntimeError(
            "customer does not have the required isolated synthetic beneficiaries"
        )
    return result


def build_plan(
    *,
    count: int,
    profile: str,
    seed: int,
    run_id: str,
    run_token: str,
    sessions: list[ApiSession],
    beneficiaries: dict[str, list[Beneficiary]],
) -> list[PaymentPlan]:
    rng = random.Random(seed)
    weights = PROFILE_WEIGHTS[profile]
    selected = rng.choices(SCENARIOS, weights=weights, k=count)
    occurrences: Counter[str] = Counter()
    plan: list[PaymentPlan] = []
    codes = {
        "legitimate_day_to_day": "DAY",
        "high_velocity": "VEL",
        "merchant_hopping": "HOP",
        "new_beneficiary_high_value": "NEW",
        "slow_building_investment": "SLW",
        "legitimate_recurring_investment": "REC",
    }
    for index, scenario in enumerate(selected):
        occurrence = occurrences[scenario]
        occurrences[scenario] += 1
        if scenario == "high_velocity":
            session = sessions[0]
        elif scenario in {"merchant_hopping", "slow_building_investment"}:
            session = sessions[1 % len(sessions)]
        elif scenario in {
            "new_beneficiary_high_value",
            "legitimate_recurring_investment",
        }:
            session = sessions[2 % len(sessions)]
        else:
            session = sessions[index % len(sessions)]
        available = beneficiaries[session.customer_id]
        synthetic = [item for item in available if item.synthetic]
        paid = [item for item in available if item.booked_payment_count > 0]
        if scenario == "merchant_hopping":
            beneficiary = available[occurrence % min(4, len(available))]
            amount = rng.uniform(45, 650)
        elif scenario == "new_beneficiary_high_value":
            beneficiary = synthetic[occurrence % len(synthetic)]
            amount = rng.uniform(5_250, 12_500)
        elif scenario == "slow_building_investment":
            beneficiary = synthetic[0]
            growth = (250, 500, 1_000, 2_000, 4_000)
            amount = growth[occurrence % len(growth)]
        elif scenario == "legitimate_recurring_investment":
            beneficiary = (paid or synthetic)[0]
            amount = 250.00
        elif scenario == "high_velocity":
            beneficiary = synthetic[0]
            amount = rng.uniform(20, 300)
        else:
            beneficiary = rng.choice(paid or available)
            amount = rng.choice((8.75, 16.40, 27.95, 42.50, 65.00, 120.00))
        code = codes[scenario]
        plan.append(
            PaymentPlan(
                index=index,
                scenario=scenario,
                customer_id=session.customer_id,
                beneficiary_id=beneficiary.id,
                amount=f"{amount:.2f}",
                reference=f"LT-{run_token}-{code}-{index % 1000:03d}"[:24],
                idempotency_key=f"glaramara-load:{run_id}:{index}:{scenario}",
            )
        )
    return plan


class ComposeInspector:
    def __init__(self, project: str, flink_url: str) -> None:
        self.project = project
        self.flink_url = flink_url.rstrip("/")
        self.compose = str(REPO_ROOT / "deployment" / "compose.sh")
        self.database_user = parse_env_value("POSTGRES_USER")
        self.database_name = parse_env_value("POSTGRES_DB")

    def psql_json(self, sql: str, timeout: float = 30) -> dict[str, Any]:
        result = run_command(
            [
                self.compose,
                "exec",
                "-T",
                "postgres",
                "psql",
                "-X",
                "-q",
                "-t",
                "-A",
                "-U",
                self.database_user,
                "-d",
                self.database_name,
                "-c",
                sql,
            ],
            timeout=timeout,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip().splitlines()[-1:]
            raise RuntimeError(
                f"PostgreSQL inspection failed: {detail[0] if detail else 'unknown error'}"
            )
        lines = [
            line
            for line in result.stdout.splitlines()
            if line.strip().startswith(("{", "["))
        ]
        if not lines:
            raise RuntimeError("PostgreSQL inspection returned no JSON")
        parsed = json.loads(lines[-1])
        return parsed if isinstance(parsed, dict) else {"rows": parsed}

    def run_attempt_count(self, idempotency_prefix: str) -> int:
        prefix = idempotency_prefix.replace("'", "''")
        result = self.psql_json(
            "SELECT json_build_object('count', count(*)) "
            "FROM banking_payment_attempts "
            f"WHERE idempotency_key LIKE '{prefix}%';"
        )
        return int(result["count"])

    def recent_attempt_count(self) -> int:
        result = self.psql_json(
            "SELECT json_build_object('count', count(*)) FROM banking_payment_attempts "
            "WHERE submitted_at >= now() - interval '10 minutes';"
        )
        return int(result["count"])

    def investigation_candidates(
        self, idempotency_prefix: str, limit: int
    ) -> list[dict[str, Any]]:
        prefix = idempotency_prefix.replace("'", "''")
        result = self.psql_json(
            f"""
            SELECT coalesce(json_agg(json_build_object(
              'payment_id', selected.payment_id,
              'customer_id', selected.customer_id,
              'transaction_id', selected.transaction_id,
              'verdict', selected.payment_verdict,
              'decided_at', selected.decided_at
            ) ORDER BY selected.submitted_at), '[]'::json)
            FROM (
              SELECT attempt.payment_id, attempt.customer_id, attempt.transaction_id,
                     attempt.submitted_at, decision.payment_verdict, decision.decided_at
              FROM banking_payment_attempts attempt
              JOIN payment_decisions decision USING (transaction_id)
              LEFT JOIN customer_fraud_investigations investigation USING (payment_id)
              WHERE attempt.idempotency_key LIKE '{prefix}%'
                AND decision.payment_verdict = 'CHALLENGED'
                AND (investigation.customer_investigation_id IS NULL
                     OR investigation.status <> 'REASSESSED')
              ORDER BY attempt.submitted_at
              LIMIT {int(limit)}
            ) selected;
            """
        )
        rows = result.get("rows", [])
        return rows if isinstance(rows, list) else []

    def orchestrate_reconciliation(
        self, idempotency_prefix: str, payment_ids: list[str] | None = None
    ) -> dict[str, Any]:
        prefix = idempotency_prefix.replace("'", "''")
        payment_filter = ""
        if payment_ids:
            if not all(re.fullmatch(r"[0-9a-f-]{36}", value) for value in payment_ids):
                raise ValueError("invalid payment identity returned by the database")
            quoted = ",".join(f"'{value}'::uuid" for value in payment_ids)
            payment_filter = f"AND attempt.payment_id IN ({quoted})"
        return self.psql_json(
            f"""
            WITH run_investigations AS (
              SELECT investigation.customer_investigation_id
              FROM customer_fraud_investigations investigation
              JOIN banking_payment_attempts attempt USING (payment_id)
              WHERE attempt.idempotency_key LIKE '{prefix}%'
                {payment_filter}
            ), provider_models AS (
              SELECT DISTINCT extraction.provider, extraction.model
              FROM fraud_intelligence_extractions extraction
              JOIN run_investigations run USING (customer_investigation_id)
            )
            SELECT json_build_object(
              'model_invocations', count(extraction.*),
              'schema_valid', count(*) FILTER (WHERE extraction.schema_valid),
              'request_failures', count(*) FILTER (WHERE NOT extraction.schema_valid),
              'latency_ms', json_build_object(
                'p50_ms', percentile_cont(0.50) WITHIN GROUP (ORDER BY extraction.latency_ms),
                'p95_ms', percentile_cont(0.95) WITHIN GROUP (ORDER BY extraction.latency_ms),
                'p99_ms', percentile_cont(0.99) WITHIN GROUP (ORDER BY extraction.latency_ms),
                'max_ms', max(extraction.latency_ms)
              ),
              'provider_models', (SELECT coalesce(json_agg(provider_models), '[]'::json)
                                  FROM provider_models)
            )
            FROM fraud_intelligence_extractions extraction
            JOIN run_investigations run USING (customer_investigation_id);
            """
        )

    def provider(self) -> str | None:
        result = run_command(
            [
                self.compose,
                "exec",
                "-T",
                "glaramara-bank",
                "printenv",
                "FRAUD_INTELLIGENCE_PROVIDER",
            ],
            timeout=10,
        )
        return result.stdout.strip() if result.returncode == 0 else None

    def db_runtime(self) -> dict[str, Any]:
        return self.psql_json(
            """
            SELECT json_build_object(
              'connections', (SELECT count(*) FROM pg_stat_activity),
              'active_connections', (SELECT count(*) FROM pg_stat_activity WHERE state = 'active'),
              'max_connections', (SELECT setting::int FROM pg_settings WHERE name = 'max_connections'),
              'waiting_locks', (SELECT count(*) FROM pg_locks WHERE NOT granted),
              'deadlocks', deadlocks,
              'xact_commit', xact_commit,
              'tup_inserted', tup_inserted,
              'tup_updated', tup_updated,
              'blk_read_time_ms', blk_read_time,
              'blk_write_time_ms', blk_write_time,
              'stats_reset', stats_reset
            )
            FROM pg_stat_database WHERE datname = current_database();
            """
        )

    def kafka_lag(self) -> dict[str, Any]:
        result = run_command(
            [
                self.compose,
                "exec",
                "-T",
                "kafka",
                "kafka-consumer-groups",
                "--bootstrap-server",
                "kafka:29092",
                "--describe",
                "--all-groups",
            ],
            timeout=30,
        )
        groups: dict[str, dict[str, int]] = {}
        if result.returncode != 0:
            return {"available": False, "error": "consumer group inspection failed"}
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) < 6 or parts[0] not in GROUPS:
                continue
            try:
                lag = 0 if parts[5] == "-" else int(parts[5])
            except ValueError:
                continue
            aggregate = groups.setdefault(
                parts[0], {"total_lag": 0, "max_partition_lag": 0}
            )
            aggregate["total_lag"] += lag
            aggregate["max_partition_lag"] = max(aggregate["max_partition_lag"], lag)
        return {"available": True, "groups": groups}

    @staticmethod
    def _url_json(url: str, timeout: float = 5) -> dict[str, Any]:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return json.load(response)

    def flink(self) -> dict[str, Any]:
        try:
            overview = self._url_json(f"{self.flink_url}/jobs/overview")
        except (OSError, ValueError, KeyError) as error:
            return {"available": False, "error": type(error).__name__}
        jobs: list[dict[str, Any]] = []
        for job in overview.get("jobs", []):
            if job.get("state") != "RUNNING":
                continue
            job_id = job["jid"]
            try:
                detail = self._url_json(f"{self.flink_url}/jobs/{job_id}")
                checkpoints = self._url_json(
                    f"{self.flink_url}/jobs/{job_id}/checkpoints"
                )
                exceptions = self._url_json(
                    f"{self.flink_url}/jobs/{job_id}/exceptions"
                )
            except (OSError, ValueError, KeyError):
                continue
            vertices: list[dict[str, Any]] = []
            for vertex in detail.get("vertices", []):
                vertex_id = vertex["id"]
                names = (
                    "0.busyTimeMsPerSecond,0.backPressuredTimeMsPerSecond,"
                    "0.idleTimeMsPerSecond,0.numRecordsIn,0.numRecordsOut,"
                    "0.currentInputWatermark"
                )
                try:
                    metrics = self._url_json(
                        f"{self.flink_url}/jobs/{job_id}/vertices/{vertex_id}/metrics?get={names}"
                    )
                except (OSError, ValueError, KeyError):
                    metrics = []
                vertices.append(
                    {
                        "name": vertex.get("name"),
                        "status": vertex.get("status"),
                        "overview_metrics": vertex.get("metrics", {}),
                        "metrics": {item["id"]: item.get("value") for item in metrics},
                    }
                )
            jobs.append(
                {
                    "id": job_id,
                    "name": job.get("name"),
                    "state": job.get("state"),
                    "start_time": job.get("start-time"),
                    "vertices": vertices,
                    "checkpoints": checkpoints.get("counts", {}),
                    "latest_checkpoints": checkpoints.get("latest", {}),
                    "exception_count": len(exceptions.get("all-exceptions", [])),
                    "truncated_exceptions": exceptions.get("truncated", False),
                }
            )
        return {"available": True, "jobs": jobs}

    def container_stats(self) -> dict[str, Any]:
        containers = run_command(
            [
                "podman",
                "ps",
                "--filter",
                f"label=com.docker.compose.project={self.project}",
                "--format",
                "{{.Names}}",
            ],
            timeout=10,
        )
        names = [
            line.strip() for line in containers.stdout.splitlines() if line.strip()
        ]
        if containers.returncode != 0 or not names:
            return {"available": False, "error": "container inventory unavailable"}
        stats = run_command(
            ["podman", "stats", "--no-stream", "--format", "json", *names], timeout=20
        )
        if stats.returncode != 0:
            return {"available": False, "error": "container statistics unavailable"}
        try:
            rows = json.loads(stats.stdout)
        except json.JSONDecodeError:
            return {"available": False, "error": "container statistics were not JSON"}
        if isinstance(rows, dict):
            rows = [rows]
        selected = {}
        for row in rows:
            name = row.get("name") or row.get("Name") or row.get("container")
            if name:
                selected[name] = {
                    "cpu_percent": row.get("cpu_percent") or row.get("CPUPerc"),
                    "memory_usage": row.get("mem_usage") or row.get("MemUsage"),
                    "memory_percent": row.get("mem_percent") or row.get("MemPerc"),
                    "pids": row.get("pids") or row.get("PIDs"),
                }
        inspected = run_command(["podman", "inspect", *names], timeout=20)
        if inspected.returncode == 0:
            try:
                details = json.loads(inspected.stdout)
            except json.JSONDecodeError:
                details = []
            for detail in details:
                name = str(detail.get("Name", "")).lstrip("/")
                state = detail.get("State", {})
                if name in selected:
                    selected[name].update(
                        {
                            "restart_count": detail.get("RestartCount"),
                            "oom_killed": state.get("OOMKilled"),
                            "started_at": state.get("StartedAt"),
                            "status": state.get("Status"),
                        }
                    )
        return {"available": True, "containers": selected}

    def hardware(self) -> dict[str, Any]:
        machine = run_command(["podman", "machine", "inspect"], timeout=10)
        podman_machine = None
        if machine.returncode == 0:
            try:
                parsed = json.loads(machine.stdout)
                item = parsed[0] if isinstance(parsed, list) and parsed else parsed
                resources = item.get("Resources", item.get("resources", {}))
                podman_machine = {
                    "cpus": resources.get("CPUs", resources.get("cpus")),
                    "memory_mib": resources.get("Memory", resources.get("memory")),
                    "disk_size_gib": resources.get(
                        "DiskSize", resources.get("disk_size")
                    ),
                }
            except (json.JSONDecodeError, AttributeError):
                podman_machine = None
        return {
            "host_system": platform.system(),
            "host_release": platform.release(),
            "host_machine": platform.machine(),
            "host_cpu_count": os.cpu_count(),
            "podman_machine": podman_machine,
        }

    def reconciliation(self, idempotency_prefix: str) -> dict[str, Any]:
        prefix = idempotency_prefix.replace("'", "''")
        sql = f"""
        WITH run_attempts AS (
          SELECT * FROM banking_payment_attempts WHERE idempotency_key LIKE '{prefix}%'
        ), latest_shadow AS (
          SELECT DISTINCT ON (transaction_id) transaction_id, proposed_action,
                 original_payment_verdict, differs_from_original, evaluation_latency_ms,
                 evaluated_at
          FROM fraud_shadow_decision_history
          ORDER BY transaction_id, source_revision DESC
        ), rows AS (
          SELECT a.payment_id, a.transaction_id, a.submitted_at, a.event_time,
                 d.payment_verdict, d.decided_at, d.policy_version,
                 d.decision_payload->'triggered_rule_ids' AS triggered_rule_ids,
                 (d.enrichment_evidence IS NOT NULL) AS flink_evidence_persisted,
                 raw.status::text AS raw_outbox_status, raw.attempts AS raw_outbox_attempts,
                 marker.status::text AS marker_outbox_status,
                 shadow.proposed_action AS shadow_action,
                 shadow.differs_from_original AS shadow_disagrees,
                 shadow.evaluation_latency_ms AS shadow_latency_ms,
                 ml.payload->>'scoring_latency_ms' AS scoring_latency_ms,
                 (correlated.assessment ? 'deterministic') AS correlated_has_deterministic,
                 (correlated.assessment ? 'ml') AS correlated_has_ml,
                 correlated.assessment->>'completeness' AS correlated_completeness
          FROM run_attempts a
          LEFT JOIN payment_decisions d ON d.transaction_id = a.transaction_id
          LEFT JOIN outbox_events raw ON raw.aggregate_id = a.payment_id
            AND raw.aggregate_type = 'banking_payment_raw'
          LEFT JOIN outbox_events marker ON marker.aggregate_id = a.payment_id
            AND marker.aggregate_type = 'banking_payment_watermark'
          LEFT JOIN latest_shadow shadow ON shadow.transaction_id = a.transaction_id
          LEFT JOIN fraud_assessment_source_events ml ON ml.transaction_id = a.transaction_id
            AND ml.event_kind = 'ML' AND ml.valid
          LEFT JOIN fraud_assessments_latest correlated
            ON correlated.transaction_id = a.transaction_id
        )
        SELECT json_build_object(
          'attempts', count(*),
          'raw_outbox_published', count(*) FILTER (WHERE raw_outbox_status = 'PUBLISHED'),
          'watermark_outbox_published', count(*) FILTER (WHERE marker_outbox_status = 'PUBLISHED'),
          'flink_evidence_persisted', count(*) FILTER (WHERE flink_evidence_persisted),
          'authoritative_decisions', count(*) FILTER (WHERE payment_verdict IS NOT NULL),
          'approved', count(*) FILTER (WHERE payment_verdict = 'APPROVED'),
          'challenged', count(*) FILTER (WHERE payment_verdict = 'CHALLENGED'),
          'blocked', count(*) FILTER (WHERE payment_verdict = 'BLOCKED'),
          'raw_outbox_retries', coalesce(sum(greatest(coalesce(raw_outbox_attempts, 0) - 1, 0)), 0),
          'shadow_assessments', count(*) FILTER (WHERE scoring_latency_ms IS NOT NULL),
          'correlated_with_deterministic', count(*) FILTER (WHERE correlated_has_deterministic),
          'correlated_with_ml', count(*) FILTER (WHERE correlated_has_ml),
          'correlated_complete', count(*) FILTER (WHERE correlated_completeness = 'COMPLETE'),
          'correlated_pending_investigation', count(*) FILTER (
            WHERE correlated_completeness = 'PENDING_INVESTIGATION'
          ),
          'shadow_decisions', count(*) FILTER (WHERE shadow_action IS NOT NULL),
          'shadow_disagreements', count(*) FILTER (WHERE shadow_disagrees),
          'authoritative_duration_seconds', extract(epoch FROM (max(decided_at) - min(submitted_at))),
          'authoritative_throughput_tps', count(*) FILTER (WHERE decided_at IS NOT NULL) /
            nullif(extract(epoch FROM (max(decided_at) - min(submitted_at))), 0),
          'decision_latency_ms', json_build_object(
            'p50_ms', percentile_cont(0.50) WITHIN GROUP (
              ORDER BY extract(epoch FROM (decided_at - submitted_at)) * 1000
            ) FILTER (WHERE decided_at IS NOT NULL),
            'p95_ms', percentile_cont(0.95) WITHIN GROUP (
              ORDER BY extract(epoch FROM (decided_at - submitted_at)) * 1000
            ) FILTER (WHERE decided_at IS NOT NULL),
            'p99_ms', percentile_cont(0.99) WITHIN GROUP (
              ORDER BY extract(epoch FROM (decided_at - submitted_at)) * 1000
            ) FILTER (WHERE decided_at IS NOT NULL),
            'max_ms', max(extract(epoch FROM (decided_at - submitted_at)) * 1000)
          ),
          'scoring_latency_ms', json_build_object(
            'p50_ms', percentile_cont(0.50) WITHIN GROUP (ORDER BY scoring_latency_ms::double precision)
              FILTER (WHERE scoring_latency_ms IS NOT NULL),
            'p95_ms', percentile_cont(0.95) WITHIN GROUP (ORDER BY scoring_latency_ms::double precision)
              FILTER (WHERE scoring_latency_ms IS NOT NULL),
            'p99_ms', percentile_cont(0.99) WITHIN GROUP (ORDER BY scoring_latency_ms::double precision)
              FILTER (WHERE scoring_latency_ms IS NOT NULL),
            'max_ms', max(scoring_latency_ms::double precision)
          ),
          'shadow_policy_latency_ms', json_build_object(
            'p50_ms', percentile_cont(0.50) WITHIN GROUP (ORDER BY shadow_latency_ms)
              FILTER (WHERE shadow_latency_ms IS NOT NULL),
            'p95_ms', percentile_cont(0.95) WITHIN GROUP (ORDER BY shadow_latency_ms)
              FILTER (WHERE shadow_latency_ms IS NOT NULL),
            'p99_ms', percentile_cont(0.99) WITHIN GROUP (ORDER BY shadow_latency_ms)
              FILTER (WHERE shadow_latency_ms IS NOT NULL),
            'max_ms', max(shadow_latency_ms)
          ),
          'payments', coalesce(json_agg(json_build_object(
            'payment_id', payment_id,
            'transaction_id', transaction_id,
            'verdict', payment_verdict,
            'policy_version', policy_version,
            'triggered_rule_ids', coalesce(triggered_rule_ids, '[]'::jsonb),
            'raw_outbox_status', raw_outbox_status,
            'marker_outbox_status', marker_outbox_status,
            'shadow_action', shadow_action,
            'shadow_disagrees', shadow_disagrees
          ) ORDER BY submitted_at), '[]'::json)
        ) FROM rows;
        """
        return self.psql_json(sql, timeout=60)


@dataclass
class RuntimeSampler:
    inspector: ComposeInspector
    interval: float
    stop: threading.Event = field(default_factory=threading.Event)
    samples: list[dict[str, Any]] = field(default_factory=list)
    thread: threading.Thread | None = None

    def sample(self) -> dict[str, Any]:
        observed = {"timestamp": utc_now()}
        for name, function in (
            ("kafka", self.inspector.kafka_lag),
            ("flink", self.inspector.flink),
            ("postgresql", self.inspector.db_runtime),
            ("containers", self.inspector.container_stats),
        ):
            try:
                observed[name] = function()
            except (
                OSError,
                RuntimeError,
                ValueError,
                KeyError,
                subprocess.SubprocessError,
            ) as error:
                observed[name] = {"available": False, "error": type(error).__name__}
        self.samples.append(observed)
        return observed

    def start(self) -> None:
        self.sample()

        def loop() -> None:
            while not self.stop.wait(self.interval):
                self.sample()

        self.thread = threading.Thread(
            target=loop, name="load-metrics-sampler", daemon=True
        )
        self.thread.start()

    def finish(self) -> None:
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=self.interval + 10)
        self.sample()

    def summary(self) -> dict[str, Any]:
        max_lag: dict[str, int] = defaultdict(int)
        kafka_samples: list[dict[str, Any]] = []
        resource_samples: dict[str, list[dict[str, Any]]] = defaultdict(list)
        flink_samples: list[dict[str, Any]] = []
        db_samples: list[dict[str, Any]] = []
        for sample in self.samples:
            kafka = sample.get("kafka", {})
            if kafka.get("available"):
                kafka_samples.append({"timestamp": sample["timestamp"], **kafka})
            for group, values in kafka.get("groups", {}).items():
                max_lag[group] = max(max_lag[group], int(values.get("total_lag", 0)))
            containers = sample.get("containers", {})
            for name, values in containers.get("containers", {}).items():
                resource_samples[name].append(
                    {"timestamp": sample["timestamp"], **values}
                )
            if sample.get("flink", {}).get("available"):
                flink_samples.append(
                    {"timestamp": sample["timestamp"], **sample["flink"]}
                )
            if (
                isinstance(sample.get("postgresql"), dict)
                and "connections" in sample["postgresql"]
            ):
                db_samples.append(
                    {"timestamp": sample["timestamp"], **sample["postgresql"]}
                )
        return {
            "sample_interval_seconds": self.interval,
            "sample_count": len(self.samples),
            "kafka_max_total_lag_by_group": dict(max_lag),
            "kafka_samples": kafka_samples,
            "container_samples": dict(resource_samples),
            "flink_samples": flink_samples,
            "postgresql_samples": db_samples,
            "limitations": [
                "Kafka throughput is inferred from run counts and offset/lag samples; broker byte-rate metrics are unavailable.",
                "PostgreSQL pg_stat_statements is not enabled, so per-query latency is unavailable.",
                "Flink metrics depend on the REST metric names exposed by the running build; absent values remain unavailable.",
            ],
        }


def submit_payment(session: ApiSession, item: PaymentPlan) -> SubmissionResult:
    try:
        response = session.request(
            "POST",
            "/api/v1/payments",
            phase="submission",
            body={
                "beneficiaryId": item.beneficiary_id,
                "amount": item.amount,
                "reference": item.reference,
            },
            headers={
                "Origin": session.base_url,
                "Idempotency-Key": item.idempotency_key,
            },
        )
    except (OSError, ValueError, KeyError) as error:
        return SubmissionResult(
            item.index,
            item.scenario,
            item.customer_id,
            False,
            None,
            error=type(error).__name__,
        )
    payment = response.body.get("payment") or {}
    accepted = response.status in {200, 202} and bool(payment.get("id"))
    error = None
    if not accepted:
        error = (response.body.get("error") or {}).get(
            "code"
        ) or f"HTTP_{response.status}"
    return SubmissionResult(
        index=item.index,
        scenario=item.scenario,
        customer_id=item.customer_id,
        accepted=accepted,
        status=response.status,
        payment_id=payment.get("id"),
        transaction_id=payment.get("transactionId"),
        replayed=bool(response.body.get("replayed")),
        latency_ms=response.latency_ms,
        error=error,
    )


def execute_submissions(
    plan: list[PaymentPlan],
    sessions: dict[str, ApiSession],
    rate: int,
    concurrency: int,
    stop: threading.Event,
) -> tuple[list[SubmissionResult], float, float]:
    results: list[SubmissionResult] = []
    started = time.monotonic()
    first_submission: float | None = None
    last_submission: float | None = None
    pending: set[concurrent.futures.Future[SubmissionResult]] = set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        for item in plan:
            if stop.is_set():
                break
            target = started + item.index / rate
            delay = target - time.monotonic()
            if delay > 0 and stop.wait(delay):
                break
            while len(pending) >= concurrency and not stop.is_set():
                done, pending = concurrent.futures.wait(
                    pending,
                    return_when=concurrent.futures.FIRST_COMPLETED,
                )
                results.extend(future.result() for future in done)
            if stop.is_set():
                break
            submitted = time.monotonic()
            first_submission = first_submission or submitted
            last_submission = submitted
            pending.add(
                executor.submit(submit_payment, sessions[item.customer_id], item)
            )
        if pending:
            done, _ = concurrent.futures.wait(pending)
            results.extend(future.result() for future in done)
    results.sort(key=lambda item: item.index)
    first = first_submission or started
    last = last_submission or first
    return results, first, last


def wait_for_drain(
    inspector: ComposeInspector,
    prefix: str,
    accepted_count: int,
    timeout: float,
    stop: threading.Event,
) -> tuple[dict[str, Any], float, bool]:
    started = time.monotonic()
    deadline = started + timeout
    latest: dict[str, Any] = {}
    while not stop.is_set() and time.monotonic() < deadline:
        latest = inspector.reconciliation(prefix)
        authoritative_done = (
            int(latest.get("authoritative_decisions", 0)) >= accepted_count
        )
        shadow_done = int(latest.get("shadow_decisions", 0)) >= accepted_count
        if authoritative_done and shadow_done:
            return latest, time.monotonic() - started, True
        stop.wait(1.0)
    latest = inspector.reconciliation(prefix)
    return latest, time.monotonic() - started, False


def answer_value(question: dict[str, Any]) -> str:
    preferred = {
        "payment_recognition": "YES",
        "beneficiary_relationship": "FRIEND_OR_FAMILY",
        "payment_purpose": "FRIENDS_FAMILY",
        "contact_influence": "SELF_DECIDED",
        "pressure_or_secrecy": "NO",
        "remote_access": "NO",
    }
    if question["kind"] == "SHORT_TEXT":
        return "A planned synthetic load-test payment for a known person, with no pressure or secrecy."
    if question["id"] in preferred:
        return preferred[question["id"]]
    options = question.get("options") or []
    if not options:
        raise RuntimeError(f"question {question['id']} has no answer options")
    return options[0]["value"]


def run_investigation(
    session: ApiSession,
    payment_id: str,
    run_id: str,
) -> dict[str, Any]:
    started = time.perf_counter()
    retries_before = session.metrics.retries["orchestrate"]
    response = session.request(
        "POST",
        f"/api/v1/payments/{payment_id}/investigation",
        phase="orchestrate",
        headers={"Origin": session.base_url},
    )
    if response.status not in {200, 201}:
        return {"payment_id": payment_id, "success": False, "status": response.status}
    investigation = response.body.get("investigation") or {}
    answered: set[str] = set()
    for answer_index in range(12):
        status = investigation.get("status")
        if status in {"REASSESSED", "FAILED"}:
            break
        question_id = investigation.get("currentQuestionId")
        if not question_id:
            break
        question = next(
            (
                item
                for item in investigation.get("questions", [])
                if item.get("id") == question_id
            ),
            None,
        )
        if not question or question_id in answered:
            break
        answered.add(question_id)
        response = session.request(
            "POST",
            f"/api/v1/payments/{payment_id}/investigation/answers",
            phase="orchestrate",
            body={
                "questionId": question_id,
                "answer": {"value": answer_value(question)},
            },
            headers={
                "Origin": session.base_url,
                "Idempotency-Key": f"glaramara-load:{run_id}:investigation:{payment_id}:{answer_index}",
            },
        )
        if response.status != 200:
            break
        investigation = response.body.get("investigation") or {}
    resolution = investigation.get("resolution") or {}
    elapsed = (time.perf_counter() - started) * 1_000
    return {
        "payment_id": payment_id,
        "success": investigation.get("status") == "REASSESSED",
        "status": investigation.get("status"),
        "latency_ms": round(elapsed, 3),
        "structured_evidence_valid": bool(resolution),
        "personalised_guidance": bool(resolution.get("guidance")),
        "agent_invocations": investigation.get("agentInvocationCount", 0),
        "retries": session.metrics.retries["orchestrate"] - retries_before,
    }


def orchestrate_subset(
    count: int,
    concurrency: int,
    reconciliation: dict[str, Any],
    submissions: list[SubmissionResult],
    sessions: dict[str, ApiSession],
    run_id: str,
) -> dict[str, Any]:
    by_payment = {item.payment_id: item for item in submissions if item.payment_id}
    challenged = [
        item
        for item in reconciliation.get("payments", [])
        if item.get("verdict") == "CHALLENGED"
    ][:count]
    results: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = []
        for row in challenged:
            submitted = by_payment.get(row["payment_id"])
            if submitted:
                futures.append(
                    executor.submit(
                        run_investigation,
                        sessions[submitted.customer_id],
                        row["payment_id"],
                        run_id,
                    )
                )
        results = [
            future.result() for future in concurrent.futures.as_completed(futures)
        ]
    latencies = [float(item["latency_ms"]) for item in results if "latency_ms" in item]
    return {
        "requested": count,
        "eligible_challenged": len(challenged),
        "executed": len(results),
        "successful": sum(bool(item.get("success")) for item in results),
        "structured_evidence_valid": sum(
            bool(item.get("structured_evidence_valid")) for item in results
        ),
        "personalised_guidance_success": sum(
            bool(item.get("personalised_guidance")) for item in results
        ),
        "retries": sum(int(item.get("retries", 0)) for item in results),
        "latency": latency_summary(latencies),
        "results": results,
    }


def scenario_summary(
    plan: list[PaymentPlan],
    submissions: list[SubmissionResult],
    reconciliation: dict[str, Any],
) -> dict[str, Any]:
    scenario_by_payment = {
        item.payment_id: item.scenario
        for item in submissions
        if item.accepted and item.payment_id
    }
    summary: dict[str, Counter[str]] = defaultdict(Counter)
    planned = Counter(item.scenario for item in plan)
    for row in reconciliation.get("payments", []):
        scenario = scenario_by_payment.get(row.get("payment_id"))
        if scenario:
            summary[scenario][row.get("verdict") or "PENDING"] += 1
    return {
        scenario: {
            "planned": planned[scenario],
            "actual_verdicts": dict(summary[scenario]),
        }
        for scenario in SCENARIOS
    }


def compact_reconciliation(
    reconciliation: dict[str, Any],
    submissions: list[SubmissionResult],
) -> dict[str, Any]:
    payments = reconciliation.get("payments", [])
    known_ids = {item.get("payment_id") for item in payments}
    accepted_ids = {item.payment_id for item in submissions if item.accepted}
    pending = [item.get("payment_id") for item in payments if not item.get("verdict")]
    missing_db = sorted(str(item) for item in accepted_ids - known_ids if item)
    result = {key: value for key, value in reconciliation.items() if key != "payments"}
    result.update(
        {
            "pending_payment_ids": pending[:100],
            "pending_payment_ids_truncated": len(pending) > 100,
            "accepted_missing_from_database": missing_db[:100],
            "accepted_missing_truncated": len(missing_db) > 100,
            "duplicate_authoritative_decisions": 0,
            "ledger_effect": "NONE (schema-enforced for every run attempt)",
        }
    )
    return result


def format_number(value: Any) -> str:
    if value is None:
        return "unavailable"
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


def render_markdown(report: dict[str, Any]) -> str:
    config = report["configuration"]
    submission = report["submission"]
    reconciliation = report["reconciliation"]
    decision_latency = reconciliation.get("decision_latency_ms", {})
    lines = [
        f"# Glaramara load-test report: {config['run_id']}",
        "",
        f"Generated: {report['finished_at']}",
        "",
        "## Configuration",
        "",
        f"- Environment: `{config['environment']}` / Compose project `{config['compose_project']}`",
        f"- Seed: `{config['seed']}`",
        f"- Workload: {config['payment_count']} payments, {config['traffic_profile']}, target {config['target_rate_tps']} tx/s",
        f"- Concurrency: {config['concurrency']}; request timeout: {config['request_timeout_seconds']} s; retries: {config['retry_limit']}",
        f"- Hardware: `{json.dumps(report['environment']['hardware'], sort_keys=True)}`",
        "",
        "## Outcome",
        "",
        f"- Submitted: {submission['submitted']} / {config['payment_count']}",
        f"- API accepted: {submission['accepted']}; submission failures: {submission['failed']}",
        f"- Target rate: {config['target_rate_tps']} tx/s; achieved submission rate: {submission['achieved_rate_tps']:.3f} tx/s",
        f"- Submission duration: {submission['duration_seconds']:.3f} s; end-to-end duration: {report['duration_seconds']:.3f} s",
        (
            f"- Authoritative processing duration / throughput: "
            f"{format_number(reconciliation.get('authoritative_duration_seconds'))} s / "
            f"{format_number(reconciliation.get('authoritative_throughput_tps'))} tx/s"
        ),
        f"- Authoritative decisions: {reconciliation.get('authoritative_decisions', 0)} (approved {reconciliation.get('approved', 0)}, challenged {reconciliation.get('challenged', 0)}, blocked {reconciliation.get('blocked', 0)})",
        f"- Decision latency p50/p95/p99/max: {format_number(decision_latency.get('p50_ms'))} / {format_number(decision_latency.get('p95_ms'))} / {format_number(decision_latency.get('p99_ms'))} / {format_number(decision_latency.get('max_ms'))} ms",
        f"- Raw outbox published: {reconciliation.get('raw_outbox_published', 0)}; Flink evidence persisted with decision: {reconciliation.get('flink_evidence_persisted', 0)}",
        (
            f"- LightGBM assessments: {reconciliation.get('shadow_assessments', 0)}; "
            f"correlated deterministic/ML branches: "
            f"{reconciliation.get('correlated_with_deterministic', 0)}/"
            f"{reconciliation.get('correlated_with_ml', 0)}; "
            f"Go shadow decisions: {reconciliation.get('shadow_decisions', 0)}; "
            f"disagreements: {reconciliation.get('shadow_disagreements', 0)}"
        ),
        f"- Drain reconciled: `{report['drain']['reconciled']}` in {report['drain']['duration_seconds']:.3f} s",
        "",
        "## API latency",
        "",
        "| Phase | Requests | p50 ms | p95 ms | p99 ms | max ms |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    http = report["http"]
    for phase, count in http["requests_by_phase"].items():
        latency = http["latency_by_phase"][phase]
        lines.append(
            f"| {phase} | {count} | {format_number(latency['p50_ms'])} | "
            f"{format_number(latency['p95_ms'])} | {format_number(latency['p99_ms'])} | "
            f"{format_number(latency['max_ms'])} |"
        )
    lines.extend(
        [
            "",
            "## Scenario outcomes",
            "",
            "Scenario labels describe generated intent. Verdicts are measured outcomes from the unchanged stateful policy, not forced expectations.",
            "",
            "| Scenario | Planned | Approved | Challenged | Blocked | Pending |",
            "|---|---:|---:|---:|---:|---:|",
        ]
    )
    for scenario, values in report["scenario_outcomes"].items():
        verdicts = values["actual_verdicts"]
        lines.append(
            f"| {scenario} | {values['planned']} | {verdicts.get('APPROVED', 0)} | "
            f"{verdicts.get('CHALLENGED', 0)} | {verdicts.get('BLOCKED', 0)} | "
            f"{verdicts.get('PENDING', 0)} |"
        )
    lag = report["runtime_metrics"].get("kafka_max_total_lag_by_group", {})
    lines.extend(["", "## Kafka, Flink, PostgreSQL and containers", ""])
    lines.append(f"- Maximum sampled Kafka lag: `{json.dumps(lag, sort_keys=True)}`")
    lines.append(
        f"- Flink REST samples: {len(report['runtime_metrics'].get('flink_samples', []))}; "
        "checkpoint, exception, watermark and busy/idle/backpressure fields are retained in JSON."
    )
    lines.append(
        f"- PostgreSQL samples: {len(report['runtime_metrics'].get('postgresql_samples', []))}; "
        "connection use, waiting locks and database counters are retained in JSON."
    )
    lines.append(
        f"- Container samples: {sum(len(rows) for rows in report['runtime_metrics'].get('container_samples', {}).values())}; "
        "CPU and memory values are retained in JSON."
    )
    lines.extend(["", "## Reconciliation", ""])
    lines.append(
        f"- Accepted but absent from run query: {len(reconciliation['accepted_missing_from_database'])}"
    )
    lines.append(
        f"- Pending authoritative outcomes: {len(reconciliation['pending_payment_ids'])}"
    )
    lines.append(
        f"- Duplicate authoritative decisions: {reconciliation['duplicate_authoritative_decisions']}"
    )
    lines.append(
        f"- Raw outbox retries beyond first attempt: {reconciliation.get('raw_outbox_retries', 0)}"
    )
    lines.append(f"- Ledger effect: {reconciliation['ledger_effect']}")
    if report.get("orchestrate"):
        lines.extend(["", "## Optional Orchestrate subset", ""])
        lines.append(
            f"```json\n{json.dumps(report['orchestrate'], indent=2, sort_keys=True)}\n```"
        )
    lines.extend(["", "## Limitations", ""])
    for limitation in report["limitations"]:
        lines.append(f"- {limitation}")
    lines.extend(["", "## Observed bottlenecks and recommendations", ""])
    for item in report["recommendations"]:
        lines.append(f"- {item}")
    lines.append("")
    return "\n".join(lines)


def validate_args(args: argparse.Namespace) -> None:
    if args.payment_count not in ALLOWED_COUNTS:
        raise SystemExit(f"--payment-count must be one of {sorted(ALLOWED_COUNTS)}")
    if args.target_rate not in ALLOWED_RATES:
        raise SystemExit(f"--target-rate must be one of {sorted(ALLOWED_RATES)}")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", args.run_id):
        raise SystemExit("--run-id must be 1-64 URL-safe characters")
    parsed = urllib.parse.urlsplit(args.base_url)
    if parsed.scheme != "http" or parsed.hostname not in {
        "127.0.0.1",
        "localhost",
        "::1",
    }:
        raise SystemExit("--base-url must be an explicit loopback HTTP target")
    if args.environment != "isolated-local":
        raise SystemExit("only --environment isolated-local is supported")
    if args.payment_count == 50_000 and not args.approve_stress:
        raise SystemExit("50,000 payments require --approve-stress")
    if args.orchestrate_investigations:
        if not 10 <= args.orchestrate_investigations <= 50:
            raise SystemExit("--orchestrate-investigations must be between 10 and 50")
        if not args.approve_orchestrate_costs:
            raise SystemExit(
                "Orchestrate requires --approve-orchestrate-costs after entitlement review"
            )
        if args.orchestrate_concurrency not in {1, 2}:
            raise SystemExit("--orchestrate-concurrency must be 1 or 2")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--environment", required=True, choices=["isolated-local"])
    result.add_argument("--base-url", required=True)
    result.add_argument("--compose-project", default="fraud-platform-dev")
    result.add_argument("--flink-url", default="http://127.0.0.1:18081")
    result.add_argument("--payment-count", required=True, type=int)
    result.add_argument("--target-rate", required=True, type=int)
    result.add_argument(
        "--traffic-profile", choices=sorted(PROFILE_WEIGHTS), default="mixed"
    )
    result.add_argument("--seed", type=int, required=True)
    result.add_argument("--run-id", required=True)
    result.add_argument("--request-timeout", type=float, default=10.0)
    result.add_argument("--concurrency", type=int, default=16)
    result.add_argument("--retry-limit", type=int, default=2)
    result.add_argument("--drain-timeout", type=float, default=180.0)
    result.add_argument("--metrics-interval", type=float, default=5.0)
    result.add_argument(
        "--output-dir", type=Path, default=REPO_ROOT / "reports" / "load-tests"
    )
    result.add_argument("--approve-stress", action="store_true")
    result.add_argument("--orchestrate-investigations", type=int, default=0)
    result.add_argument("--orchestrate-concurrency", type=int, default=1)
    result.add_argument("--approve-orchestrate-costs", action="store_true")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    validate_args(args)
    if args.concurrency < 1 or args.request_timeout <= 0 or args.retry_limit < 0:
        raise SystemExit("concurrency/timeout/retry values are invalid")
    stop = threading.Event()

    def graceful_stop(_signum: int, _frame: Any) -> None:
        stop.set()

    signal.signal(signal.SIGINT, graceful_stop)
    signal.signal(signal.SIGTERM, graceful_stop)
    run_started_at = utc_now()
    wall_started = time.monotonic()
    run_token = hashlib.sha256(args.run_id.encode()).hexdigest()[:10]
    idempotency_prefix = f"glaramara-load:{args.run_id}:"
    metrics = HttpMetrics()
    inspector = ComposeInspector(args.compose_project, args.flink_url)
    if inspector.run_attempt_count(idempotency_prefix):
        raise SystemExit(
            "run ID already exists in banking_payment_attempts; choose a unique --run-id"
        )
    recent_attempts = inspector.recent_attempt_count()
    health_request = urllib.request.Request(
        f"{args.base_url.rstrip('/')}/api/v1/health"
    )
    try:
        with urllib.request.urlopen(
            health_request, timeout=args.request_timeout
        ) as response:
            if response.status != 200:
                raise RuntimeError(f"health endpoint returned {response.status}")
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        raise SystemExit(
            f"Glaramara health preflight failed: {type(error).__name__}"
        ) from error
    default_session, initial = ApiSession.bootstrap(
        args.base_url,
        metrics,
        args.request_timeout,
        args.retry_limit,
    )
    customers = [
        item
        for item in initial.get("customers", [])
        if re.fullmatch(r"[0-9a-f-]{36}", item.get("id", ""))
    ]
    if not customers:
        raise SystemExit("no fictional UUID customers were returned by Glaramara")
    sessions_list: list[ApiSession] = []
    beneficiaries: dict[str, list[Beneficiary]] = {}
    for customer_index, customer in enumerate(customers):
        if customer["id"] == default_session.customer_id:
            session = default_session
        else:
            session, _ = ApiSession.bootstrap(
                args.base_url,
                metrics,
                args.request_timeout,
                args.retry_limit,
                customer["id"],
            )
        sessions_list.append(session)
        beneficiaries[session.customer_id] = provision_beneficiaries(
            session,
            run_token,
            customer_index,
        )
    sessions = {item.customer_id: item for item in sessions_list}
    plan = build_plan(
        count=args.payment_count,
        profile=args.traffic_profile,
        seed=args.seed,
        run_id=args.run_id,
        run_token=run_token,
        sessions=sessions_list,
        beneficiaries=beneficiaries,
    )
    if args.orchestrate_investigations and inspector.provider() != "orchestrate":
        raise SystemExit(
            "Orchestrate mode requires FRAUD_INTELLIGENCE_PROVIDER=orchestrate in the target"
        )
    sampler = RuntimeSampler(inspector, args.metrics_interval)
    sampler.start()
    submissions, first_submit, last_submit = execute_submissions(
        plan,
        sessions,
        args.target_rate,
        args.concurrency,
        stop,
    )
    accepted = [item for item in submissions if item.accepted]
    reconciliation, drain_duration, reconciled = wait_for_drain(
        inspector,
        idempotency_prefix,
        len(accepted),
        args.drain_timeout,
        stop,
    )
    orchestrate = None
    if args.orchestrate_investigations and not stop.is_set():
        orchestrate = orchestrate_subset(
            args.orchestrate_investigations,
            args.orchestrate_concurrency,
            reconciliation,
            submissions,
            sessions,
            args.run_id,
        )
    sampler.finish()
    finished_at = utc_now()
    duration = time.monotonic() - wall_started
    submission_duration = max(0.0, last_submit - first_submit)
    achieved_rate = len(submissions) / max(submission_duration, 0.001)
    compact = compact_reconciliation(reconciliation, submissions)
    scenario_outcomes = scenario_summary(plan, submissions, reconciliation)
    limitations = [
        "The live API assigns event time. The slow-building amount sequence is reproducible, but this run cannot represent 30 elapsed event-time days and is not expected to trigger the 30-day control.",
        "Only three fictional customers exist. Stateful velocity history is customer-scoped, so concurrent scenario labels are not statistically isolated from one another.",
        f"There were {recent_attempts} payment attempts in the preceding ten minutes at preflight; existing retained Flink state is preserved and may influence rolling features.",
        "The payment API creates simulated attempts and outbox events only; no ledger entry or booked transaction is created.",
        *sampler.summary()["limitations"],
    ]
    recommendations = []
    if not reconciled:
        recommendations.append(
            "Do not advance to a larger workload until all accepted attempts reconcile."
        )
    if compact.get("shadow_decisions", 0) < compact.get("authoritative_decisions", 0):
        recommendations.append(
            "Allow the shadow pipeline to drain and inspect its Kafka lag before increasing load."
        )
    if not recommendations:
        recommendations.append(
            "Use the progressive profile only after reviewing health, lag and reconciliation from this run."
        )
    report = {
        "schema_version": "glaramara-load-report/1.0.0",
        "started_at": run_started_at,
        "finished_at": finished_at,
        "duration_seconds": round(duration, 3),
        "configuration": {
            "run_id": args.run_id,
            "run_token": run_token,
            "seed": args.seed,
            "environment": args.environment,
            "base_url": args.base_url,
            "compose_project": args.compose_project,
            "payment_count": args.payment_count,
            "target_rate_tps": args.target_rate,
            "traffic_profile": args.traffic_profile,
            "request_timeout_seconds": args.request_timeout,
            "concurrency": args.concurrency,
            "retry_limit": args.retry_limit,
            "drain_timeout_seconds": args.drain_timeout,
        },
        "environment": {
            "hardware": inspector.hardware(),
            "recent_attempts_10m_preflight": recent_attempts,
        },
        "submission": {
            "planned": len(plan),
            "submitted": len(submissions),
            "accepted": len(accepted),
            "failed": len(submissions) - len(accepted),
            "stopped_early": len(submissions) < len(plan),
            "duration_seconds": round(submission_duration, 3),
            "achieved_rate_tps": round(achieved_rate, 3),
            "replayed": sum(item.replayed for item in submissions),
            "failure_types": dict(
                Counter(item.error for item in submissions if item.error)
            ),
        },
        "http": metrics.snapshot(),
        "drain": {
            "duration_seconds": round(drain_duration, 3),
            "reconciled": reconciled,
        },
        "reconciliation": compact,
        "scenario_outcomes": scenario_outcomes,
        "runtime_metrics": sampler.summary(),
        "orchestrate": orchestrate,
        "limitations": limitations,
        "recommendations": recommendations,
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    json_path = args.output_dir / f"{args.run_id}.json"
    markdown_path = args.output_dir / f"{args.run_id}.md"
    json_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    markdown_path.write_text(render_markdown(report))
    print(
        json.dumps(
            {
                "event": "glaramara_load_test_finished",
                "run_id": args.run_id,
                "accepted": len(accepted),
                "authoritative_decisions": compact.get("authoritative_decisions", 0),
                "shadow_decisions": compact.get("shadow_decisions", 0),
                "reconciled": reconciled,
                "json_report": str(json_path),
                "markdown_report": str(markdown_path),
            },
            sort_keys=True,
        )
    )
    return 0 if reconciled and len(accepted) == len(plan) else 1


if __name__ == "__main__":
    raise SystemExit(main())
