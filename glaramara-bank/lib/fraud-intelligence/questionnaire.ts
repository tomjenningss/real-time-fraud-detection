import { z } from "zod";

export const QUESTIONNAIRE_VERSION = "glaramara-fraud-questionnaire/1.0.0";

const optionSchema = z.object({ value: z.string(), label: z.string() });

export const questionDefinitionSchema = z.object({
  id: z.string().min(1).max(96),
  version: z.literal(QUESTIONNAIRE_VERSION),
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
    prompt: "How do you know the person or business you’re paying?",
    kind: "SINGLE_CHOICE",
    options: [
      { value: "KNOWN_PERSON", label: "Someone I know" },
      { value: "KNOWN_BUSINESS", label: "A business I know" },
      { value: "NEW_RECIPIENT", label: "I haven’t paid them before" },
      { value: "UNSURE", label: "I’m not sure who they are" },
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
    prompt: "Did anyone contact you or guide you through making this payment?",
    kind: "SINGLE_CHOICE",
    options: [
      { value: "NO", label: "No" },
      { value: "EXPECTED", label: "Yes, someone I expected" },
      { value: "UNEXPECTED", label: "Yes, an unexpected caller or message" },
    ],
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

export function initialQuestionIds(context: { triggeredRuleIds: string[]; beneficiaryPaymentCount: number }) {
  const selected = ["payment_recognition", "beneficiary_relationship", "payment_purpose"];
  const velocityTriggered = context.triggeredRuleIds.some(
    (ruleId) => ruleId === "FP-CHALLENGE-VELOCITY" || ruleId === "HIGH_VELOCITY",
  );
  if (context.beneficiaryPaymentCount === 0 || velocityTriggered) {
    selected.push("contact_influence");
  }
  return selected;
}

export function conditionalQuestionIds(answers: Record<string, string>) {
  const selected: string[] = [];
  if (answers.payment_purpose === "OTHER") selected.push("other_purpose");
  if (answers.contact_influence === "UNEXPECTED") {
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
