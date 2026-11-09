package demo.fraud;

import java.io.Serializable;

/** Immutable thresholds captured by Flink operator closures. */
public class SlowBuildingRiskConfig implements Serializable {
    private static final long serialVersionUID = 1L;

    public final int minimumPayments;
    public final double minimumCumulativeAmount;
    public final int minimumSuccessiveGrowthCount;
    public final double minimumCurrentToFirstRatio;
    public final double minimumRelationshipAgeDays;

    public SlowBuildingRiskConfig(
            int minimumPayments,
            double minimumCumulativeAmount,
            int minimumSuccessiveGrowthCount,
            double minimumCurrentToFirstRatio,
            double minimumRelationshipAgeDays
    ) {
        if (minimumPayments < 2 || minimumCumulativeAmount <= 0 || minimumSuccessiveGrowthCount < 1
                || minimumCurrentToFirstRatio <= 1 || minimumRelationshipAgeDays < 0) {
            throw new IllegalArgumentException("slow-building thresholds are invalid");
        }
        this.minimumPayments = minimumPayments;
        this.minimumCumulativeAmount = minimumCumulativeAmount;
        this.minimumSuccessiveGrowthCount = minimumSuccessiveGrowthCount;
        this.minimumCurrentToFirstRatio = minimumCurrentToFirstRatio;
        this.minimumRelationshipAgeDays = minimumRelationshipAgeDays;
    }

    public static SlowBuildingRiskConfig defaults() {
        return new SlowBuildingRiskConfig(4, 4_000.0, 3, 4.0, 21.0);
    }
}
