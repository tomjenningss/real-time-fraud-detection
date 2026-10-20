#!/usr/bin/env python3
"""Unique, near-real-time fixture for the controlled raw-to-decision test."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import uuid
from datetime import UTC, datetime, timedelta


def payment(tx: str, user: str, merchant: str, amount: float, at: datetime) -> dict:
    return {
        "transaction_id": tx,
        "user_id": user,
        "merchant_id": merchant,
        "amount": round(amount, 2),
        "device_id": f"device-{user}",
        "payment_channel": "CARD_PRESENT",
        "event_time": at.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
    }


def generate(run_id: str, base: datetime) -> list[dict]:
    prefix = f"controlled-{run_id}"
    rows = []
    for index, amount in enumerate((20.0, 30.0, 40.0)):
        rows.append(
            payment(
                f"{prefix}-normal-{index}",
                f"{prefix}-normal-user",
                f"normal-shop-{index}",
                amount,
                base + timedelta(milliseconds=index * 300),
            )
        )
    for index in range(6):
        rows.append(
            payment(
                f"{prefix}-velocity-{index}",
                f"{prefix}-velocity-user",
                "repeat-shop",
                10 + index,
                base + timedelta(seconds=1, milliseconds=index * 200),
            )
        )
    for index in range(7):
        rows.append(
            payment(
                f"{prefix}-hopping-{index}",
                f"{prefix}-hopping-user",
                f"hop-shop-{index}",
                30 + index,
                base + timedelta(seconds=3, milliseconds=index * 200),
            )
        )
    rows.append(
        payment(
            f"{prefix}-watermark",
            "__watermark__",
            "__none__",
            0,
            base + timedelta(seconds=7),
        )
    )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", default=uuid.uuid4().hex[:12])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    base = datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=2)
    rows = generate(args.run_id, base)
    payload = "\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n"
    if args.dry_run:
        print(payload, end="")
    else:
        subprocess.run(
            [
                "podman", "compose", "exec", "-T", "kafka", "kafka-console-producer",
                "--bootstrap-server", "kafka:29092", "--topic", "payments.raw.demo",
            ],
            input=payload, text=True, check=True,
        )
    print(
        json.dumps(
            {
                "run_id": args.run_id,
                "logical_transactions": 16,
                "watermark_markers": 1,
                "expected_payment_verdicts": {"APPROVED": 11, "CHALLENGED": 2, "BLOCKED": 3},
                "expected_investigations": 5,
            },
            separators=(",", ":"),
        ),
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
