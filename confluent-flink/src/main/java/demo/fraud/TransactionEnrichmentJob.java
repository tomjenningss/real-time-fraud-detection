package demo.fraud;

import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.api.common.restartstrategy.RestartStrategies;
import org.apache.flink.connector.base.DeliveryGuarantee;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.streaming.api.CheckpointingMode;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;

import java.time.Duration;

public class TransactionEnrichmentJob {
    public static void main(String[] args) throws Exception {
        String brokers = env("KAFKA_BOOTSTRAP_SERVERS", "kafka:29092");
        String input = env("ENRICHMENT_INPUT_TOPIC", "payments.raw.demo");
        String output = env("ENRICHMENT_OUTPUT_TOPIC", "payments.enriched.demo");
        String group = env("ENRICHMENT_GROUP_ID", "flink-transaction-enrichment-v1");
        String startupMode = env("ENRICHMENT_STARTUP_MODE", "latest");

        StreamExecutionEnvironment environment = StreamExecutionEnvironment.getExecutionEnvironment();
        environment.setParallelism(1);
        environment.enableCheckpointing(10_000L, CheckpointingMode.AT_LEAST_ONCE);
        environment.getCheckpointConfig().setCheckpointTimeout(60_000L);
        environment.getCheckpointConfig().setMinPauseBetweenCheckpoints(5_000L);
        environment.getCheckpointConfig().setMaxConcurrentCheckpoints(1);
        environment.setRestartStrategy(RestartStrategies.fixedDelayRestart(3, 5_000L));

        KafkaSource<Transaction> source = KafkaSource.<Transaction>builder()
                .setBootstrapServers(brokers).setTopics(input).setGroupId(group)
                .setStartingOffsets(startupOffsets(startupMode))
                .setValueOnlyDeserializer(new TransactionJsonSchema()).build();

        WatermarkStrategy<Transaction> watermarks = WatermarkStrategy
                .<Transaction>forBoundedOutOfOrderness(Duration.ofSeconds(2))
                .withTimestampAssigner((tx, ignored) -> tx.eventTimeMillis)
                .withIdleness(Duration.ofSeconds(15));

        SingleOutputStreamOperator<String> assessments = environment.fromSource(source, watermarks, "payments.raw.demo")
                .uid("payments-raw-source-v1")
                .keyBy(tx -> tx.userId)
                .process(new EnrichmentFunction())
                .uid("transaction-enrichment-v1")
                .name("event-time rolling enrichment");

        KafkaSink<String> sink = KafkaSink.<String>builder().setBootstrapServers(brokers)
                .setRecordSerializer(KafkaRecordSerializationSchema.builder()
                        .setTopic(output).setValueSerializationSchema(new SimpleStringSchema()).build())
                .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE).build();
        assessments.sinkTo(sink).uid("payments-enriched-sink-v1")
                .name("payments.enriched.demo (at-least-once)");
        assessments.getSideOutput(EnrichmentFunction.LATE_EVENTS)
                .print("late-transaction").uid("late-transaction-log-v1");
        environment.execute("Per-transaction behavioural enrichment");
    }

    private static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }

    private static OffsetsInitializer startupOffsets(String mode) {
        if ("latest".equals(mode)) return OffsetsInitializer.latest();
        if ("earliest".equals(mode)) return OffsetsInitializer.earliest();
        throw new IllegalArgumentException("ENRICHMENT_STARTUP_MODE must be latest or earliest");
    }
}
