import { z } from "zod";

export const QUESTIONNAIRE_VERSION = "glaramara-fraud-questionnaire/1.2.0";
export const questionnaireVersionSchema = z.enum([
  "glaramara-fraud-questionnaire/1.0.0",
  "glaramara-fraud-questionnaire/1.1.0",
  QUESTIONNAIRE_VERSION,
]);

const optionSchema = z.object({ value: z.string(), label: z.string() });

export const questionDefinitionSchema = z.object({
  id: z.string().min(1).max(96),
  version: questionnaireVersionSchema,
  prompt: z.string().min(1).max(240),
  helpText: z.string().max(240).optional(),
  kind: z.enum(["SINGLE_CHOICE", "SHORT_TEXT"]),
  options: z.array(optionSchema).max(8).optional(),
  required: z.literal(true),
});

export type QuestionDefinition = z.infer<typeof questionDefinitionSchema>;

export const answerPayloadSchema = z.object({
  value: z.string().trim().min(1).max(500),
});

const DEFINITIONS: Record<string, QuestionDefinition> = {
  payment_recognition: {
    id: "payment_recognition",
    version: QUESTIONNAIRE_VERSION,
    prompt: "Did you make this payment yourself?",
    helpText: "Choose the closest answer. No money has moved while we check.",
    kind: "SINGLE_CHOICE",
    options: [
      { value: "YES", label: "Yes, I made it" },
      { value: "NO", label: "No, I don’t recognise it" },
      { value: "UNSURE", label: "I’m not sure" },
    ],
    required: true,
  },
  beneficiary_relationship: {
    id: "beneficiary_relationship",
    version: QUESTIONNAIRE_VERSION,
    prompt: "Who are you making this payment to?",
    kind: "SINGLE_CHOICE",
    options: [
      { value: "FRIEND_OR_FAMILY", label: "A friend or family member" },
      { value: "PERSONALLY_KNOWN", label: "Someone else I know personally" },
      { value: "BUSINESS_OR_ORGANISATION", label: "A business or organisation" },
      { value: "INDIVIDUAL_NOT_PERSONALLY_KNOWN", label: "An individual I don’t know personally" },
      { value: "UNSURE", label: "I’m not sure" },
    ],
    required: true,
  },
  payment_purpose: {
    id: "payment_purpose",
    version: QUESTIONNAIRE_VERSION,
    prompt: "What is this payment for?",
    kind: "SINGLE_CHOICE",
    options: [
      { value: "FRIENDS_FAMILY", label: "Friends or family" },
      { value: "GOODS_SERVICES", label: "Goods or services" },
      { value: "INVESTMENT", label: "An investment" },
      { value: "SAFE_ACCOUNT", label: "Moving money to keep it safe" },
      { value: "OTHER", label: "Something else" },
    ],
    required: true,
  },
  contact_influence: {
    id: "contact_influence",
    version: QUESTIONNAIRE_VERSION,
    prompt: "Did anyone recommend, encourage or instruct you to make this payment?",
    helpText: "This could be the recipient or someone else, whether you contacted them or they contacted you.",
    kind: "SINGLE_CHOICE",
    options: [
      { value: "SELF_DECIDED", label: "No, I decided to make it myself" },
      { value: "RECIPIENT_INFLUENCED", label: "Yes, the recipient" },
      { value: "THIRD_PARTY_INFLUENCED", label: "Yes, someone else" },
      { value: "DISCUSSION_ONLY", label: "We discussed it, but I made the decision" },
      { value: "UNSURE", label: "I’m not sure" },
    ],
    required: true,
  },
  payment_circumstances: {
    id: "payment_circumstances",
    version: QUESTIONNAIRE_VERSION,
    prompt: "Briefly explain what happened and why this payment feels urgent.",
    helpText: "You can mention who contacted you, an unfamiliar number, someone abroad, and how the recipient was chosen. Don’t include full phone or account numbers, passwords or security codes.",
    kind: "SHORT_TEXT",
    required: true,
  },
  investment_origin: {
    id: "investment_origin",
    version: QUESTIONNAIRE_VERSION,
    prompt: "How did you first hear about this investment?",
    kind: "SINGLE_CHOICE",
    options: [
      { value: "OWN_RESEARCH", label: "I found it through my own research" },
      { value: "KNOWN_PROVIDER", label: "From a financial provider or adviser I already knew" },
      { value: "RECIPIENT_APPROACHED", label: "The recipient contacted me about it" },
      { value: "RECOMMENDED", label: "Someone else recommended it" },
      { value: "OTHER", label: "Another way" },
      { value: "UNSURE", label: "I’m not sure" },
    ],
    required: true,
  },
  investment_reason: {
    id: "investment_reason",
    version: QUESTIONNAIRE_VERSION,
    prompt: "Can you tell us a little more about why you’re making this payment?",
    helpText: "For example, what the payment is intended to fund. Don’t include account numbers, passwords or security codes.",
    kind: "SHORT_TEXT",
    required: true,
  },
  pressure_or_secrecy: {
    id: "pressure_or_secrecy",
    version: QUESTIONNAIRE_VERSION,
    prompt: "Did they ask you to act quickly, keep it secret, or ignore a bank warning?",
    kind: "SINGLE_CHOICE",
    options: [
      { value: "YES", label: "Yes" },
      { value: "NO", label: "No" },
      { value: "UNSURE", label: "I’m not sure" },
    ],
    required: true,
  },
  remote_access: {
    id: "remote_access",
    version: QUESTIONNAIRE_VERSION,
    prompt: "Did anyone ask you to install an app or share access to your phone or computer?",
    kind: "SINGLE_CHOICE",
    options: [
      { value: "YES", label: "Yes" },
      { value: "NO", label: "No" },
      { value: "UNSURE", label: "I’m not sure" },
    ],
    required: true,
  },
  other_purpose: {
    id: "other_purpose",
    version: QUESTIONNAIRE_VERSION,
    prompt: "Briefly tell us what the payment is for.",
    helpText: "Don’t include account numbers, passwords or security codes.",
    kind: "SHORT_TEXT",
    required: true,
  },
};

export function initialQuestionIds(context: {
  triggeredRuleIds: string[];
  beneficiaryPaymentCount: number;
  deterministicSignals?: string[];
}) {
  const selected = ["payment_recognition", "beneficiary_relationship", "payment_purpose"];
  const velocityTriggered = context.triggeredRuleIds.some(
    (ruleId) => ruleId === "FP-CHALLENGE-VELOCITY" || ruleId === "HIGH_VELOCITY",
  );
  const slowBuildingTriggered = context.deterministicSignals?.includes(
    "SLOW_BUILDING_BENEFICIARY_RISK",
  ) ?? false;
  if (context.beneficiaryPaymentCount === 0 || velocityTriggered || slowBuildingTriggered) {
    selected.push("contact_influence");
  }
  if (context.beneficiaryPaymentCount === 0) {
    selected.push("payment_circumstances");
  }
  return selected;
}

export function conditionalQuestionIds(answers: Record<string, string>) {
  const selected: string[] = [];
  if (answers.payment_purpose === "OTHER") selected.push("other_purpose");
  if (answers.payment_purpose === "INVESTMENT") {
    selected.push("investment_origin", "investment_reason");
  }
  if (["RECIPIENT_INFLUENCED", "THIRD_PARTY_INFLUENCED"].includes(answers.contact_influence)) {
    selected.push("pressure_or_secrecy", "remote_access");
  }
  return selected;
}

export function definitionSnapshot(questionIds: string[]) {
  return Object.fromEntries(questionIds.map((id) => [id, DEFINITIONS[id]]));
}

export function allDefinitionSnapshot() {
  return { ...DEFINITIONS };
}

export function validateAnswer(question: QuestionDefinition, payload: unknown) {
  const answer = answerPayloadSchema.parse(payload);
  if (question.kind === "SINGLE_CHOICE" && !question.options?.some((item) => item.value === answer.value)) {
    throw new z.ZodError([{ code: "custom", path: ["value"], message: "Select one of the available answers" }]);
  }
  return answer;
}
