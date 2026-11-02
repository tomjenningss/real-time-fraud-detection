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
        transaction.eventTimeMillis = 1_800_000_000_000L;
        return transaction;
    }
}
