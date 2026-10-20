from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from pydantic import ValidationError

from .audit import persist_audit
from .config import load_settings
from .schemas import InvestigationInput
from .supervisor import Supervisor


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Investigate one stored enriched transaction")
    result.add_argument("--input", required=True, type=Path, help="Stored investigation JSON")
    result.add_argument("--mode", choices=("dry-run", "live"), default="dry-run")
    result.add_argument(
        "--approve-live",
        action="store_true",
        help="Required acknowledgement for one paid live investigation",
    )
    result.add_argument("--audit-dir", type=Path, default=Path("audit_records"))
    return result


async def execute(args: argparse.Namespace) -> int:
    if args.mode == "live" and not args.approve_live:
        print("Live mode requires --approve-live; no API request was made.", file=sys.stderr)
        return 2
    try:
        event = InvestigationInput.model_validate_json(args.input.read_text())
        settings = load_settings(mode_override=args.mode)
    except (OSError, ValidationError, ValueError) as error:
        print(f"Input/configuration error: {type(error).__name__}", file=sys.stderr)
        return 2
    settings.audit_directory = args.audit_dir
    outcome = await Supervisor(settings).investigate(event)
    if settings.audit_enabled:
        audit_path = persist_audit(outcome.audit, settings.audit_directory)
        print(f"audit_record={audit_path}", file=sys.stderr)
    print(
        f"model_calls={len(outcome.audit.model_usage)} "
        f"estimated_cost_usd={outcome.audit.estimated_api_cost_usd:.8f}",
        file=sys.stderr,
    )
    # Standard output is deliberately restricted to the external three-field contract.
    print(json.dumps(outcome.recommendation.model_dump(mode="json"), separators=(",", ":")))
    return 0


def main() -> None:
    raise SystemExit(asyncio.run(execute(parser().parse_args())))


if __name__ == "__main__":
    main()
