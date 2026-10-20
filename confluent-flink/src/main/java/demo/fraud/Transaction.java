package demo.fraud;

import java.io.Serializable;

public class Transaction implements Serializable {
    public String transactionId;
    public String userId;
    public String merchantId;
    public double amount;
    public String deviceId;
    public String paymentChannel;
    public long eventTimeMillis;

    public Transaction() {}
}
