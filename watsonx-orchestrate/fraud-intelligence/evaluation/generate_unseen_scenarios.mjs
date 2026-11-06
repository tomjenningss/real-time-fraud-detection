#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(await readFile(path.join(HERE, "scenarios.json"), "utf8"));
const templates = new Map(source.scenarios.map((scenario) => [scenario.id, scenario]));
const clone = (templateId, id, answers, overrides = {}) => ({
  ...structuredClone(templates.get(templateId)),
  id,
  answers,
  ...overrides,
});

const scenarios = [
  clone("legitimate-known-business", "unseen-legitimate-council-tax", {
    payment_recognition: "YES", beneficiary_relationship: "KNOWN_BUSINESS",
    payment_purpose: "GOODS_SERVICES", contact_influence: "EXPECTED",
    payment_circumstances: "The council sent the usual annual tax notice and I am using the saved payee.",
    pressure_or_secrecy: "NO", remote_access: "NO",
  }),
  clone("legitimate-known-person", "unseen-legitimate-friend-repayment", {
    payment_recognition: "YES", beneficiary_relationship: "KNOWN_PERSON",
    payment_purpose: "FRIENDS_FAMILY", contact_influence: "NO",
    payment_circumstances: "I am repaying my flatmate for groceries we bought together yesterday.",
    pressure_or_secrecy: "NO", remote_access: "NO",
  }),
  clone("purchase-invoice-only", "unseen-legitimate-dentist-invoice", {
    payment_recognition: "YES", beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "GOODS_SERVICES", contact_influence: "EXPECTED",
    payment_circumstances: "My new dentist emailed the invoice after today's appointment.",
    pressure_or_secrecy: "NO", remote_access: "NO",
  }),
  clone("purchase-builder-verified", "unseen-legitimate-electrician-verified", {
    payment_recognition: "YES", beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "GOODS_SERVICES", contact_influence: "NO",
    payment_circumstances: "I met the electrician at my home, checked their bank details and received an invoice.",
    pressure_or_secrecy: "NO", remote_access: "NO",
  }),
  clone("investment-influencer-urgent-returns-regression", "unseen-investment-seminar-deadline", {
    payment_recognition: "YES", beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "INVESTMENT", contact_influence: "UNEXPECTED",
    payment_circumstances: "A webinar host guaranteed ten percent returns and said the investment window closes tonight.",
    pressure_or_secrecy: "YES", remote_access: "NO",
  }),
  clone("investment-third-party-beneficiary", "unseen-investment-custodian-partner-account", {
    payment_recognition: "YES", beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "INVESTMENT", contact_influence: "UNEXPECTED",
    payment_circumstances: "A portfolio manager messaged me and directed the investment payment to their partner's account.",
    pressure_or_secrecy: "NO", remote_access: "NO",
  }),
  clone("investment-crypto-remote-access", "unseen-investment-crypto-screen-share", {
    payment_recognition: "YES", beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "INVESTMENT", contact_influence: "UNEXPECTED",
    payment_circumstances: "A crypto mentor contacted me, said the price will jump today and asked to control my screen.",
    pressure_or_secrecy: "NO", remote_access: "YES",
  }),
  clone("bank-safe-account-call", "unseen-bank-police-safe-wallet", {
    payment_recognition: "YES", beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "SAFE_ACCOUNT", contact_influence: "UNEXPECTED",
    payment_circumstances: "A caller claiming to work with my bank and the police ordered me to move everything to a safe wallet now.",
    pressure_or_secrecy: "YES", remote_access: "NO",
  }),
  clone("bank-security-team-third-party", "unseen-bank-fraud-holding-company", {
    payment_recognition: "YES", beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "OTHER", contact_influence: "UNEXPECTED",
    payment_circumstances: "Someone claiming to be bank fraud support directed me to pay an unrelated holding company.",
    pressure_or_secrecy: "NO", remote_access: "NO",
  }),
  clone("family-son-lost-phone", "unseen-family-nephew-new-phone", {
    payment_recognition: "YES", beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "FRIENDS_FAMILY", contact_influence: "UNEXPECTED",
    payment_circumstances: "A new number says it is my nephew, his phone was stolen and he needs taxi money immediately.",
    pressure_or_secrecy: "YES", remote_access: "NO",
  }),
  clone("family-expected-help", "unseen-family-planned-wedding-gift", {
    payment_recognition: "YES", beneficiary_relationship: "KNOWN_PERSON",
    payment_purpose: "FRIENDS_FAMILY", contact_influence: "EXPECTED",
    payment_circumstances: "My cousin sent the wedding contribution details we agreed in person last weekend.",
    pressure_or_secrecy: "NO", remote_access: "NO",
  }),
  clone("family-daughter-urgent-new-number", "unseen-romance-pay-sister-hospital", {
    payment_recognition: "YES", beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "FRIENDS_FAMILY", contact_influence: "UNEXPECTED",
    payment_circumstances: "A dating-app partner urgently asked me to send hospital money to their sister's account.",
    pressure_or_secrecy: "YES", remote_access: "NO",
  }, { category: "romance-purchase-scam", unsupportedConcepts: ["ROMANCE_SCAM"] }),
  clone("purchase-marketplace-pressure", "unseen-purchase-puppy-deposit", {
    payment_recognition: "YES", beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "GOODS_SERVICES", contact_influence: "UNEXPECTED",
    payment_circumstances: "An online breeder says I must transfer the puppy deposit right now or lose the reservation.",
    pressure_or_secrecy: "YES", remote_access: "NO",
  }),
  clone("ambiguous-beneficiary-unsure", "unseen-ambiguous-event-venue", {
    payment_recognition: "YES", beneficiary_relationship: "UNSURE",
    payment_purpose: "GOODS_SERVICES", contact_influence: "NO",
    payment_circumstances: "This may be the event venue, but I cannot tell who owns the account.",
    pressure_or_secrecy: "NO", remote_access: "NO",
  }),
  clone("contradiction-contact-none-versus-caller", "unseen-contradiction-expected-versus-cold-call", {
    payment_recognition: "YES", beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "OTHER", contact_influence: "EXPECTED",
    payment_circumstances: "An unknown caller unexpectedly told me to complete this transfer immediately.",
    pressure_or_secrecy: "NO", remote_access: "NO",
  }, {
    expectedEvidence: {
      ...structuredClone(templates.get("contradiction-contact-none-versus-caller").expectedEvidence),
      thirdPartyInfluence: "EXPECTED",
      contradictions: [{
        summary: "The bounded expected-contact answer conflicts with the stated unknown caller.",
        sourceQuestionIds: ["contact_influence", "payment_circumstances"],
      }],
    },
  }),
  clone("purchase-marketplace-pressure", "unseen-government-tax-refund-fee", {
    payment_recognition: "YES", beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "OTHER", contact_influence: "UNEXPECTED",
    payment_circumstances: "A caller claiming to be the tax office said I must pay a release fee immediately and keep it confidential.",
    pressure_or_secrecy: "YES", remote_access: "NO",
  }, {
    category: "impersonation",
    unsupportedConcepts: ["GOVERNMENT_IMPERSONATION"],
    expectedEvidence: {
      ...structuredClone(templates.get("purchase-marketplace-pressure").expectedEvidence),
      paymentPurpose: "OTHER",
    },
  }),
  clone("purchase-invoice-only", "unseen-supplier-factoring-account", {
    payment_recognition: "YES", beneficiary_relationship: "NEW_RECIPIENT",
    payment_purpose: "GOODS_SERVICES", contact_influence: "EXPECTED",
    payment_circumstances: "The supplier sent an invoice and told me to pay a separate factoring company's account.",
    pressure_or_secrecy: "NO", remote_access: "NO",
  }, {
    expectedEvidence: {
      ...structuredClone(templates.get("purchase-invoice-only").expectedEvidence),
      requiredIndicators: ["THIRD_PARTY_BENEFICIARY"],
      requiredProvenance: [
        ...templates.get("purchase-invoice-only").expectedEvidence.requiredProvenance,
        "scamIndicator:THIRD_PARTY_BENEFICIARY",
      ],
    },
  }),
  clone("bank-word-only-no-contact", "unseen-legitimate-bank-reference", {
    payment_recognition: "YES", beneficiary_relationship: "KNOWN_BUSINESS",
    payment_purpose: "GOODS_SERVICES", contact_influence: "NO",
    payment_circumstances: "The invoice reference contains the word bank because I am renewing banking software myself.",
    pressure_or_secrecy: "NO", remote_access: "NO",
  }),
];

const output = {
  suiteVersion: "glaramara-fraud-intelligence-unseen/1.0.0",
  description: "Phase A.2 frozen unseen generalisation set; authored after agent 1.1.2 was selected.",
  scenarios,
};
await writeFile(path.join(HERE, "unseen-scenarios.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Generated ${scenarios.length} unseen scenarios`);
