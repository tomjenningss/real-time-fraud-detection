-- Flink 1.20 / kafka SQL connector 3.4.0-1.20
-- Launch via: podman compose run --rm --entrypoint /opt/flink/bin/sql-client.sh sql-client embedded -Drest.address=jobmanager -Drest.port=8081 -f /workspace/sql/fraud_signals.sql
SET 'execution.runtime-mode' = 'streaming';
SET 'parallelism.default' = '1';
SET 'execution.checkpointing.interval' = '10 s';
SET 'pipeline.name' = 'Fraud SQL signals analytics';

CREATE TABLE payments_raw (
  transaction_id STRING,
  user_id STRING,
  merchant_id STRING,
  amount DECIMAL(12,2),
  device_id STRING,
  payment_channel STRING,
  event_time TIMESTAMP(3),
  WATERMARK FOR event_time AS event_time - INTERVAL '2' SECOND
) WITH (
  'connector' = 'kafka',
  'topic' = 'payments.raw.demo',
  'properties.bootstrap.servers' = 'kafka:29092',
  'properties.group.id' = 'flink-fraud-analytics-v1',
  -- Deliberate stateless demo bootstrap: ignore historical/group offsets and wait for new payments.
  'scan.startup.mode' = 'latest-offset',
  'format' = 'json',
  'json.fail-on-missing-field' = 'true'
);

CREATE TABLE fraud_signals (
  user_id STRING,
  window_start TIMESTAMP(3),
  window_end TIMESTAMP(3),
  transaction_count BIGINT,
  distinct_merchants BIGINT,
  total_amount DECIMAL(22,2),
  signal_type STRING,
  signal_reason STRING
) WITH (
  'connector' = 'kafka',
  'topic' = 'fraud.signals.demo',
  'properties.bootstrap.servers' = 'kafka:29092',
  'format' = 'json',
  'sink.delivery-guarantee' = 'at-least-once'
);

-- These are contextual signals, NOT approval/block decisions.
-- 2-minute overlapping windows, updated every 10 seconds.
-- An alert may be emitted in multiple overlapping windows for a single burst.
INSERT INTO fraud_signals
SELECT user_id, window_start, window_end, transaction_count, distinct_merchants,
       total_amount,
       CASE WHEN transaction_count >= 5 AND distinct_merchants >= 4 THEN 'MERCHANT_HOPPING'
            ELSE 'HIGH_VELOCITY' END AS signal_type,
       CASE WHEN transaction_count >= 5 AND distinct_merchants >= 4
            THEN 'At least five transactions across four or more merchants within two minutes'
            ELSE 'At least five transactions within two minutes' END AS signal_reason
FROM (
  SELECT user_id, window_start, window_end,
         COUNT(*) AS transaction_count,
         COUNT(DISTINCT merchant_id) AS distinct_merchants,
         CAST(SUM(amount) AS DECIMAL(22,2)) AS total_amount
  FROM TABLE(
    HOP(TABLE payments_raw, DESCRIPTOR(event_time),
        INTERVAL '10' SECOND, INTERVAL '2' MINUTE)
  )
  WHERE user_id <> '__watermark__'
  GROUP BY user_id, window_start, window_end
)
WHERE transaction_count >= 5;
