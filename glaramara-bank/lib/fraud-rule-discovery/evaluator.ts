import type { FraudRuleProposal, RuleCondition } from "@/lib/fraud-rule-discovery/contracts";

export const EVALUATOR_VERSION = "fraud-rule-backtest/1.0.0";
export const SEMANTICS_NOTE = "Ordered batch simulation reproduces supported thresholds but does not emulate Flink watermarks, late-event side output, checkpoints or operational deduplication.";

export type HistoricalRow = {
  transaction_id: string;
  event_time: Date | string;
  customer_id: string;
  beneficiary_id: string;
  merchant_id: string;
  amount: string | number;
  ground_truth_fraud: boolean;
};

type FeatureValues = Record<string, number>;
type Evaluated = { id: string; fraud: boolean; baseline: boolean; candidate: boolean };

const milliseconds: Record<string, number> = {
  PT1M: 60_000,
  PT2M: 120_000,
  PT10M: 600_000,
  PT24H: 86_400_000,
};

function compare(value: number, condition: RuleCondition): boolean {
  if (condition.operator === "GT") return value > condition.threshold;
  if (condition.operator === "GTE") return value >= condition.threshold;
  if (condition.operator === "LT") return value < condition.threshold;
  if (condition.operator === "LTE") return value <= condition.threshold;
  return value === condition.threshold;
}

function key(feature: string, window: string | null): string {
  return window ? `${feature}:${window}` : feature;
}

function confusion(rows: Evaluated[], select: (row: Evaluated) => boolean) {
  let truePositives = 0, falsePositives = 0, trueNegatives = 0, falseNegatives = 0;
  for (const row of rows) {
    const predicted = select(row);
    if (predicted && row.fraud) truePositives += 1;
    else if (predicted) falsePositives += 1;
    else if (row.fraud) falseNegatives += 1;
    else trueNegatives += 1;
  }
  const precisionDenominator = truePositives + falsePositives;
  const recallDenominator = truePositives + falseNegatives;
  return {
    truePositives, falsePositives, trueNegatives, falseNegatives,
    precision: precisionDenominator ? truePositives / precisionDenominator : 0,
    recall: recallDenominator ? truePositives / recallDenominator : 0,
  };
}

export function backtest(rows: HistoricalRow[], proposal: FraudRuleProposal) {
  const sorted = [...rows].sort((left, right) => {
    const time = new Date(left.event_time).getTime() - new Date(right.event_time).getTime();
    return time || left.transaction_id.localeCompare(right.transaction_id);
  });
  const customerHistory = new Map<string, HistoricalRow[]>();
  const beneficiaryHistory = new Map<string, HistoricalRow[]>();
  const customerBeneficiaryCounts = new Map<string, number>();
  const firstCustomerBeneficiaryTime = new Map<string, number>();
  const evaluated: Evaluated[] = [];

  for (const row of sorted) {
    const now = new Date(row.event_time).getTime();
    const customerRows = customerHistory.get(row.customer_id) ?? [];
    const beneficiaryRows = beneficiaryHistory.get(row.beneficiary_id) ?? [];
    customerRows.push(row);
    beneficiaryRows.push(row);
    customerHistory.set(row.customer_id, customerRows);
    beneficiaryHistory.set(row.beneficiary_id, beneficiaryRows);
    const relationshipKey = `${row.customer_id}:${row.beneficiary_id}`;
    const priorCount = customerBeneficiaryCounts.get(relationshipKey) ?? 0;
    if (!firstCustomerBeneficiaryTime.has(relationshipKey)) firstCustomerBeneficiaryTime.set(relationshipKey, now);

    const within = (items: HistoricalRow[], window: string) => items.filter(
      (item) => now - new Date(item.event_time).getTime() <= milliseconds[window],
    );
    const oneMinute = within(customerRows, "PT1M");
    const twoMinutes = within(customerRows, "PT2M");
    const tenMinutes = within(customerRows, "PT10M");
    const day = within(customerRows, "PT24H");
    const beneficiaryDay = within(beneficiaryRows, "PT24H");
    const newDay = day.filter((item) => {
      const first = firstCustomerBeneficiaryTime.get(`${item.customer_id}:${item.beneficiary_id}`);
      return first !== undefined && first >= now - milliseconds.PT24H;
    });
    const values: FeatureValues = {
      amount_gbp: Number(row.amount),
      beneficiary_payment_count_before: priorCount,
      [key("customer_transaction_count", "PT1M")]: oneMinute.length,
      [key("customer_transaction_count", "PT2M")]: twoMinutes.length,
      [key("customer_transaction_count", "PT10M")]: tenMinutes.length,
      [key("customer_transaction_count", "PT24H")]: day.length,
      [key("customer_total_amount_gbp", "PT2M")]: twoMinutes.reduce((sum, item) => sum + Number(item.amount), 0),
      [key("customer_total_amount_gbp", "PT24H")]: day.reduce((sum, item) => sum + Number(item.amount), 0),
      [key("customer_distinct_merchant_count", "PT2M")]: new Set(twoMinutes.map((item) => item.merchant_id)).size,
      [key("customer_distinct_new_beneficiary_count", "PT24H")]: new Set(newDay.map((item) => item.beneficiary_id)).size,
      [key("customer_new_beneficiary_payment_count", "PT24H")]: newDay.length,
      [key("customer_new_beneficiary_total_gbp", "PT24H")]: newDay.reduce((sum, item) => sum + Number(item.amount), 0),
      [key("beneficiary_distinct_customers", "PT24H")]: new Set(beneficiaryDay.map((item) => item.customer_id)).size,
    };
    const velocity = twoMinutes.length >= 5;
    const hopping = velocity && new Set(twoMinutes.map((item) => item.merchant_id)).size >= 4;
    const highValueNewBeneficiary = priorCount === 0 && Number(row.amount) >= 5_000;
    const candidate = proposal.conditions.every((condition) => compare(values[key(condition.featureId, condition.window)], condition));
    evaluated.push({
      id: row.transaction_id,
      fraud: row.ground_truth_fraud,
      baseline: velocity || hopping || highValueNewBeneficiary,
      candidate,
    });
    customerBeneficiaryCounts.set(relationshipKey, priorCount + 1);
  }

  const incremental = evaluated.filter((row) => row.candidate && !row.baseline);
  return {
    metrics: {
      baseline: confusion(evaluated, (row) => row.baseline),
      candidate: confusion(evaluated, (row) => row.candidate),
      combined: confusion(evaluated, (row) => row.baseline || row.candidate),
      additionalFraudDetected: incremental.filter((row) => row.fraud).length,
      additionalLegitimateChallenged: incremental.filter((row) => !row.fraud).length,
      overlapWithBaseline: evaluated.filter((row) => row.candidate && row.baseline).length,
    },
    examples: {
      additionalFraud: incremental.filter((row) => row.fraud).slice(0, 8).map((row) => row.id),
      falsePositives: incremental.filter((row) => !row.fraud).slice(0, 8).map((row) => row.id),
      overlap: evaluated.filter((row) => row.candidate && row.baseline).slice(0, 8).map((row) => row.id),
    },
  };
}

