package demo.fraud;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class EnrichmentFunctionTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void exactThresholdForNeverPaidBeneficiaryEmitsSignal() throws Exception {
        JsonNode result = assess(transaction("threshold", 5_000.00, 0), 5_000.00);

        assertEquals(List.of("NEW_BENEFICIARY_HIGH_VALUE"), JSON.convertValue(
                result.get("signals"), JSON.getTypeFactory().constructCollectionType(List.class, String.class)));
        assertEquals(0, result.get("beneficiary_payment_count").asInt());
        assertEquals("HIGH", result.get("risk_level").asText());
    }

    @Test
    void belowThresholdDoesNotEmitSignal() throws Exception {
        JsonNode result = assess(transaction("below", 4_999.99, 0), 5_000.00);

        assertEquals(0, result.get("signals").size());
        assertEquals("LOW", result.get("risk_level").asText());
    }

    @Test
    void previouslyPaidBeneficiaryDoesNotEmitSignal() throws Exception {
        JsonNode result = assess(transaction("known", 8_000.00, 1), 5_000.00);

        assertEquals(0, result.get("signals").size());
        assertEquals("LOW", result.get("risk_level").asText());
    }

    @Test
    void absentBeneficiaryHistoryDoesNotTreatGenericPaymentAsNew() throws Exception {
        JsonNode result = assess(transaction("generic", 8_000.00, null), 5_000.00);

        assertEquals(0, result.get("signals").size());
        assertEquals(true, result.get("beneficiary_payment_count").isNull());
    }

    @Test
    void configuredThresholdIsApplied() throws Exception {
        JsonNode result = assess(transaction("configured", 5_000.00, 0), 7_500.00);

        assertEquals(0, result.get("signals").size());
    }

    @Test
    void slowBuildingEvidenceAndSignalArePersisted() throws Exception {
        List<Transaction> history = weeklyHistory(200, 400, 750, 1_500, 3_000);
        Transaction current = history.get(history.size() - 1);
        current.slowBuildingFeatures = SlowBuildingFeatureFunction.calculateFeatures(
                current, history, SlowBuildingRiskConfig.defaults());

        JsonNode result = JSON.readTree(EnrichmentFunction.assessmentJson(
                current, List.of(current), 5_000, SlowBuildingRiskConfig.defaults(), "slow-building-replay"));

        assertEquals("slow-building-replay", result.get("assessment_stream").asText());
        assertEquals(List.of("SLOW_BUILDING_BENEFICIARY_RISK"), JSON.convertValue(
                result.get("signals"), JSON.getTypeFactory().constructCollectionType(List.class, String.class)));
        JsonNode evidence = result.get("slow_building_beneficiary_evidence");
        assertEquals(5, evidence.get("payments_30d").asInt());
        assertEquals(5_850.0, evidence.get("cumulative_amount_30d").asDouble());
        assertEquals(4, evidence.get("successive_growth_count").asInt());
        assertEquals(15.0, evidence.get("current_to_first_amount_ratio").asDouble());
        assertEquals(28.0, evidence.get("observed_relationship_age_days").asDouble());
    }

    @Test
    void demonstrationDoesNotTriggerBeforeCumulativeThreshold() {
        List<Transaction> history = weeklyHistory(200, 400, 750, 1_500);
        Transaction current = history.get(history.size() - 1);
        SlowBuildingFeatures features = SlowBuildingFeatureFunction.calculateFeatures(
                current, history, SlowBuildingRiskConfig.defaults());

        assertEquals(4, features.payments30d);
        assertEquals(2_850.0, features.cumulativeAmount30d);
        assertEquals(false, features.signal);
    }

    @Test
    void exactlyThirtyDaysIsInclusiveAndOlderPaymentIsPruned() {
        long now = 1_800_000_000_000L;
        Transaction boundary = transaction("boundary", 1_000, 0);
        boundary.eventTimeMillis = now - SlowBuildingFeatureFunction.THIRTY_DAYS;
        Transaction outside = transaction("outside", 9_000, 0);
        outside.eventTimeMillis = boundary.eventTimeMillis - 1;
        Transaction current = transaction("current", 4_100, 2);
        current.eventTimeMillis = now;

        SlowBuildingFeatures features = SlowBuildingFeatureFunction.calculateFeatures(
                current, List.of(outside, boundary, current), SlowBuildingRiskConfig.defaults());

        assertEquals(2, features.payments30d);
        assertEquals(5_100.0, features.cumulativeAmount30d);
        assertEquals(30.0, features.relationshipAgeDays);
    }

    @Test
    void eventTimeOrderingMakesOutOfOrderInputDeterministic() {
        List<Transaction> history = weeklyHistory(200, 400, 750, 1_500, 3_000);
        Transaction current = history.get(history.size() - 1);

        SlowBuildingFeatures ordered = SlowBuildingFeatureFunction.calculateFeatures(
                current, history, SlowBuildingRiskConfig.defaults());
        SlowBuildingFeatures shuffled = SlowBuildingFeatureFunction.calculateFeatures(
                current, List.of(history.get(2), history.get(0), history.get(4), history.get(1), history.get(3)),
                SlowBuildingRiskConfig.defaults());

        assertEquals(ordered.cumulativeAmount30d, shuffled.cumulativeAmount30d);
        assertEquals(ordered.successiveGrowthCount, shuffled.successiveGrowthCount);
        assertEquals(ordered.currentToFirstAmountRatio, shuffled.currentToFirstAmountRatio);
        assertEquals(ordered.signal, shuffled.signal);
    }

    @Test
    void repeatedAmountsDoNotSatisfyGrowthCondition() {
        List<Transaction> history = weeklyHistory(1_000, 1_000, 1_000, 1_000, 1_000);
        Transaction current = history.get(history.size() - 1);
        SlowBuildingFeatures features = SlowBuildingFeatureFunction.calculateFeatures(
                current, history, SlowBuildingRiskConfig.defaults());

        assertEquals(0, features.successiveGrowthCount);
        assertEquals(false, features.signal);
    }

    private static JsonNode assess(Transaction transaction, double threshold) throws Exception {
        return JSON.readTree(EnrichmentFunction.assessmentJson(transaction, List.of(transaction), threshold));
    }

    private static Transaction transaction(String id, double amount, Integer beneficiaryPaymentCount) {
        Transaction transaction = new Transaction();
        transaction.transactionId = id;
        transaction.userId = "customer-1";
        transaction.merchantId = "beneficiary:stable-id";
        transaction.amount = amount;
        transaction.deviceId = "device-1";
        transaction.paymentChannel = "OTHER";
        transaction.beneficiaryPaymentCount = beneficiaryPaymentCount;
        transaction.beneficiaryId = "stable-beneficiary";
        transaction.eventTimeMillis = 1_800_000_000_000L;
        return transaction;
    }

    private static List<Transaction> weeklyHistory(double... amounts) {
        List<Transaction> result = new java.util.ArrayList<>();
        long start = 1_800_000_000_000L;
        for (int index = 0; index < amounts.length; index++) {
            Transaction transaction = transaction("week-" + (index + 1), amounts[index], index);
            transaction.eventTimeMillis = start + index * 7L * 24 * 60 * 60 * 1_000;
            result.add(transaction);
        }
        return result;
    }
}
