-- =============================================================================
-- CarbonX :: 05_triggers.sql
-- =============================================================================

-- 8.1 ------------------------------------------ every company gets a wallet
CREATE OR REPLACE FUNCTION trg_company_wallet() RETURNS trigger AS $$
BEGIN
  INSERT INTO credit_account(company_id) VALUES (NEW.company_id);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER company_wallet AFTER INSERT ON company
FOR EACH ROW EXECUTE FUNCTION trg_company_wallet();


-- 8.2 ----------------------------- the ledger keeps wallet balances in sync
CREATE OR REPLACE FUNCTION trg_ledger_balance() RETURNS trigger AS $$
BEGIN
  UPDATE credit_account
     SET credit_balance = credit_balance + NEW.quantity,
         updated_at = now()
   WHERE company_id = NEW.company_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_balance AFTER INSERT ON credit_ledger
FOR EACH ROW EXECUTE FUNCTION trg_ledger_balance();


-- 8.3 ------------------------------------------- the ledger is append-only
CREATE OR REPLACE FUNCTION trg_ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only; post an ADJUST row instead'
    USING ERRCODE = 'CX003';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON credit_ledger
FOR EACH ROW EXECUTE FUNCTION trg_ledger_immutable();


-- 8.4 -------------------------- block SELL orders above the free balance
CREATE OR REPLACE FUNCTION trg_order_validate() RETURNS trigger AS $$
DECLARE v_bal NUMERIC; v_committed NUMERIC;
BEGIN
  IF NEW.side = 'SELL' THEN
    SELECT credit_balance INTO v_bal
      FROM credit_account WHERE company_id = NEW.company_id;

    -- Quantity already promised to other resting sell orders.
    SELECT COALESCE(SUM(quantity - filled_qty), 0) INTO v_committed
      FROM market_order
     WHERE company_id = NEW.company_id
       AND side = 'SELL'
       AND status IN ('OPEN', 'PARTIAL');

    IF COALESCE(v_bal, 0) - v_committed < NEW.quantity THEN
      RAISE EXCEPTION 'Insufficient credits: available %, requested %',
        COALESCE(v_bal, 0) - v_committed, NEW.quantity USING ERRCODE = 'CX001';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER order_validate BEFORE INSERT ON market_order
FOR EACH ROW EXECUTE FUNCTION trg_order_validate();


-- 8.5 ------------- maintain the per-company, per-period running total (O(1))
-- Fires BEFORE reading_alert: PostgreSQL runs AFTER triggers in name order.
CREATE OR REPLACE FUNCTION trg_period_total() RETURNS trigger AS $$
DECLARE v_company INT; v_period INT;
BEGIN
  SELECT company_id INTO v_company FROM facility WHERE facility_id = NEW.facility_id;
  SELECT period_id INTO v_period FROM compliance_period
   WHERE NEW.reading_ts::date BETWEEN start_date AND end_date;
  IF v_company IS NULL OR v_period IS NULL THEN
    RETURN NEW;                                  -- reading falls outside any period
  END IF;

  INSERT INTO period_total(company_id, period_id, tonnes)
  VALUES (v_company, v_period, NEW.co2_tonnes)
  ON CONFLICT (company_id, period_id) DO UPDATE
    SET tonnes     = period_total.tonnes + EXCLUDED.tonnes,
        updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER period_total AFTER INSERT ON emission_reading
FOR EACH ROW EXECUTE FUNCTION trg_period_total();


-- 8.6 ------------- cap alerts at 90% and 100%, plus a real-time notification
-- Reads the running total instead of re-aggregating the period on every row.
CREATE OR REPLACE FUNCTION trg_reading_alert() RETURNS trigger AS $$
DECLARE
  v_company INT; v_period INT; v_cap NUMERIC; v_total NUMERIC;
  v_pct NUMERIC; v_type TEXT; v_rows INT;
BEGIN
  SELECT company_id INTO v_company FROM facility WHERE facility_id = NEW.facility_id;
  SELECT period_id INTO v_period FROM compliance_period
   WHERE NEW.reading_ts::date BETWEEN start_date AND end_date;
  IF v_company IS NULL OR v_period IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT cap_tonnes INTO v_cap
    FROM emission_cap WHERE company_id = v_company AND period_id = v_period;
  IF v_cap IS NULL THEN
    RETURN NEW;                                  -- company has no cap: nothing to alert on
  END IF;

  SELECT tonnes INTO v_total FROM period_total
   WHERE company_id = v_company AND period_id = v_period;

  v_pct  := 100 * v_total / v_cap;
  v_type := CASE WHEN v_pct >= 100 THEN 'CAP_EXCEEDED'
                 WHEN v_pct >= 90  THEN 'CAP_90'
                 ELSE NULL END;

  IF v_type IS NOT NULL THEN
    INSERT INTO alert(company_id, period_id, alert_type, message)
    VALUES (v_company, v_period, v_type, format('Emissions at %s%% of cap', ROUND(v_pct, 1)))
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      PERFORM pg_notify('new_alert', json_build_object(
        'companyId', v_company, 'type', v_type, 'pct', ROUND(v_pct, 1))::text);
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER reading_alert AFTER INSERT ON emission_reading
FOR EACH ROW EXECUTE FUNCTION trg_reading_alert();


-- 8.7 --------------------------------- readings are append-only
-- Without this, an UPDATE or DELETE would silently desynchronise period_total,
-- because there is no UPDATE path on that table. Corrections are made by
-- inserting a further reading.
--
-- fn_ensure_partitions() sets app.maintenance='on' so partition re-homing,
-- which is a DELETE, is still allowed.
CREATE OR REPLACE FUNCTION trg_reading_immutable() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.maintenance', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION
    'emission_reading is append-only; insert a correcting reading instead'
    USING ERRCODE = 'CX003';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER reading_immutable BEFORE UPDATE OR DELETE ON emission_reading
FOR EACH ROW EXECUTE FUNCTION trg_reading_immutable();


-- 8.8 ------------------------------------------------- generic audit trigger
CREATE OR REPLACE FUNCTION trg_audit() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log(table_name, operation, row_pk, old_data, new_data, changed_by)
  VALUES (TG_TABLE_NAME,
          TG_OP,
          to_jsonb(COALESCE(NEW, OLD)) ->> TG_ARGV[0],
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
          NULLIF(current_setting('app.user_id', true), '')::INT);
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER aud_cap     AFTER INSERT OR UPDATE OR DELETE ON emission_cap
  FOR EACH ROW EXECUTE FUNCTION trg_audit('cap_id');
CREATE TRIGGER aud_penalty AFTER INSERT OR UPDATE OR DELETE ON penalty
  FOR EACH ROW EXECUTE FUNCTION trg_audit('penalty_id');
CREATE TRIGGER aud_report  AFTER INSERT OR UPDATE OR DELETE ON emission_report
  FOR EACH ROW EXECUTE FUNCTION trg_audit('report_id');
CREATE TRIGGER aud_order   AFTER INSERT OR UPDATE OR DELETE ON market_order
  FOR EACH ROW EXECUTE FUNCTION trg_audit('order_id');
CREATE TRIGGER aud_account AFTER UPDATE ON credit_account
  FOR EACH ROW EXECUTE FUNCTION trg_audit('account_id');
CREATE TRIGGER aud_user    AFTER UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION trg_audit('user_id');
