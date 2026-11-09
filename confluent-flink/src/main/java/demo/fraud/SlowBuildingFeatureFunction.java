package demo.fraud;

import org.apache.flink.api.common.state.ListState;
import org.apache.flink.api.common.state.ListStateDescriptor;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;
import org.apache.flink.util.OutputTag;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

public class SlowBuildingFeatureFunction extends KeyedProcessFunction<String, Transaction, Transaction> {
    public static final OutputTag<String> LATE_EVENTS = new OutputTag<String>("slow-building-late-transactions") {};
    static final long THIRTY_DAYS = 30L * 24 * 60 * 60 * 1_000;
    private static final long OUT_OF_ORDER_ALLOWANCE = 2_000L;
    private static final long DEDUP_RETENTION = THIRTY_DAYS + OUT_OF_ORDER_ALLOWANCE;
    private final SlowBuildingRiskConfig config;

    private transient ListState<Transaction> pending;
    private transient ListState<Transaction> history;
    private transient MapState<String, Long> seenIds;

    public SlowBuildingFeatureFunction(SlowBuildingRiskConfig config) {
        this.config = config;
    }

    @Override
    public void open(Configuration ignored) {
        pending = getRuntimeContext().getListState(new ListStateDescriptor<>(
                "slow-building-pending", Transaction.class));
        history = getRuntimeContext().getListState(new ListStateDescriptor<>(
                "slow-building-history-30d", Transaction.class));
        seenIds = getRuntimeContext().getMapState(new MapStateDescriptor<>(
                "slow-building-seen-transaction-ids", String.class, Long.class));
    }

    @Override
    public void processElement(Transaction tx, Context ctx, Collector<Transaction> out) throws Exception {
        if ("__watermark__".equals(tx.userId)) {
            out.collect(tx);
            return;
        }
        if (tx.beneficiaryId == null) {
            out.collect(tx);
            return;
        }
        if (seenIds.contains(tx.transactionId)) return;
        long watermark = ctx.timerService().currentWatermark();
        if (tx.eventTimeMillis <= watermark) {
            ctx.output(LATE_EVENTS, EnrichmentFunction.lateJson(tx, watermark));
            return;
        }
        seenIds.put(tx.transactionId, tx.eventTimeMillis);
        pending.add(tx);
        ctx.timerService().registerEventTimeTimer(tx.eventTimeMillis);
        ctx.timerService().registerEventTimeTimer(tx.eventTimeMillis + DEDUP_RETENTION);
    }

    @Override
    public void onTimer(long timestamp, OnTimerContext ctx, Collector<Transaction> out) throws Exception {
        List<Transaction> due = new ArrayList<>();
        List<Transaction> remaining = new ArrayList<>();
        for (Transaction tx : copy(pending.get())) {
            if (tx.eventTimeMillis <= timestamp) due.add(tx); else remaining.add(tx);
        }
        due.sort(Comparator.comparingLong((Transaction tx) -> tx.eventTimeMillis)
                .thenComparing(tx -> tx.transactionId));

        List<Transaction> prior = copy(history.get());
        for (Transaction tx : due) {
            prior.removeIf(old -> old.eventTimeMillis < tx.eventTimeMillis - THIRTY_DAYS);
            prior.add(tx);
            tx.slowBuildingFeatures = calculateFeatures(tx, prior, config);
            out.collect(tx);
        }
        pending.update(remaining);

        prior.removeIf(tx -> tx.eventTimeMillis < timestamp - THIRTY_DAYS);
        history.update(prior);
        List<String> expired = new ArrayList<>();
        for (String id : seenIds.keys()) {
            Long eventTime = seenIds.get(id);
            if (eventTime != null && eventTime + DEDUP_RETENTION <= timestamp) expired.add(id);
        }
        for (String id : expired) seenIds.remove(id);
    }

    static SlowBuildingFeatures calculateFeatures(
            Transaction current, List<Transaction> events, SlowBuildingRiskConfig config
    ) {
        List<Transaction> ordered = new ArrayList<>();
        long cutoff = current.eventTimeMillis - THIRTY_DAYS;
        for (Transaction tx : events) {
            if (tx.eventTimeMillis >= cutoff && tx.eventTimeMillis <= current.eventTimeMillis) ordered.add(tx);
        }
        ordered.sort(Comparator.comparingLong((Transaction tx) -> tx.eventTimeMillis)
                .thenComparing(tx -> tx.transactionId));
        SlowBuildingFeatures features = new SlowBuildingFeatures();
        features.beneficiaryId = current.beneficiaryId;
        features.payments30d = ordered.size();
        features.cumulativeAmount30d = roundMoney(ordered.stream().mapToDouble(tx -> tx.amount).sum());
        features.successivePairCount = Math.max(0, ordered.size() - 1);
        for (int index = 1; index < ordered.size(); index++) {
            if (ordered.get(index).amount > ordered.get(index - 1).amount) {
                features.successiveGrowthCount++;
            }
        }
        if (!ordered.isEmpty()) {
            Transaction first = ordered.get(0);
            features.windowStartMillis = first.eventTimeMillis;
            features.windowEndMillis = current.eventTimeMillis;
            features.relationshipAgeDays = roundFeature(
                    (current.eventTimeMillis - first.eventTimeMillis) / 86_400_000.0);
            features.currentToFirstAmountRatio = first.amount > 0
                    ? roundFeature(current.amount / first.amount) : 0;
        }
        features.signal = features.payments30d >= config.minimumPayments
                && features.cumulativeAmount30d >= config.minimumCumulativeAmount
                && features.successiveGrowthCount >= config.minimumSuccessiveGrowthCount
                && features.currentToFirstAmountRatio >= config.minimumCurrentToFirstRatio
                && features.relationshipAgeDays >= config.minimumRelationshipAgeDays;
        return features;
    }

    private static double roundMoney(double value) {
        return Math.round(value * 100.0) / 100.0;
    }

    private static double roundFeature(double value) {
        return Math.round(value * 10_000.0) / 10_000.0;
    }

    private static List<Transaction> copy(Iterable<Transaction> source) {
        List<Transaction> result = new ArrayList<>();
        if (source != null) for (Transaction tx : source) result.add(tx);
        return result;
    }
}
