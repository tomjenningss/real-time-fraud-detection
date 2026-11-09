package demo.fraud;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.flink.api.common.state.ListState;
import org.apache.flink.api.common.state.ListStateDescriptor;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;
import org.apache.flink.util.OutputTag;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

public class EnrichmentFunction extends KeyedProcessFunction<String, Transaction, String> {
    public static final OutputTag<String> LATE_EVENTS = new OutputTag<String>("late-transactions") {};
    private static final long ONE_MINUTE = 60_000L;
    private static final long TWO_MINUTES = 120_000L;
    private static final long TEN_MINUTES = 600_000L;
    private static final long DEDUP_RETENTION = TEN_MINUTES + 2_000L;
    private static final ObjectMapper JSON = new ObjectMapper();
    private final double newBeneficiaryHighValueThreshold;
    private final SlowBuildingRiskConfig slowBuildingConfig;
    private final String assessmentStream;

    private transient ListState<Transaction> pending;
    private transient ListState<Transaction> history;
    private transient MapState<String, Long> seenIds;

    public EnrichmentFunction(double newBeneficiaryHighValueThreshold) {
        this(newBeneficiaryHighValueThreshold, SlowBuildingRiskConfig.defaults(), "live");
    }

    public EnrichmentFunction(
            double newBeneficiaryHighValueThreshold,
            SlowBuildingRiskConfig slowBuildingConfig,
            String assessmentStream
    ) {
        this.newBeneficiaryHighValueThreshold = newBeneficiaryHighValueThreshold;
        this.slowBuildingConfig = slowBuildingConfig;
        this.assessmentStream = assessmentStream;
    }

    @Override
    public void open(Configuration ignored) {
        pending = getRuntimeContext().getListState(new ListStateDescriptor<>("pending", Transaction.class));
        history = getRuntimeContext().getListState(new ListStateDescriptor<>("history-10m", Transaction.class));
        seenIds = getRuntimeContext().getMapState(new MapStateDescriptor<>("seen-transaction-ids", String.class, Long.class));
    }

    @Override
    public void processElement(Transaction tx, Context ctx, Collector<String> out) throws Exception {
        if ("__watermark__".equals(tx.userId)) return;
        if (seenIds.contains(tx.transactionId)) return;

        long watermark = ctx.timerService().currentWatermark();
        if (tx.eventTimeMillis <= watermark) {
            ctx.output(LATE_EVENTS, lateJson(tx, watermark));
            return;
        }

        seenIds.put(tx.transactionId, tx.eventTimeMillis);
        pending.add(tx);
        ctx.timerService().registerEventTimeTimer(tx.eventTimeMillis);
        ctx.timerService().registerEventTimeTimer(tx.eventTimeMillis + DEDUP_RETENTION);
    }

    @Override
    public void onTimer(long timestamp, OnTimerContext ctx, Collector<String> out) throws Exception {
        List<Transaction> waiting = copy(pending.get());
        List<Transaction> due = new ArrayList<>();
        List<Transaction> remaining = new ArrayList<>();
        for (Transaction tx : waiting) {
            if (tx.eventTimeMillis <= timestamp) due.add(tx); else remaining.add(tx);
        }
        due.sort(Comparator.comparingLong((Transaction tx) -> tx.eventTimeMillis)
                .thenComparing(tx -> tx.transactionId));

        List<Transaction> prior = copy(history.get());
        for (Transaction tx : due) {
            prior.removeIf(old -> old.eventTimeMillis < tx.eventTimeMillis - TEN_MINUTES);
            prior.add(tx);
            out.collect(assessmentJson(
                    tx, prior, newBeneficiaryHighValueThreshold, slowBuildingConfig, assessmentStream));
        }
        pending.update(remaining);

        long historyCutoff = timestamp - TEN_MINUTES;
        prior.removeIf(tx -> tx.eventTimeMillis < historyCutoff);
        history.update(prior);

        List<String> expired = new ArrayList<>();
        for (String id : seenIds.keys()) {
            Long eventTime = seenIds.get(id);
            if (eventTime != null && eventTime + DEDUP_RETENTION <= timestamp) expired.add(id);
        }
        for (String id : expired) seenIds.remove(id);
    }

    static String assessmentJson(
            Transaction current, List<Transaction> events, double newBeneficiaryHighValueThreshold
    ) throws Exception {
        return assessmentJson(
                current, events, newBeneficiaryHighValueThreshold, SlowBuildingRiskConfig.defaults(), "live");
    }

    static String assessmentJson(
            Transaction current,
            List<Transaction> events,
            double newBeneficiaryHighValueThreshold,
            SlowBuildingRiskConfig slowBuildingConfig,
            String assessmentStream
    ) throws Exception {
        int count1m = 0, count2m = 0, count10m = 0;
        double total2m = 0;
        java.util.Set<String> merchants2m = new java.util.HashSet<>();
        for (Transaction tx : events) {
            if (tx.eventTimeMillis > current.eventTimeMillis) continue;
            long age = current.eventTimeMillis - tx.eventTimeMillis;
            if (age <= TEN_MINUTES) count10m++;
            if (age <= TWO_MINUTES) {
                count2m++; total2m += tx.amount; merchants2m.add(tx.merchantId);
            }
            if (age <= ONE_MINUTE) count1m++;
        }
        boolean velocity = count2m >= 5;
        boolean hopping = count2m >= 5 && merchants2m.size() >= 4;
        boolean newBeneficiaryHighValue = current.beneficiaryPaymentCount != null
                && current.beneficiaryPaymentCount == 0
                && current.amount >= newBeneficiaryHighValueThreshold;
        SlowBuildingFeatures slow = current.slowBuildingFeatures;
        boolean slowBuildingRisk = slow != null && slow.signal;

        ObjectNode root = JSON.createObjectNode();
        root.put("assessment_type", "transaction");
        root.put("assessment_stream", assessmentStream);
        root.put("transaction_id", current.transactionId);
        root.put("user_id", current.userId);
        root.put("amount", Math.round(current.amount * 100.0) / 100.0);
        root.put("merchant_id", current.merchantId);
        root.put("transaction_timestamp", Instant.ofEpochMilli(current.eventTimeMillis).toString());
        root.put("transactions_1m", count1m);
        root.put("transactions_2m", count2m);
        root.put("transactions_10m", count10m);
        root.put("distinct_merchants_2m", merchants2m.size());
        root.put("total_amount_2m", Math.round(total2m * 100.0) / 100.0);
        if (current.beneficiaryPaymentCount == null) root.putNull("beneficiary_payment_count");
        else root.put("beneficiary_payment_count", current.beneficiaryPaymentCount);
        if (slow != null) {
            ObjectNode evidence = root.putObject("slow_building_beneficiary_evidence");
            evidence.put("beneficiary_id", slow.beneficiaryId);
            evidence.put("window_days", 30);
            evidence.put("payments_30d", slow.payments30d);
            evidence.put("cumulative_amount_30d", slow.cumulativeAmount30d);
            evidence.put("successive_growth_count", slow.successiveGrowthCount);
            evidence.put("successive_pair_count", slow.successivePairCount);
            evidence.put("current_to_first_amount_ratio", slow.currentToFirstAmountRatio);
            evidence.put("observed_relationship_age_days", slow.relationshipAgeDays);
            evidence.put("window_start", Instant.ofEpochMilli(slow.windowStartMillis).toString());
            evidence.put("window_end", Instant.ofEpochMilli(slow.windowEndMillis).toString());
            ObjectNode thresholds = evidence.putObject("thresholds");
            thresholds.put("minimum_payments", slowBuildingConfig.minimumPayments);
            thresholds.put("minimum_cumulative_amount", slowBuildingConfig.minimumCumulativeAmount);
            thresholds.put("minimum_successive_growth_count", slowBuildingConfig.minimumSuccessiveGrowthCount);
            thresholds.put("minimum_current_to_first_amount_ratio", slowBuildingConfig.minimumCurrentToFirstRatio);
            thresholds.put("minimum_observed_relationship_age_days", slowBuildingConfig.minimumRelationshipAgeDays);
        } else {
            root.putNull("slow_building_beneficiary_evidence");
        }
        ArrayNode signals = root.putArray("signals");
        ArrayNode signalIds = root.putArray("signal_ids");
        if (velocity) { signals.add("HIGH_VELOCITY"); signalIds.add("txn:" + current.transactionId + ":HIGH_VELOCITY"); }
        if (hopping) { signals.add("MERCHANT_HOPPING"); signalIds.add("txn:" + current.transactionId + ":MERCHANT_HOPPING"); }
        if (newBeneficiaryHighValue) {
            signals.add("NEW_BENEFICIARY_HIGH_VALUE");
            signalIds.add("txn:" + current.transactionId + ":NEW_BENEFICIARY_HIGH_VALUE");
        }
        if (slowBuildingRisk) {
            signals.add("SLOW_BUILDING_BENEFICIARY_RISK");
            signalIds.add("txn:" + current.transactionId + ":SLOW_BUILDING_BENEFICIARY_RISK");
        }
        root.put("risk_level", velocity || hopping || newBeneficiaryHighValue || slowBuildingRisk ? "HIGH" : "LOW");
        root.put("assessment_timestamp", Instant.now().toString());
        root.put("evidence_source", "flink");
        return JSON.writeValueAsString(root);
    }

    static String lateJson(Transaction tx, long watermark) throws Exception {
        ObjectNode root = JSON.createObjectNode();
        root.put("transaction_id", tx.transactionId);
        root.put("user_id", tx.userId);
        root.put("event_timestamp", Instant.ofEpochMilli(tx.eventTimeMillis).toString());
        root.put("watermark", Instant.ofEpochMilli(watermark).toString());
        root.put("reason", "event_at_or_before_current_watermark");
        return JSON.writeValueAsString(root);
    }

    private static List<Transaction> copy(Iterable<Transaction> source) {
        List<Transaction> result = new ArrayList<>();
        if (source != null) for (Transaction tx : source) result.add(tx);
        return result;
    }
}
