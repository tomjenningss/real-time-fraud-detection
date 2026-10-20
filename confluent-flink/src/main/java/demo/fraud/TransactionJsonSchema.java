package demo.fraud;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.flink.api.common.serialization.AbstractDeserializationSchema;

import java.io.IOException;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;

public class TransactionJsonSchema extends AbstractDeserializationSchema<Transaction> {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final DateTimeFormatter EVENT_TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS");

    @Override
    public Transaction deserialize(byte[] bytes) throws IOException {
        JsonNode node = JSON.readTree(bytes);
        Transaction tx = new Transaction();
        tx.transactionId = required(node, "transaction_id");
        tx.userId = required(node, "user_id");
        tx.merchantId = required(node, "merchant_id");
        tx.amount = node.required("amount").asDouble();
        tx.deviceId = required(node, "device_id");
        tx.paymentChannel = required(node, "payment_channel");
        tx.eventTimeMillis = LocalDateTime.parse(required(node, "event_time"), EVENT_TIME)
                .toInstant(ZoneOffset.UTC).toEpochMilli();
        return tx;
    }

    private static String required(JsonNode node, String name) throws IOException {
        JsonNode value = node.get(name);
        if (value == null || value.isNull() || value.asText().isBlank()) {
            throw new IOException("Missing required field: " + name);
        }
        return value.asText();
    }
}
