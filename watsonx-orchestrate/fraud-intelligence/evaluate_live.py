"""Run bounded synthetic live checks against the imported development agent."""

from __future__ import annotations

import json
import os
import statistics

from run_agent import invoke


def context(name: str, answers: dict[str, str]) -> dict:
    questions = {
        "payment_recognition": ("Did you make this payment yourself?", ["YES", "NO", "UNSURE"]),
        "beneficiary_relationship": (
            "How do you know the recipient?",
            ["KNOWN_PERSON", "KNOWN_BUSINESS", "NEW_RECIPIENT", "UNSURE"],
        ),
        "payment_purpose": (
            "What is this payment for?",
            ["FRIENDS_FAMILY", "GOODS_SERVICES", "INVESTMENT", "SAFE_ACCOUNT", "OTHER"],
        ),
        "contact_influence": ("Did anyone guide you?", ["NO", "EXPECTED", "UNEXPECTED"]),
        "pressure_or_secrecy": (
            "Were you asked to act quickly or keep it secret?",
            ["YES", "NO", "UNSURE"],
        ),
        "remote_access": ("Were you asked to share device access?", ["YES", "NO", "UNSURE"]),
    }
    return {
        "schemaVersion": "fraud-intelligence-request/1.0.0",
        "questionnaireVersion": "glaramara-fraud-questionnaire/1.0.0",
        "transactionRef": f"synthetic-live-{name}",
        "payment": {"amount": 250, "currency": "GBP", "beneficiaryPreviouslyPaid": False},
        "deterministicSignals": ["HIGH_VELOCITY"],
        "requiredEvidenceKeys": [
            "payment_recognition",
            "beneficiary_relationship",
            "payment_purpose",
        ],
        "questions": [
            {"id": question_id, "prompt": prompt, "options": options}
            for question_id, (prompt, options) in questions.items()
            if question_id in answers
        ],
        "answers": [
            {"questionId": question_id, "value": value, "provenance": "CUSTOMER"}
            for question_id, value in answers.items()
        ],
    }


def provenance_has(evidence: dict, question_id: str, claim_fragment: str) -> bool:
    required_words = {word for word in claim_fragment.upper().split("_") if word != "OR"}
    return any(
        question_id in item["sourceQuestionIds"]
        and required_words.issubset(set(item["claim"].upper().split()))
        for item in evidence["provenance"]
    )


SCENARIOS = [
    (
        "benign-known",
        context(
            "benign-known",
            {
                "payment_recognition": "YES",
                "beneficiary_relationship": "KNOWN_PERSON",
                "payment_purpose": "FRIENDS_FAMILY",
                "contact_influence": "NO",
            },
        ),
        lambda evidence: evidence["paymentRecognition"] == "RECOGNISED"
        and evidence["beneficiaryRelationship"] == "KNOWN"
        and evidence["scamIndicators"] == ["NONE"],
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
                "pressure_or_secrecy": "YES",
                "remote_access": "NO",
            },
        ),
        lambda evidence: evidence["paymentRecognition"] == "RECOGNISED"
        and {"SAFE_ACCOUNT", "UNEXPECTED_CONTACT", "PRESSURE_OR_SECRECY"}.issubset(
            evidence["scamIndicators"]
        )
        and provenance_has(evidence, "payment_purpose", "SAFE_ACCOUNT")
        and provenance_has(evidence, "contact_influence", "UNEXPECTED_CONTACT")
        and provenance_has(evidence, "pressure_or_secrecy", "PRESSURE_OR_SECRECY"),
    ),
    (
        "unrecognised",
        context(
            "unrecognised",
            {
                "payment_recognition": "NO",
                "beneficiary_relationship": "UNSURE",
                "payment_purpose": "GOODS_SERVICES",
                "contact_influence": "NO",
            },
        ),
        lambda evidence: evidence["paymentRecognition"] == "NOT_RECOGNISED"
        and any(
            "does not recognise" in item["claim"].lower()
            for item in evidence["provenance"]
            if "payment_recognition" in item["sourceQuestionIds"]
        ),
    ),
]


def schema_valid(evidence: dict) -> bool:
    required = {
        "schemaVersion",
        "paymentRecognition",
        "beneficiaryRelationship",
        "scamIndicators",
        "contradictions",
        "uncertainty",
        "missingEvidence",
        "provenance",
        "clarificationQuestion",
    }
    clarification = evidence.get("clarificationQuestion")
    provenance = evidence.get("provenance")
    contradictions = evidence.get("contradictions")
    return (
        set(evidence) == required
        and evidence.get("schemaVersion") == "fraud-intelligence-evidence/1.0.0"
        and isinstance(evidence.get("paymentRecognition"), str)
        and isinstance(evidence.get("beneficiaryRelationship"), str)
        and isinstance(evidence.get("uncertainty"), str)
        and isinstance(evidence.get("scamIndicators"), list)
        and all(isinstance(item, str) for item in evidence["scamIndicators"])
        and isinstance(evidence.get("missingEvidence"), list)
        and all(isinstance(item, str) for item in evidence["missingEvidence"])
        and isinstance(provenance, list)
        and len(provenance) > 0
        and all(
            isinstance(item, dict)
            and set(item) == {"claim", "sourceQuestionIds"}
            and isinstance(item["claim"], str)
            and isinstance(item["sourceQuestionIds"], list)
            for item in provenance
        )
        and isinstance(contradictions, list)
        and all(
            isinstance(item, dict) and set(item) == {"summary", "sourceQuestionIds"}
            for item in contradictions
        )
        and isinstance(clarification, dict)
        and set(clarification) == {"needed", "id", "prompt", "options", "reason"}
    )


def main() -> int:
    results = []
    for name, payload, grader in SCENARIOS:
        result = invoke(payload, timeout_seconds=90)
        evidence = result["evidence"]
        passed = schema_valid(evidence) and grader(evidence)
        results.append({
            "name": name,
            "passed": passed,
            "latencyMs": result["latencyMs"],
            "evidence": evidence,
        })
    latencies = [item["latencyMs"] for item in results]
    report = {
        "agent": "fraud_intelligence",
        "model": os.getenv(
            "FRAUD_INTELLIGENCE_EVAL_MODEL",
            "groq/openai/gpt-oss-120b",
        ),
        "scenarios": results,
        "passed": sum(1 for item in results if item["passed"]),
        "total": len(results),
        "latencyMs": {
            "mean": round(statistics.mean(latencies)),
            "median": round(statistics.median(latencies)),
            "max": max(latencies),
        },
    }
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] == report["total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
