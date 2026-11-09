import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { buildFraudPreventionGuidance } from "../lib/fraud-intelligence/guidance.mjs";
import { buildMockEvidence } from "../lib/fraud-intelligence/mock-evidence.mjs";
import { reassessFraudEvidence } from "../lib/fraud-intelligence/policy.mjs";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");

test("slow-building customer narrative stays grounded without invented scam claims", () => {
  const narrative = "I've been investing with a trader I found on Instagram for a few months. We've spoken regularly on WhatsApp and he's shown me how well my investment is doing. I've already sent several payments, and I'm adding another £3,000 because the returns have been good.";
  const evidence = buildMockEvidence({
    requiredEvidenceKeys: ["payment_recognition", "beneficiary_relationship", "payment_purpose"],
    answers: [
      { questionId: "payment_recognition", value: "YES" },
      { questionId: "beneficiary_relationship", value: "INDIVIDUAL_NOT_PERSONALLY_KNOWN" },
      { questionId: "payment_purpose", value: "INVESTMENT" },
      { questionId: "contact_influence", value: "RECIPIENT_INFLUENCED" },
      { questionId: "investment_origin", value: "OTHER" },
      { questionId: "investment_reason", value: narrative },
      { questionId: "pressure_or_secrecy", value: "NO" },
      { questionId: "remote_access", value: "NO" },
    ],
  });

  assert.equal(evidence.paymentPurpose, "INVESTMENT");
  assert.equal(evidence.beneficiaryRelationship, "INDIVIDUAL_NOT_PERSONALLY_KNOWN");
  assert.equal(evidence.thirdPartyInfluence, "RECIPIENT_INFLUENCED");
  assert.deepEqual(evidence.scamIndicators, ["INVESTMENT"]);
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /URGENCY|BANK_IMPERSONATION|SAFE_ACCOUNT|guaranteed|confirmed fraud/i,
  );

  const guidance = buildFraudPreventionGuidance({
    evidence,
    reassessment: reassessFraudEvidence(evidence),
    customerExplanation: narrative,
    context: {
      amount: 3_000,
      beneficiaryPreviouslyPaid: true,
      deterministicSignals: ["SLOW_BUILDING_BENEFICIARY_RISK"],
      slowBuildingEvidence: {
        payments30d: 5,
        cumulativeAmount30d: 5_850,
        successiveGrowthCount: 4,
        currentToFirstAmountRatio: 15,
        observedRelationshipAgeDays: 28,
      },
    },
  });

  assert.equal(guidance.category, "INVESTMENT_INDEPENDENT_CHECKS");
  assert.equal(guidance.customerStatement, narrative);
  assert.match(guidance.rendered.context, /Our payment history shows 5 payments to the same beneficiary/);
  assert.match(guidance.rendered.context, /totalling £5,850\.00/);
  assert.match(guidance.rendered.context, /amount increased .* 4 times/);
  assert.match(guidance.rendered.context, /You told us this payment is for an investment/);
  assert.doesNotMatch(guidance.rendered.context, /adviser pressured|guaranteed returns were promised|could not withdraw/i);
});

test("slow-building signal selects sourceable influence evidence without changing other questionnaire paths", () => {
  const questionnaire = read("lib/fraud-intelligence/questionnaire.ts");
  const repository = read("lib/server/fraud-investigation-repository.ts");

  assert.match(questionnaire, /deterministicSignals\?\.includes\([\s\S]*SLOW_BUILDING_BENEFICIARY_RISK/);
  assert.match(questionnaire, /beneficiaryPaymentCount === 0 \|\| velocityTriggered \|\| slowBuildingTriggered/);
  assert.match(repository, /investigation_request_payload\.evidence\?\.signals/);
  assert.match(repository, /deterministicSignals:\s*row\.risk_context_snapshot\.deterministicSignals/);
  assert.match(repository, /slow_building_beneficiary_evidence/);
  assert.doesNotMatch(repository, /UPDATE\s+payment_decisions/i);
});

test("investment claims remain customer-reported while supported pressure is personalised", () => {
  const statement = "The trader guaranteed the returns, told me to invest again today, and said my withdrawal is still being processed.";
  const evidence = buildMockEvidence({
    requiredEvidenceKeys: ["payment_recognition", "beneficiary_relationship", "payment_purpose"],
    answers: [
      { questionId: "payment_recognition", value: "YES" },
      { questionId: "beneficiary_relationship", value: "INDIVIDUAL_NOT_PERSONALLY_KNOWN" },
      { questionId: "payment_purpose", value: "INVESTMENT" },
      { questionId: "contact_influence", value: "RECIPIENT_INFLUENCED" },
      { questionId: "investment_origin", value: "RECIPIENT_APPROACHED" },
      { questionId: "investment_reason", value: statement },
      { questionId: "pressure_or_secrecy", value: "YES" },
      { questionId: "remote_access", value: "NO" },
    ],
  });
  const guidance = buildFraudPreventionGuidance({
    evidence,
    reassessment: reassessFraudEvidence(evidence),
    customerExplanation: statement,
    context: { amount: 3_000, beneficiaryPreviouslyPaid: true },
  });

  assert.ok(evidence.scamIndicators.includes("PRESSURE_OR_SECRECY"));
  assert.equal(guidance.customerStatement, statement);
  assert.match(guidance.rendered.context, /pressure or secrecy/);
  assert.doesNotMatch(guidance.rendered.context, /guaranteed returns|withdrawal (?:failed|blocked)/i);
});
