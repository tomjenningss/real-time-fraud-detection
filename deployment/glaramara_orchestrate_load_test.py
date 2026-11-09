#!/usr/bin/env python3
"""Run a bounded Orchestrate investigation subset for an existing load run."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import urllib.parse
from collections import Counter
from pathlib import Path

try:
    from deployment.glaramara_load_test import (
        REPO_ROOT,
        ApiSession,
        ComposeInspector,
        HttpMetrics,
        latency_summary,
        run_investigation,
        utc_now,
    )
except ModuleNotFoundError:  # Direct script execution resolves the sibling module.
    from glaramara_load_test import (  # type: ignore[no-redef]
        REPO_ROOT,
        ApiSession,
        ComposeInspector,
        HttpMetrics,
        latency_summary,
        run_investigation,
        utc_now,
    )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--environment", required=True, choices=["isolated-local"])
    result.add_argument("--base-url", required=True)
    result.add_argument("--compose-project", default="fraud-platform-dev")
    result.add_argument("--source-run-id", required=True)
    result.add_argument("--investigations", type=int, required=True)
    result.add_argument("--concurrency", type=int, choices=[1, 2], default=1)
    result.add_argument("--request-timeout", type=float, default=90.0)
    result.add_argument("--retry-limit", type=int, default=1)
    result.add_argument("--approve-orchestrate-costs", action="store_true")
    result.add_argument(
        "--output-dir",
        type=Path,
        default=REPO_ROOT / "reports" / "load-tests",
    )
    return result


def validate(args: argparse.Namespace) -> None:
    parsed = urllib.parse.urlsplit(args.base_url)
    if parsed.scheme != "http" or parsed.hostname not in {
        "127.0.0.1",
        "localhost",
        "::1",
    }:
        raise SystemExit("--base-url must be an explicit loopback HTTP target")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", args.source_run_id):
        raise SystemExit("--source-run-id must be 1-64 URL-safe characters")
    if not 10 <= args.investigations <= 50:
        raise SystemExit("--investigations must be between 10 and 50")
    if not args.approve_orchestrate_costs:
        raise SystemExit(
            "Orchestrate requires --approve-orchestrate-costs after entitlement review"
        )
    if args.request_timeout <= 0 or args.retry_limit < 0:
        raise SystemExit("request timeout and retry limit are invalid")


def markdown(report: dict) -> str:
    latency = report["latency"]
    persisted = report["persisted_extractions"]
    persisted_latency = persisted["latency_ms"]
    return "\n".join(
        [
            f"# Glaramara Orchestrate load report: {report['source_run_id']}",
            "",
            f"Generated: {report['finished_at']}",
            "",
            (
                "This separately invoked subset used genuinely challenged payments already created by the "
                "source load run. It traversed the Glaramara questionnaire and application extraction path; "
                "it did not call a model endpoint directly and did not submit new payments."
            ),
            "",
            f"- Requested / eligible / executed: {report['requested']} / {report['eligible']} / {report['executed']}",
            f"- Successful reassessments: {report['successful']}",
            (
                f"- Persisted model invocations: {persisted['model_invocations']} "
                f"(`{json.dumps(persisted['provider_models'], sort_keys=True)}`)"
            ),
            f"- Structured evidence validated: {report['structured_evidence_valid']}",
            f"- Personalised guidance persisted: {report['personalised_guidance_success']}",
            f"- Request retries: {report['retries']}; failures: {report['failures']}",
            (
                f"- Latency p50/p95/p99/max: {latency['p50_ms']} / {latency['p95_ms']} / "
                f"{latency['p99_ms']} / {latency['max_ms']} ms"
            ),
            (
                f"- Persisted model latency p50/p95/p99/max: {persisted_latency['p50_ms']} / "
                f"{persisted_latency['p95_ms']} / {persisted_latency['p99_ms']} / "
                f"{persisted_latency['max_ms']} ms"
            ),
            "- Original authoritative payment verdicts remain immutable `CHALLENGED`; all reassessments are simulated.",
            "",
            "Per-investigation results and HTTP status/latency counters are in the adjacent JSON report.",
            "",
        ]
    )


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    validate(args)
    metrics = HttpMetrics()
    inspector = ComposeInspector(args.compose_project, "http://127.0.0.1:18081")
    if inspector.provider() != "orchestrate":
        raise SystemExit(
            "target Glaramara must have FRAUD_INTELLIGENCE_PROVIDER=orchestrate"
        )
    prefix = f"glaramara-load:{args.source_run_id}:"
    candidates = inspector.investigation_candidates(prefix, args.investigations)
    if len(candidates) < args.investigations:
        raise SystemExit(
            f"source run has only {len(candidates)} challenged payments; "
            f"{args.investigations} were requested"
        )
    default_session, _initial = ApiSession.bootstrap(
        args.base_url,
        metrics,
        args.request_timeout,
        args.retry_limit,
    )
    customer_ids = sorted({item["customer_id"] for item in candidates})
    sessions: dict[str, ApiSession] = {}
    for customer_id in customer_ids:
        if customer_id == default_session.customer_id:
            sessions[customer_id] = default_session
        else:
            session, _ = ApiSession.bootstrap(
                args.base_url,
                metrics,
                args.request_timeout,
                args.retry_limit,
                customer_id,
            )
            sessions[customer_id] = session
    results = []
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=args.concurrency
    ) as executor:
        futures = [
            executor.submit(
                run_investigation,
                sessions[item["customer_id"]],
                item["payment_id"],
                args.source_run_id,
            )
            for item in candidates
        ]
        results = [
            future.result() for future in concurrent.futures.as_completed(futures)
        ]
    latencies = [float(item["latency_ms"]) for item in results if "latency_ms" in item]
    persisted = inspector.orchestrate_reconciliation(
        prefix, [item["payment_id"] for item in candidates]
    )
    report = {
        "schema_version": "glaramara-orchestrate-load-report/1.0.0",
        "source_run_id": args.source_run_id,
        "finished_at": utc_now(),
        "provider": "orchestrate",
        "requested": args.investigations,
        "eligible": len(candidates),
        "executed": len(results),
        "concurrency": args.concurrency,
        "successful": sum(bool(item.get("success")) for item in results),
        "structured_evidence_valid": sum(
            bool(item.get("structured_evidence_valid")) for item in results
        ),
        "personalised_guidance_success": sum(
            bool(item.get("personalised_guidance")) for item in results
        ),
        "retries": sum(int(item.get("retries", 0)) for item in results),
        "persisted_extractions": persisted,
        "failures": dict(
            Counter(
                str(item.get("status")) for item in results if not item.get("success")
            )
        ),
        "latency": latency_summary(latencies),
        "http": metrics.snapshot(),
        "results": sorted(results, key=lambda item: item["payment_id"]),
        "authority_boundary": {
            "original_verdict": "CHALLENGED",
            "reassessment_is_simulated": True,
            "ledger_effect": "NONE",
        },
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{args.source_run_id}-orchestrate"
    json_path = args.output_dir / f"{stem}.json"
    markdown_path = args.output_dir / f"{stem}.md"
    json_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    markdown_path.write_text(markdown(report))
    print(
        json.dumps(
            {
                "event": "glaramara_orchestrate_load_test_finished",
                "source_run_id": args.source_run_id,
                "executed": len(results),
                "successful": report["successful"],
                "json_report": str(json_path),
                "markdown_report": str(markdown_path),
            },
            sort_keys=True,
        )
    )
    return 0 if report["successful"] == args.investigations else 1


if __name__ == "__main__":
    raise SystemExit(main())
