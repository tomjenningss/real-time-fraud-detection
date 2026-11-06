#!/usr/bin/env python3
"""Run one bounded ADK/REST parity scenario without persisting credentials."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
AGENT_DIR = HERE.parent
sys.path.insert(0, str(AGENT_DIR))

from evaluate_live import iam_token, invoke_rest  # noqa: E402
from run_agent import invoke as invoke_adk_agent  # noqa: E402

QUESTIONS: dict[str, tuple[str, list[str] | None]] = {
    "payment_recognition": ("Did you make this payment yourself?", ["YES", "NO", "UNSURE"]),
    "beneficiary_relationship": (
        "How do you know the person or business you’re paying?",
        ["KNOWN_PERSON", "KNOWN_BUSINESS", "NEW_RECIPIENT", "UNSURE"],
    ),
    "payment_purpose": (
        "What is this payment for?",
        ["FRIENDS_FAMILY", "GOODS_SERVICES", "INVESTMENT", "SAFE_ACCOUNT", "OTHER"],
    ),
    "contact_influence": (
        "Did anyone contact you or guide you through making this payment?",
        ["NO", "EXPECTED", "UNEXPECTED"],
    ),
    "payment_circumstances": (
        "Briefly explain what happened and why this payment feels urgent.",
        None,
    ),
    "other_purpose": ("Tell us what the payment is for.", None),
    "pressure_or_secrecy": (
        "Did they ask you to act quickly, keep it secret, or ignore a bank warning?",
        ["YES", "NO", "UNSURE"],
    ),
    "remote_access": (
        "Did anyone ask you to install an app or share access to your phone or computer?",
        ["YES", "NO", "UNSURE"],
    ),
}


def build_context(scenario: dict[str, Any]) -> dict[str, Any]:
    questions = []
    for question_id in scenario["answers"]:
        prompt, options = QUESTIONS[question_id]
        question: dict[str, Any] = {"id": question_id, "prompt": prompt}
        if options:
            question["options"] = options
        questions.append(question)
    payment = scenario.get("payment", {})
    return {
        "schemaVersion": "fraud-intelligence-request/1.0.0",
        "questionnaireVersion": "glaramara-fraud-questionnaire/1.1.0",
        "transactionRef": f"evaluation-{scenario['id']}",
        "payment": {
            "amount": payment.get("amount", 5_000),
            "currency": "GBP",
            "beneficiaryPreviouslyPaid": payment.get("beneficiaryPreviouslyPaid", False),
        },
        "deterministicSignals": payment.get(
            "deterministicSignals", ["NEW_BENEFICIARY_HIGH_VALUE"]
        ),
        "requiredEvidenceKeys": [
            "payment_recognition",
            "beneficiary_relationship",
            "payment_purpose",
        ],
        "questions": questions,
        "answers": [
            {"questionId": question_id, "value": value, "provenance": "CUSTOMER"}
            for question_id, value in scenario["answers"].items()
        ],
    }


def invoke_adk(payload: dict[str, Any]) -> dict[str, Any]:
    return invoke_adk_agent(dict(payload), timeout_seconds=45)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--scenario",
        default="investment-influencer-urgent-returns-regression",
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--transport", choices=["adk", "rest", "both"], default="both")
    args = parser.parse_args()

    suite = json.loads((HERE / "scenarios.json").read_text())
    scenario = next((item for item in suite["scenarios"] if item["id"] == args.scenario), None)
    if scenario is None:
        raise SystemExit(f"unknown scenario: {args.scenario}")
    payload = build_context(scenario)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    results = []
    if args.transport in {"adk", "both"}:
        result = invoke_adk(payload)
        results.append({
            "scenarioId": scenario["id"],
            "transport": "watsonx-orchestrate-adk",
            "latencyMs": result["latencyMs"],
            "evidence": result["evidence"],
        })
    if args.transport in {"rest", "both"}:
        if not os.getenv("WATSONX_ORCHESTRATE_API_KEY") or not os.getenv("WATSONX_ORCHESTRATE_URL"):
            raise RuntimeError("REST parity requires WATSONX_ORCHESTRATE_API_KEY and WATSONX_ORCHESTRATE_URL")
        result = invoke_rest(payload, iam_token())
        results.append({
            "scenarioId": scenario["id"],
            "transport": "watsonx-orchestrate-rest-chat-completions",
            "latencyMs": result["latencyMs"],
            "evidence": result["evidence"],
        })

    for result in results:
        target = args.output_dir / f"{scenario['id']}-{result['transport']}.json"
        target.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({
        "scenarioId": scenario["id"],
        "transports": [result["transport"] for result in results],
        "latencyMs": {result["transport"]: result["latencyMs"] for result in results},
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
