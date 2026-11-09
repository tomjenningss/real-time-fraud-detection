"""Run the three governed v1.1 scenarios against the live development agent."""

from __future__ import annotations

import json
import os
import statistics
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib import parse, request

HERE = Path(__file__).resolve().parent
AGENT_ID = "f7859afd-0e8d-488e-88c3-64b591330524"

QUESTIONS = {
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
    "payment_circumstances": ("Briefly explain what happened and why this payment feels urgent.", None),
    "pressure_or_secrecy": (
        "Did they ask you to act quickly, keep it secret, or ignore a bank warning?",
        ["YES", "NO", "UNSURE"],
    ),
    "remote_access": (
        "Did anyone ask you to install an app or share access to your phone or computer?",
        ["YES", "NO", "UNSURE"],
    ),
}


def context(name: str, answers: dict[str, str]) -> dict[str, Any]:
    questions = []
    for question_id in answers:
        prompt, options = QUESTIONS[question_id]
        question: dict[str, Any] = {"id": question_id, "prompt": prompt}
        if options:
            question["options"] = options
        questions.append(question)
    return {
        "schemaVersion": "fraud-intelligence-request/1.0.0",
        "questionnaireVersion": "glaramara-fraud-questionnaire/1.1.0",
        "transactionRef": f"synthetic-live-v1-1-{name}",
        "payment": {"amount": 5000, "currency": "GBP", "beneficiaryPreviouslyPaid": False},
        "deterministicSignals": ["NEW_BENEFICIARY_HIGH_VALUE"],
        "requiredEvidenceKeys": [
            "payment_recognition",
            "beneficiary_relationship",
            "payment_purpose",
        ],
        "questions": questions,
        "answers": [
            {"questionId": question_id, "value": value, "provenance": "CUSTOMER"}
            for question_id, value in answers.items()
        ],
    }


def iam_token() -> str:
    api_key = os.environ["WATSONX_ORCHESTRATE_API_KEY"]
    body = parse.urlencode(
        {
            "grant_type": "urn:ibm:params:oauth:grant-type:apikey",
            "apikey": api_key,
        }
    ).encode()
    token_request = request.Request(
        "https://iam.cloud.ibm.com/identity/token",
        data=body,
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with request.urlopen(token_request, timeout=30) as response:
        payload = json.load(response)
    token = payload.get("access_token")
    if not isinstance(token, str) or not token:
        raise RuntimeError("IBM IAM returned no access token")
    return token


def find_schema_evidence(value: Any) -> dict[str, Any] | None:
    if isinstance(value, str):
        candidate = value.strip()
        fence = chr(96) * 3
        if candidate.startswith(fence):
            candidate = candidate.removeprefix(f"{fence}json").removeprefix(fence).removesuffix(fence).strip()
        try:
            return find_schema_evidence(json.loads(candidate))
        except (json.JSONDecodeError, TypeError):
            return None
    if isinstance(value, list):
        for item in value:
            evidence = find_schema_evidence(item)
            if evidence is not None:
                return evidence
        return None
    if isinstance(value, dict):
        schema_version = value.get("schemaVersion")
        if schema_version in {
            "fraud-intelligence-evidence/1.1.0",
            "fraud-intelligence-evidence/1.2.0",
        }:
            return value
        for item in value.values():
            evidence = find_schema_evidence(item)
            if evidence is not None:
                return evidence
    return None


def invoke_rest(
    payload: dict[str, Any], access_token: str, agent_id: str = AGENT_ID
) -> dict[str, Any]:
    base_url = os.environ["WATSONX_ORCHESTRATE_URL"].rstrip("/")
    endpoint = f"{base_url}/v1/orchestrate/{agent_id}/chat/completions"
    body = json.dumps(
        {
            "messages": [{"role": "user", "content": json.dumps(payload)}],
            "stream": False,
        }
    ).encode()
    rest_request = request.Request(
        endpoint,
        data=body,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    started = time.monotonic()
    with request.urlopen(rest_request, timeout=90) as response:
        response_payload = json.load(response)
    evidence = find_schema_evidence(response_payload)
    return {
        "evidence": evidence,
        "latencyMs": round((time.monotonic() - started) * 1000),
        "rawResponse": response_payload,
    }


def governed_policy(evidence: dict[str, Any]) -> dict[str, Any]:
    process = subprocess.run(
        ["node", str(HERE / "evaluate_policy.mjs")],
        input=json.dumps(evidence),
        text=True,
        check=True,
        capture_output=True,
    )
    return json.loads(process.stdout)


def schema_and_provenance_valid(evidence: dict[str, Any], payload: dict[str, Any]) -> bool:
    required = {
        "schemaVersion",
        "paymentRecognition",
        "beneficiaryRelationship",
        "paymentPurpose",
        "thirdPartyInfluence",
        "verificationClaims",
        "scamIndicators",
        "contradictions",
        "uncertainty",
        "missingEvidence",
        "provenance",
        "clarificationQuestion",
    }
    if set(evidence) != required or evidence.get("schemaVersion") != "fraud-intelligence-evidence/1.1.0":
        return False
    answer_map = {item["questionId"]: item["value"] for item in payload["answers"]}
    provenance = evidence.get("provenance")
    if not isinstance(provenance, list) or len(provenance) < 4:
        return False
    for item in provenance:
        if not isinstance(item, dict) or set(item) != {"findingId", "claim", "sources"}:
            return False
        if not isinstance(item["sources"], list) or not item["sources"]:
            return False
        for source in item["sources"]:
            if not isinstance(source, dict) or set(source) != {"questionId", "excerpt"}:
                return False
            answer = answer_map.get(source["questionId"])
            if not isinstance(answer, str) or source["excerpt"] not in answer:
                return False
    finding_ids = {item["findingId"] for item in provenance}
    required_finding_ids = {
        "paymentRecognition",
        "beneficiaryRelationship",
        "paymentPurpose",
        "thirdPartyInfluence",
        *{f"verificationClaim:{item}" for item in evidence.get("verificationClaims", [])},
        *{
            f"scamIndicator:{item}"
            for item in evidence.get("scamIndicators", [])
            if item != "NONE"
        },
    }
    if not required_finding_ids.issubset(finding_ids):
        return False
    return (
        isinstance(evidence.get("verificationClaims"), list)
        and isinstance(evidence.get("scamIndicators"), list)
        and isinstance(evidence.get("contradictions"), list)
        and isinstance(evidence.get("missingEvidence"), list)
        and evidence.get("uncertainty") in {"LOW", "MEDIUM", "HIGH"}
    )


ScenarioGrader = Callable[[dict[str, Any], dict[str, Any]], bool]

SCENARIOS: list[tuple[str, dict[str, Any], ScenarioGrader]] = [
    (
        "builder-service-payment",
        context(
            "builder-service-payment",
            {
                "payment_recognition": "YES",
                "beneficiary_relationship": "NEW_RECIPIENT",
                "payment_purpose": "GOODS_SERVICES",
                "contact_influence": "NO",
                "payment_circumstances": (
                    "I’m paying a builder for the kitchen renovation. I’ve met him, checked his details "
                    "and received an invoice."
                ),
            },
        ),
        lambda evidence, policy: (
            evidence["paymentPurpose"] == "GOODS_OR_SERVICES"
            and evidence["thirdPartyInfluence"] == "NONE"
            and set(evidence["verificationClaims"])
            == {
                "MET_BENEFICIARY_IN_PERSON",
                "CHECKED_BENEFICIARY_DETAILS",
                "INVOICE_RECEIVED",
            }
            and evidence["scamIndicators"] == ["NONE"]
            and policy["outcome"] == "ADDITIONAL_VERIFICATION"
            and policy["policyTrace"][0]["ruleId"]
            == "CER-ADDITIONAL-VERIFY-NARROW-SERVICE-PAYMENT"
        ),
    ),
    (
        "safe-account-scam",
        context(
            "safe-account-scam",
            {
                "payment_recognition": "YES",
                "beneficiary_relationship": "NEW_RECIPIENT",
                "payment_purpose": "SAFE_ACCOUNT",
                "contact_influence": "UNEXPECTED",
                "payment_circumstances": (
                    "Someone from my bank called and told me my account was compromised. They said I need "
                    "to transfer the money to a safe account immediately."
                ),
                "pressure_or_secrecy": "YES",
                "remote_access": "NO",
            },
        ),
        lambda evidence, policy: (
            {"SAFE_ACCOUNT", "BANK_IMPERSONATION", "URGENCY"}.issubset(evidence["scamIndicators"])
            and evidence["thirdPartyInfluence"] == "BANK_IMPERSONATION"
            and policy["outcome"] == "DECLINED"
            and policy["policyTrace"][0]["ruleId"] == "CER-DECLINE-SAFE-ACCOUNT"
        ),
    ),
    (
        "ambiguous-evidence",
        context(
            "ambiguous-evidence",
            {
                "payment_recognition": "YES",
                "beneficiary_relationship": "UNSURE",
                "payment_purpose": "GOODS_SERVICES",
                "contact_influence": "NO",
                "payment_circumstances": "I think this is for some work, but I am not sure who I am paying.",
            },
        ),
        lambda evidence, policy: (
            evidence["beneficiaryRelationship"] == "UNCERTAIN"
            and evidence["uncertainty"] in {"MEDIUM", "HIGH"}
            and policy["outcome"] == "REFER_TO_ANALYST"
            and policy["policyTrace"][0]["ruleId"] == "CER-REFER-UNRELIABLE-EVIDENCE"
        ),
    ),
]


def main() -> int:
    results = []
    access_token = iam_token()
    for name, payload, grader in SCENARIOS:
        live = invoke_rest(payload, access_token)
        evidence = live["evidence"]
        evidence_valid = schema_and_provenance_valid(evidence, payload)
        policy = governed_policy(evidence if evidence_valid else {"schemaVersion": "invalid"})
        passed = evidence_valid and grader(evidence, policy)
        results.append(
            {
                "name": name,
                "passed": passed,
                "latencyMs": live["latencyMs"],
                "evidence": evidence,
                "policy": policy,
            }
        )
    latencies = [item["latencyMs"] for item in results]
    report = {
        "agent": "fraud_intelligence",
        "agentVersion": "1.1.0",
        "evidenceSchemaVersion": "fraud-intelligence-evidence/1.1.0",
        "policyVersion": "customer-evidence-reassessment/1.1.0",
        "model": os.getenv("FRAUD_INTELLIGENCE_EVAL_MODEL", "groq/openai/gpt-oss-120b"),
        "transport": "watsonx-orchestrate-rest-chat-completions",
        "scenarios": results,
        "passed": sum(1 for item in results if item["passed"]),
        "total": len(results),
        "latencyMs": {
            "mean": round(statistics.mean(latencies)),
            "median": round(statistics.median(latencies)),
            "max": max(latencies),
        },
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["passed"] == report["total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
