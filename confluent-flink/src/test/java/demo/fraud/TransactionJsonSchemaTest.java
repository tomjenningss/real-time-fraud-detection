package demo.fraud;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class TransactionJsonSchemaTest {
    private final TransactionJsonSchema schema = new TransactionJsonSchema();

    @Test
    void readsServerDerivedBeneficiaryPaymentCount() throws Exception {
        Transaction transaction = schema.deserialize(payload(
                ",\"beneficiary_payment_count\":0,\"beneficiary_id\":\"beneficiary-1\""));

        assertEquals(0, transaction.beneficiaryPaymentCount);
        assertEquals("beneficiary-1", transaction.beneficiaryId);
    }

    @Test
    void keepsHistoryOptionalForNonGlaramaraProducers() throws Exception {
        Transaction transaction = schema.deserialize(payload(""));

        assertNull(transaction.beneficiaryPaymentCount);
        assertNull(transaction.beneficiaryId);
    }

    @Test
    void rejectsInvalidBeneficiaryPaymentCount() {
        assertThrows(IOException.class, () -> schema.deserialize(payload(",\"beneficiary_payment_count\":-1")));
    }

    private static byte[] payload(String extraField) {
        String value = "{\"transaction_id\":\"tx-1\",\"user_id\":\"user-1\","
                + "\"merchant_id\":\"merchant-1\",\"amount\":5000,\"device_id\":\"device-1\","
                + "\"payment_channel\":\"OTHER\",\"event_time\":\"2026-11-02 12:00:00.000\""
                + extraField + "}";
        return value.getBytes(StandardCharsets.UTF_8);
    }
}
