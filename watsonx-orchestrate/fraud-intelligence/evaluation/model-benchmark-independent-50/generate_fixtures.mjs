#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFraudPreventionGuidance } from "../../../../glaramara-bank/lib/fraud-intelligence/guidance.mjs";
import { reassessFraudEvidence } from "../../../../glaramara-bank/lib/fraud-intelligence/policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALL = ["UNEXPECTED_CONTACT", "PRESSURE_OR_SECRECY", "URGENCY", "SAFE_ACCOUNT",
  "BANK_IMPERSONATION", "THIRD_PARTY_BENEFICIARY", "INVESTMENT", "REMOTE_ACCESS", "NONE"];
const EMPTY_CLARIFICATION = { needed: false, id: "", prompt: "", options: [], reason: "" };

const rows = [
  // Investment scams
  ["investment-crypto-liquidity-release", "investment", "NEW_RECIPIENT", "INVESTMENT", "UNEXPECTED", "A chap from the crypto platform says my dashboard profit is £38,000, but I need to send a £2,400 liquidity payment to his colleague's wallet before I can withdraw it.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","THIRD_PARTY_BENEFICIARY","INVESTMENT"], []],
  ["investment-broker-tax-before-withdrawal", "investment", "NEW_RECIPIENT", "INVESTMENT", "EXPECTED", "The broker I found through an advert shows my account has doubled. She says HMRC tax must be paid immediately into a different company account before any withdrawal.", "YES", "NO", ["PRESSURE_OR_SECRECY","URGENCY","THIRD_PARTY_BENEFICIARY","INVESTMENT"], []],
  ["investment-whatsapp-copy-trading", "investment", "NEW_RECIPIENT", "INVESTMENT", "UNEXPECTED", "I was added to a WhatsApp copy-trading group. The admin wants today's transfer now because the displayed return drops after the market closes.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","URGENCY","INVESTMENT"], []],
  ["investment-crypto-screen-help", "investment", "NEW_RECIPIENT", "INVESTMENT", "UNEXPECTED", "Someone calling about a crypto account asked me to install AnyDesk so he can help move the money into the trading wallet.", "NO", "YES", ["UNEXPECTED_CONTACT","INVESTMENT","REMOTE_ACCESS"], []],
  ["investment-fake-broker-insurance", "investment", "NEW_RECIPIENT", "INVESTMENT", "EXPECTED", "My online broker says the returns are ready, but their insurer needs £1,750 paid to a partner business before releasing them.", "NO", "NO", ["THIRD_PARTY_BENEFICIARY","INVESTMENT"], []],
  ["investment-property-bond-deadline", "investment", "NEW_RECIPIENT", "INVESTMENT", "EXPECTED", "I joined a webinar about a property bond. The presenter says the 11% allocation closes urgently tonight and sent bank details after the session.", "YES", "NO", ["PRESSURE_OR_SECRECY","URGENCY","INVESTMENT"], []],
  ["investment-known-adviser-new-fund", "investment", "KNOWN_PERSON", "INVESTMENT", "EXPECTED", "My adviser of six years discussed this fund with me at our booked review. I am using the firm's usual account and there is no deadline.", "NO", "NO", ["INVESTMENT"], []],
  ["investment-crypto-recovery-fee", "investment", "NEW_RECIPIENT", "INVESTMENT", "UNEXPECTED", "A recovery agent rang saying they found my lost bitcoin. They want an urgent tracing fee sent to their solicitor's account before the coins disappear.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","URGENCY","THIRD_PARTY_BENEFICIARY","INVESTMENT"], []],
  ["investment-app-manipulated-return", "investment", "NEW_RECIPIENT", "INVESTMENT", "EXPECTED", "The investment app shows a 64% return in three weeks. Support says I must top up another £5,000 today to unlock the withdrawal button.", "YES", "NO", ["PRESSURE_OR_SECRECY","URGENCY","INVESTMENT"], []],
  ["investment-pension-cold-call", "investment", "NEW_RECIPIENT", "INVESTMENT", "UNEXPECTED", "A pension specialist cold-called and said I will lose the tax-free opportunity unless I transfer to the overseas scheme right away.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","URGENCY","INVESTMENT"], []],

  // Impersonation and family emergencies
  ["family-ai-voice-grandson-bail", "family-emergency", "NEW_RECIPIENT", "FRIENDS_FAMILY", "UNEXPECTED", "The caller sounded exactly like my grandson, though the number was withheld. He said he was in custody and needed bail money sent to a friend's account urgently. I suspect the voice may have been generated but I cannot prove that.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","URGENCY","THIRD_PARTY_BENEFICIARY"], []],
  ["family-daughter-hospital-new-number", "family-emergency", "NEW_RECIPIENT", "FRIENDS_FAMILY", "UNEXPECTED", "A text from a number I don't know says it is my daughter at A&E with a broken phone and asks for the treatment deposit now.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","URGENCY"], []],
  ["family-brother-voice-usual-number", "family-emergency", "KNOWN_PERSON", "FRIENDS_FAMILY", "EXPECTED", "My brother rang from his usual number and we used our family password. He needs the train fare we discussed yesterday, paid to his normal account.", "NO", "NO", ["NONE"], []],
  ["family-nephew-landlord-account", "family-emergency", "NEW_RECIPIENT", "FRIENDS_FAMILY", "UNEXPECTED", "A message claiming to be my nephew says his phone is damaged and the rent must go immediately to his landlord's account or he will be evicted.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","URGENCY","THIRD_PARTY_BENEFICIARY"], []],
  ["family-mum-stranded-airport", "family-emergency", "NEW_RECIPIENT", "FRIENDS_FAMILY", "UNEXPECTED", "Mum supposedly emailed from an address I have never seen saying her purse was stolen abroad and I should pay a travel agent straight away.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","URGENCY","THIRD_PARTY_BENEFICIARY"], []],
  ["family-son-voice-uncertain", "family-emergency", "UNSURE", "FRIENDS_FAMILY", "UNEXPECTED", "A caller sounded a bit like my son and said he had crashed the car. The number was new and I am not sure whose account this is.", "UNSURE", "NO", ["UNEXPECTED_CONTACT"], []],
  ["family-cousin-planned-medical-help", "family-emergency", "KNOWN_PERSON", "FRIENDS_FAMILY", "EXPECTED", "I spoke to my cousin face to face on Sunday and agreed to help with her dental bill. These are the same details I paid before.", "NO", "NO", ["NONE"], ["MET_BENEFICIARY_IN_PERSON"]],
  ["family-police-officer-relative", "family-emergency", "NEW_RECIPIENT", "FRIENDS_FAMILY", "UNEXPECTED", "A man saying he is a police officer called about my sister's accident and told me not to ring her while I send the recovery charge to the garage.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","THIRD_PARTY_BENEFICIARY"], []],
  ["family-friend-emergency-email", "family-emergency", "NEW_RECIPIENT", "FRIENDS_FAMILY", "UNEXPECTED", "An email from my friend's address says she is stuck in Madrid and needs money urgently, but the writing does not sound like her.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","URGENCY"], []],
  ["family-dad-care-home-verified", "family-emergency", "KNOWN_BUSINESS", "GOODS_SERVICES", "EXPECTED", "Dad's care home phoned about the annual fee. I rang the published number back and checked the beneficiary details against last year's invoice.", "NO", "NO", ["NONE"], ["CHECKED_BENEFICIARY_DETAILS","INVOICE_RECEIVED"]],

  // APP fraud
  ["app-safe-account-sort-code", "app-fraud", "NEW_RECIPIENT", "SAFE_ACCOUNT", "UNEXPECTED", "The bank's fraud team called and said a branch employee is involved. They told me to move everything to a safe account and keep the investigation secret.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","SAFE_ACCOUNT","BANK_IMPERSONATION"], []],
  ["app-police-secure-wallet", "app-fraud", "NEW_RECIPIENT", "SAFE_ACCOUNT", "UNEXPECTED", "Someone claiming to be police said my current account is compromised and I must transfer it into a secure holding wallet immediately.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","URGENCY","SAFE_ACCOUNT"], []],
  ["app-builder-invoice-redirection", "app-fraud", "KNOWN_BUSINESS", "GOODS_SERVICES", "UNEXPECTED", "An email in the builder's existing thread says their bank has changed and asks me to send the final invoice to a new account today.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","URGENCY"], ["INVOICE_RECEIVED"]],
  ["app-solicitor-client-account-change", "app-fraud", "KNOWN_BUSINESS", "GOODS_SERVICES", "UNEXPECTED", "My conveyancer's email says their client account changed yesterday and completion funds must go to the replacement details before noon.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","URGENCY"], []],
  ["app-marketplace-concert-tickets", "app-fraud", "NEW_RECIPIENT", "GOODS_SERVICES", "UNEXPECTED", "A seller on social media has two concert tickets. They will only hold them for ten minutes if I pay by bank transfer now.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","URGENCY"], []],
  ["app-car-deposit-third-party", "app-fraud", "NEW_RECIPIENT", "GOODS_SERVICES", "EXPECTED", "The private car seller says the deposit has to go to his business partner because his own account is frozen.", "NO", "NO", ["THIRD_PARTY_BENEFICIARY"], []],
  ["app-holiday-let-pressure", "app-fraud", "NEW_RECIPIENT", "GOODS_SERVICES", "UNEXPECTED", "The holiday-let owner contacted me outside the booking site and says I must transfer the deposit tonight for the discount.", "YES", "NO", ["UNEXPECTED_CONTACT","PRESSURE_OR_SECRECY","URGENCY"], []],
  ["app-supplier-factoring-verified", "app-fraud", "KNOWN_BUSINESS", "GOODS_SERVICES", "EXPECTED", "Our regular supplier asked us to pay its factoring company. I called our usual contact on the saved number and checked the new beneficiary details; the invoice is attached.", "NO", "NO", ["THIRD_PARTY_BENEFICIARY"], ["CHECKED_BENEFICIARY_DETAILS","INVOICE_RECEIVED"]],
  ["app-bank-remote-safe-account", "app-fraud", "NEW_RECIPIENT", "SAFE_ACCOUNT", "UNEXPECTED", "A caller claiming to be from my bank told me to install a support app, then move the balance to their protected account.", "NO", "YES", ["UNEXPECTED_CONTACT","SAFE_ACCOUNT","BANK_IMPERSONATION","REMOTE_ACCESS"], []],
  ["app-puppy-courier-account", "app-fraud", "NEW_RECIPIENT", "GOODS_SERVICES", "EXPECTED", "The breeder wants the puppy delivery charge paid to a courier's bank account before I can visit.", "NO", "NO", ["THIRD_PARTY_BENEFICIARY"], []],

  // Legitimate
  ["legitimate-builder-stage-payment", "legitimate", "KNOWN_BUSINESS", "GOODS_SERVICES", "EXPECTED", "This is the second stage payment for our loft. I met the builder on site, checked the same account as the signed quote and have the invoice.", "NO", "NO", ["NONE"], ["MET_BENEFICIARY_IN_PERSON","CHECKED_BENEFICIARY_DETAILS","INVOICE_RECEIVED"]],
  ["legitimate-family-house-deposit-gift", "legitimate", "KNOWN_PERSON", "FRIENDS_FAMILY", "EXPECTED", "I am sending my daughter the house-deposit gift we agreed with the solicitor last month, to her usual account.", "NO", "NO", ["NONE"], []],
  ["legitimate-wedding-photographer", "legitimate", "NEW_RECIPIENT", "GOODS_SERVICES", "EXPECTED", "We met the photographer at the venue, checked the details on the signed contract and received the deposit invoice.", "NO", "NO", ["NONE"], ["MET_BENEFICIARY_IN_PERSON","CHECKED_BENEFICIARY_DETAILS","INVOICE_RECEIVED"]],
  ["legitimate-car-showroom-balance", "legitimate", "NEW_RECIPIENT", "GOODS_SERVICES", "NO", "I am at the dealership collecting the car. I met the sales manager, checked the account on their printed invoice and am paying the agreed balance.", "NO", "NO", ["NONE"], ["MET_BENEFICIARY_IN_PERSON","CHECKED_BENEFICIARY_DETAILS","INVOICE_RECEIVED"]],
  ["legitimate-school-fees", "legitimate", "KNOWN_BUSINESS", "GOODS_SERVICES", "EXPECTED", "This is the termly school fee to the same beneficiary we have used for three years. The invoice arrived through the parent portal.", "NO", "NO", ["NONE"], ["INVOICE_RECEIVED"]],
  ["legitimate-sibling-loan-repayment", "legitimate", "KNOWN_PERSON", "FRIENDS_FAMILY", "NO", "I am repaying my sister the £3,000 she lent me for the boiler. We agreed the date in person yesterday.", "NO", "NO", ["NONE"], ["MET_BENEFICIARY_IN_PERSON"]],
  ["legitimate-roofing-final-invoice", "legitimate", "KNOWN_BUSINESS", "GOODS_SERVICES", "EXPECTED", "The roofer finished today. I checked the beneficiary against the deposit I already paid and have the final invoice.", "NO", "NO", ["NONE"], ["CHECKED_BENEFICIARY_DETAILS","INVOICE_RECEIVED"]],
  ["legitimate-auction-house-purchase", "legitimate", "NEW_RECIPIENT", "GOODS_SERVICES", "EXPECTED", "I won the lot in person at the auction house. Their cashier gave me the invoice and I checked the payment details at the desk.", "NO", "NO", ["NONE"], ["MET_BENEFICIARY_IN_PERSON","CHECKED_BENEFICIARY_DETAILS","INVOICE_RECEIVED"]],
  ["legitimate-private-tutor", "legitimate", "KNOWN_PERSON", "GOODS_SERVICES", "EXPECTED", "This is the usual monthly transfer to my son's tutor using the beneficiary I have paid since September.", "NO", "NO", ["NONE"], []],
  ["legitimate-high-value-kitchen", "legitimate", "NEW_RECIPIENT", "GOODS_SERVICES", "NO", "I visited the kitchen showroom twice, met the designer, checked the company details and received the £12,000 order invoice.", "NO", "NO", ["NONE"], ["MET_BENEFICIARY_IN_PERSON","CHECKED_BENEFICIARY_DETAILS","INVOICE_RECEIVED"]],

  // Ambiguous or contradictory
  ["ambiguous-contact-none-versus-caller", "ambiguous", "NEW_RECIPIENT", "GOODS_SERVICES", "NO", "A seller rang me this morning and talked me through this payment, but I selected no contact because I found the advert myself.", "NO", "NO", ["NONE"], [], 1],
  ["ambiguous-purpose-family-versus-investment", "ambiguous", "KNOWN_PERSON", "FRIENDS_FAMILY", "EXPECTED", "It is for my cousin, although he says he will put the money into a crypto scheme for me.", "NO", "NO", ["NONE"], [], 1],
  ["ambiguous-recognition-changing", "ambiguous", "KNOWN_BUSINESS", "OTHER", "NO", "At first I thought I arranged it, now I cannot remember. The reference resembles my gym but the amount is wrong.", "NO", "NO", ["NONE"], [], 1, "UNSURE"],
  ["ambiguous-beneficiary-trading-name", "ambiguous", "UNSURE", "GOODS_SERVICES", "EXPECTED", "The invoice uses a trading name I recognise, but the payee name is different and I do not know whether they are the same firm.", "NO", "NO", ["NONE"], ["INVOICE_RECEIVED"]],
  ["ambiguous-remote-access-unsure", "ambiguous", "NEW_RECIPIENT", "INVESTMENT", "EXPECTED", "The adviser showed me where to click on a video call. I am not sure whether that counted as sharing access.", "NO", "UNSURE", ["INVESTMENT"], []],
  ["ambiguous-pressure-denied-urgent", "ambiguous", "NEW_RECIPIENT", "GOODS_SERVICES", "EXPECTED", "They did not pressure me, but said the quote expires immediately and payment has to be made now.", "NO", "NO", ["URGENCY"], [], 1],
  ["ambiguous-expected-contact-cold-call", "ambiguous", "NEW_RECIPIENT", "OTHER", "EXPECTED", "I expected the appointment, but this person cold-called before it and says they are from the same firm. I cannot confirm that.", "UNSURE", "NO", ["NONE"], [], 1],
  ["ambiguous-safe-word-not-instruction", "ambiguous", "NEW_RECIPIENT", "OTHER", "UNEXPECTED", "The caller said my savings would be safer with their service, but did not actually tell me this was a bank safe account.", "NO", "NO", ["UNEXPECTED_CONTACT"], []],
  ["ambiguous-invoice-edited-details", "ambiguous", "KNOWN_BUSINESS", "GOODS_SERVICES", "EXPECTED", "I have an invoice from the usual plumber, but the account details look edited and I have not checked them with him.", "NO", "NO", ["NONE"], ["INVOICE_RECEIVED"]],
  ["ambiguous-family-voice-known-number", "ambiguous", "KNOWN_PERSON", "FRIENDS_FAMILY", "EXPECTED", "The call displayed my daughter's usual number and sounded like her, but it cut off when I asked our family question. She wanted money sent to a flatmate.", "UNSURE", "NO", ["THIRD_PARTY_BENEFICIARY"], []],
];

const mapRecognition = { YES: "RECOGNISED", NO: "NOT_RECOGNISED", UNSURE: "UNCERTAIN" };
const mapBeneficiary = { KNOWN_PERSON: "KNOWN", KNOWN_BUSINESS: "KNOWN", NEW_RECIPIENT: "NEW", UNSURE: "UNCERTAIN" };
const mapPurpose = { FRIENDS_FAMILY: "FRIENDS_OR_FAMILY", GOODS_SERVICES: "GOODS_OR_SERVICES", INVESTMENT: "INVESTMENT", SAFE_ACCOUNT: "SAFE_ACCOUNT", OTHER: "OTHER" };
const mapContact = { NO: "NONE", EXPECTED: "EXPECTED", UNEXPECTED: "UNEXPECTED" };

function scenario(row, index) {
  const [id, category, relationship, purpose, contact, circumstances, pressure, remote, indicators,
    claims, minimumContradictions = 0, recognition = "YES"] = row;
  const answers = { payment_recognition: recognition, beneficiary_relationship: relationship,
    payment_purpose: purpose, contact_influence: contact, payment_circumstances: circumstances,
    pressure_or_secrecy: pressure, remote_access: remote };
  const thirdPartyInfluence = indicators.includes("BANK_IMPERSONATION") ? "BANK_IMPERSONATION" : mapContact[contact];
  const uncertainty = recognition === "UNSURE" || relationship === "UNSURE" || pressure === "UNSURE"
    || remote === "UNSURE" || minimumContradictions > 0 ? "MEDIUM" : "LOW";
  const expectedEvidence = {
    paymentRecognition: mapRecognition[recognition], beneficiaryRelationship: mapBeneficiary[relationship],
    paymentPurpose: mapPurpose[purpose], thirdPartyInfluence, verificationClaims: claims,
    requiredIndicators: indicators, forbiddenIndicators: ALL.filter((item) => !indicators.includes(item)),
    contradictions: minimumContradictions ? [{ summary: "The bounded answer conflicts with the customer's narrative.", sourceQuestionIds: ["payment_circumstances"] }] : [],
    minimumContradictions, uncertainty, missingEvidence: [], requiredProvenance: [],
  };
  expectedEvidence.requiredProvenance = ["paymentRecognition", "beneficiaryRelationship", "paymentPurpose", "thirdPartyInfluence",
    ...claims.map((item) => `verificationClaim:${item}`),
    ...indicators.filter((item) => item !== "NONE").map((item) => `scamIndicator:${item}`)];
  return { id, category, answers, payment: { amount: category === "legitimate" ? 250 + index * 275 : 1000 + index * 325,
    beneficiaryPreviouslyPaid: relationship === "KNOWN_PERSON" || relationship === "KNOWN_BUSINESS",
    deterministicSignals: relationship === "NEW_RECIPIENT" ? ["NEW_BENEFICIARY_HIGH_VALUE"] : [] },
    unsupportedConcepts: circumstances.match(/AI|generated|fake|scam|cold-call|edited|voice/i) ? ["NARRATIVE_CONCEPT_NOT_A_CONTRACT_INDICATOR"] : [],
    expectedEvidence };
}

function sourceFor(finding, item) {
  if (finding === "paymentRecognition") return "payment_recognition";
  if (finding === "beneficiaryRelationship") return "beneficiary_relationship";
  if (finding === "paymentPurpose") return "payment_purpose";
  if (finding === "thirdPartyInfluence") return item.expectedEvidence.thirdPartyInfluence === "BANK_IMPERSONATION" ? "payment_circumstances" : "contact_influence";
  if (finding.startsWith("verificationClaim:")) return "payment_circumstances";
  const indicator = finding.split(":")[1];
  return ({ UNEXPECTED_CONTACT: "contact_influence", PRESSURE_OR_SECRECY: "pressure_or_secrecy", REMOTE_ACCESS: "remote_access",
    SAFE_ACCOUNT: "payment_purpose", INVESTMENT: "payment_purpose" })[indicator] ?? "payment_circumstances";
}

function evidence(item) {
  const expected = item.expectedEvidence;
  return { schemaVersion: "fraud-intelligence-evidence/1.1.0", paymentRecognition: expected.paymentRecognition,
    beneficiaryRelationship: expected.beneficiaryRelationship, paymentPurpose: expected.paymentPurpose,
    thirdPartyInfluence: expected.thirdPartyInfluence, verificationClaims: expected.verificationClaims,
    scamIndicators: expected.requiredIndicators, contradictions: expected.contradictions,
    uncertainty: expected.uncertainty, missingEvidence: expected.missingEvidence,
    provenance: expected.requiredProvenance.map((findingId) => { const questionId = sourceFor(findingId, item); return {
      findingId, claim: `Frozen expected finding ${findingId}`,
      sources: [{ questionId, excerpt: item.answers[questionId] }],
    }; }), clarificationQuestion: EMPTY_CLARIFICATION };
}

const scenarios = rows.map(scenario);
for (const item of scenarios) {
  const canonical = evidence(item);
  const policy = reassessFraudEvidence(canonical);
  item.expectedPolicy = { outcome: policy.outcome, ruleId: policy.policyTrace[0].ruleId };
  const guidance = buildFraudPreventionGuidance({ evidence: canonical, reassessment: policy,
    customerExplanation: item.answers.payment_circumstances, context: item.payment });
  item.expectedGuidance = { category: guidance.category,
    requiredText: [policy.outcome === "DECLINED" ? "No money was sent" : "No money has been sent", "simulated payment"],
    forbiddenText: ["confirmed fraud", "verified AI voice", "definitely genuine"] };
}

const suite = { suiteVersion: "fraud-intelligence-independent-50/1.0.0", frozenAt: "2026-11-05T00:00:00.000Z",
  exactMatchSuitableScenarioCount: 50, scenarios };
const groundTruth = { schemaVersion: "fraud-intelligence-independent-ground-truth/1.0.0",
  frozenBeforeModelExecution: true, scenarios: scenarios.map((item) => ({ id: item.id,
    exactMatchSuitable: true, canonicalEvidence: evidence(item), expectedPolicy: item.expectedPolicy,
    acceptableGuidance: item.expectedGuidance, cautionRequired: item.category === "ambiguous" })) };
const stable = (value) => JSON.stringify(value, null, 2) + "\n";
await mkdir(HERE, { recursive: true });
await writeFile(path.join(HERE, "scenarios.json"), stable(suite));
await writeFile(path.join(HERE, "ground-truth.json"), stable(groundTruth));
const prompts = {
  payment_recognition: ["Did you make this payment yourself?", ["YES","NO","UNSURE"]],
  beneficiary_relationship: ["How do you know the person or business you’re paying?", ["KNOWN_PERSON","KNOWN_BUSINESS","NEW_RECIPIENT","UNSURE"]],
  payment_purpose: ["What is this payment for?", ["FRIENDS_FAMILY","GOODS_SERVICES","INVESTMENT","SAFE_ACCOUNT","OTHER"]],
  contact_influence: ["Did anyone contact you or guide you through making this payment?", ["NO","EXPECTED","UNEXPECTED"]],
  payment_circumstances: ["Briefly explain what happened and why this payment feels urgent.", null],
  pressure_or_secrecy: ["Did they ask you to act quickly, keep it secret, or ignore a bank warning?", ["YES","NO","UNSURE"]],
  remote_access: ["Did anyone ask you to install an app or share access to your phone or computer?", ["YES","NO","UNSURE"]],
};
await mkdir(path.join(HERE, "requests"), { recursive: true });
for (const item of scenarios) {
  const questions = Object.keys(item.answers).map((id) => prompts[id][1]
    ? { id, prompt: prompts[id][0], options: prompts[id][1] } : { id, prompt: prompts[id][0] });
  const request = { schemaVersion: "fraud-intelligence-request/1.0.0",
    questionnaireVersion: "glaramara-fraud-questionnaire/1.1.0", transactionRef: `evaluation-${item.id}`,
    payment: { amount: item.payment.amount, currency: "GBP", beneficiaryPreviouslyPaid: item.payment.beneficiaryPreviouslyPaid },
    deterministicSignals: item.payment.deterministicSignals,
    requiredEvidenceKeys: ["payment_recognition","beneficiary_relationship","payment_purpose"], questions,
    answers: Object.entries(item.answers).map(([questionId,value]) => ({ questionId,value,provenance:"CUSTOMER" })) };
  await writeFile(path.join(HERE, "requests", `${item.id}.json`), stable(request));
}
const hashes = Object.fromEntries([["scenarios.json", stable(suite)], ["ground-truth.json", stable(groundTruth)]]
  .map(([name, content]) => [name, createHash("sha256").update(content).digest("hex")]));
const grouped = Object.groupBy(scenarios, (item) => item.category);
await writeFile(path.join(HERE, "frozen-manifest.json"), stable({ frozenAt: suite.frozenAt,
  generatedWithoutModelResponses: true, scenarioCount: 50,
  categoryCounts: Object.fromEntries(Object.entries(grouped).map(([key, values]) => [key, values.length])), hashes }));
