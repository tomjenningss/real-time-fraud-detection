package demo.fraud;

import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.restartstrategy.RestartStrategies;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
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
        String input = argument(args, "--input-topic", env("ENRICHMENT_INPUT_TOPIC", "payments.raw.demo"));
        String output = argument(args, "--output-topic", env("ENRICHMENT_OUTPUT_TOPIC", "payments.enriched.demo"));
        String group = argument(args, "--group-id", env("ENRICHMENT_GROUP_ID", "flink-transaction-enrichment-v1"));
        String startupMode = argument(args, "--startup-mode", env("ENRICHMENT_STARTUP_MODE", "latest"));
        double newBeneficiaryThreshold = positiveAmountEnv(
                "NEW_BENEFICIARY_HIGH_VALUE_THRESHOLD_GBP", "5000");
        SlowBuildingRiskConfig slowBuildingConfig = slowBuildingConfig();
        String assessmentStream = argument(
                args, "--assessment-stream", env("ENRICHMENT_ASSESSMENT_STREAM", "live"));
        String pipelineId = argument(args, "--pipeline-id", env("ENRICHMENT_PIPELINE_ID", "live-v1"));
        String jobName = argument(
                args, "--job-name", env("ENRICHMENT_JOB_NAME", "Per-transaction behavioural enrichment"));

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

        SingleOutputStreamOperator<Transaction> slowBuilding = environment
                .fromSource(source, watermarks, input)
                .uid("payments-raw-source-" + pipelineId)
                .keyBy(tx -> tx.userId + "\u001f" + (
                        tx.beneficiaryId == null ? "absent:" + tx.transactionId : tx.beneficiaryId))
                .process(new SlowBuildingFeatureFunction(slowBuildingConfig))
                .uid("slow-building-features-" + pipelineId)
                .name("30-day customer-beneficiary features");

        SingleOutputStreamOperator<String> assessments = slowBuilding
                .keyBy(tx -> tx.userId)
                .process(new EnrichmentFunction(
                        newBeneficiaryThreshold, slowBuildingConfig, assessmentStream))
                .uid("transaction-enrichment-" + pipelineId)
                .name("event-time rolling enrichment");

        KafkaSink<String> sink = KafkaSink.<String>builder().setBootstrapServers(brokers)
                .setRecordSerializer(KafkaRecordSerializationSchema.builder()
                        .setTopic(output).setValueSerializationSchema(new SimpleStringSchema()).build())
                .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE).build();
        assessments.sinkTo(sink).uid("payments-enriched-sink-" + pipelineId)
                .name(output + " (at-least-once)");
        assessments.getSideOutput(EnrichmentFunction.LATE_EVENTS)
                .print("late-transaction").uid("late-transaction-log-" + pipelineId);
        slowBuilding.getSideOutput(SlowBuildingFeatureFunction.LATE_EVENTS)
                .print("slow-building-late-transaction").uid("slow-building-late-log-" + pipelineId);
        environment.execute(jobName);
    }

    private static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }

    private static String argument(String[] args, String name, String fallback) {
        for (int index = 0; index < args.length; index++) {
            if (name.equals(args[index])) {
                if (index + 1 >= args.length || args[index + 1].isBlank()) {
                    throw new IllegalArgumentException(name + " requires a value");
                }
                return args[index + 1];
            }
        }
        return fallback;
    }

    static double positiveAmountEnv(String name, String fallback) {
        double value;
        try {
            value = Double.parseDouble(env(name, fallback));
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException(name + " must be a positive GBP amount", error);
        }
        if (!Double.isFinite(value) || value <= 0) {
            throw new IllegalArgumentException(name + " must be a positive GBP amount");
        }
        return value;
    }

    private static SlowBuildingRiskConfig slowBuildingConfig() {
        return new SlowBuildingRiskConfig(
                positiveIntEnv("SLOW_BUILDING_MIN_PAYMENTS", "4"),
                positiveAmountEnv("SLOW_BUILDING_MIN_CUMULATIVE_GBP", "4000"),
                positiveIntEnv("SLOW_BUILDING_MIN_GROWTH_COUNT", "3"),
                positiveAmountEnv("SLOW_BUILDING_MIN_CURRENT_TO_FIRST_RATIO", "4"),
                nonNegativeDoubleEnv("SLOW_BUILDING_MIN_RELATIONSHIP_AGE_DAYS", "21"));
    }

    private static int positiveIntEnv(String name, String fallback) {
        int value;
        try {
            value = Integer.parseInt(env(name, fallback));
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException(name + " must be a positive integer", error);
        }
        if (value < 1) throw new IllegalArgumentException(name + " must be a positive integer");
        return value;
    }

    private static double nonNegativeDoubleEnv(String name, String fallback) {
        double value;
        try {
            value = Double.parseDouble(env(name, fallback));
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException(name + " must be a non-negative number", error);
        }
        if (!Double.isFinite(value) || value < 0) {
            throw new IllegalArgumentException(name + " must be a non-negative number");
        }
        return value;
    }

    private static OffsetsInitializer startupOffsets(String mode) {
        if ("latest".equals(mode)) return OffsetsInitializer.latest();
        if ("earliest".equals(mode)) return OffsetsInitializer.earliest();
        throw new IllegalArgumentException("ENRICHMENT_STARTUP_MODE must be latest or earliest");
    }
}
