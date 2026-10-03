-- =============================================================================
-- CarbonX :: 02_indexes.sql
-- =============================================================================

-- Ingest idempotency. A UNIQUE index on a partitioned table must include the
-- partition key (reading_ts), which it does.
--
-- NOTE: no WHERE clause here, and that is deliberate. PostgreSQL treats NULLs as
-- distinct in a unique index, so rows with sensor_id IS NULL (manually entered
-- readings) are never rejected, while real sensor readings are de-duplicated.
-- A partial index ("WHERE sensor_id IS NOT NULL") would also break
-- ON CONFLICT (sensor_id, reading_ts) inference, because PostgreSQL cannot
-- prove the index predicate from an INSERT that has no WHERE clause.
CREATE UNIQUE INDEX uq_reading_sensor_ts ON emission_reading (sensor_id, reading_ts);

-- B-tree on the hot read path
CREATE INDEX idx_facility_company     ON facility (company_id);
CREATE INDEX idx_facility_city        ON facility (city_id);
CREATE INDEX idx_reading_fac_ts       ON emission_reading (facility_id, reading_ts DESC);

-- BRIN instead of a second b-tree: readings arrive in time order, so the index
-- is physically correlated and a BRIN "block range" index is ~1000x smaller.
CREATE INDEX idx_reading_ts_brin      ON emission_reading USING BRIN (reading_ts) WITH (pages_per_range = 64);

-- Wallet
CREATE INDEX idx_ledger_company_batch ON credit_ledger (company_id, batch_id);
CREATE INDEX idx_ledger_batch         ON credit_ledger (batch_id);
CREATE INDEX idx_ledger_created       ON credit_ledger (company_id, created_at DESC);
CREATE INDEX idx_retirement_company   ON credit_retirement (company_id, period_id);

-- Market: the index also serves the matcher, which filters on (side, status)
-- and orders by (price_per_credit, created_at).
CREATE INDEX idx_order_book           ON market_order (side, status, price_per_credit, created_at);
CREATE INDEX idx_order_company        ON market_order (company_id, status);
CREATE INDEX idx_trade_ts             ON trade (trade_ts DESC);
CREATE INDEX idx_trade_buy_order      ON trade (buy_order_id);
CREATE INDEX idx_trade_sell_order     ON trade (sell_order_id);
CREATE INDEX idx_payment_payer        ON payment (payer_company_id, paid_at DESC);

-- Monitoring / compliance
CREATE INDEX idx_alert_company_unread ON alert (company_id) WHERE is_read = FALSE;
CREATE INDEX idx_alert_company_period ON alert (company_id, period_id);
CREATE INDEX idx_report_status        ON emission_report (status);
CREATE INDEX idx_period_total_period  ON period_total (period_id);

-- Audit
CREATE INDEX idx_audit_table_time     ON audit_log (table_name, changed_at DESC);
CREATE INDEX idx_audit_changed_by     ON audit_log (changed_by, changed_at DESC);

-- Foreign keys not already covered by a left-prefix match of an index above
CREATE INDEX idx_sensor_facility      ON sensor (facility_id);
CREATE INDEX idx_fuel_facility        ON facility_fuel (fuel_id);
CREATE INDEX idx_ledger_trade         ON credit_ledger (ref_trade_id) WHERE ref_trade_id IS NOT NULL;
