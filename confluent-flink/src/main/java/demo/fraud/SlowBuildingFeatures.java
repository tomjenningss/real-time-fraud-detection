package demo.fraud;

import java.io.Serializable;

public class SlowBuildingFeatures implements Serializable {
    public String beneficiaryId;
    public int payments30d;
    public double cumulativeAmount30d;
    public int successiveGrowthCount;
    public int successivePairCount;
    public double currentToFirstAmountRatio;
    public double relationshipAgeDays;
    public long windowStartMillis;
    public long windowEndMillis;
    public boolean signal;

    public SlowBuildingFeatures() {}
}
