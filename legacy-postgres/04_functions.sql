-- =============================================================================
-- CarbonX :: 04_functions.sql
-- =============================================================================

-- 7.1 ------------------------------------------------------------------ issue
CREATE OR REPLACE FUNCTION fn_issue_batch(
  p_project INT, p_vintage INT, p_qty NUMERIC, p_expiry INT DEFAULT NULL)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE v_owner INT; v_batch INT;
BEGIN
  SELECT owner_company_id INTO v_owner FROM offset_project WHERE project_id = p_project;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Unknown project %', p_project USING ERRCODE = 'CX003';
  END IF;
  IF p_vintage < EXTRACT(YEAR FROM CURRENT_DATE)::INT THEN
    RAISE EXCEPTION 'Vintage year % is in the past', p_vintage USING ERRCODE = 'CX003';
  END IF;

  INSERT INTO credit_batch(project_id, vintage_year, quantity, expiry_year)
  VALUES (p_project, p_vintage, p_qty, COALESCE(p_expiry, p_vintage + 5))
  RETURNING batch_id INTO v_batch;

  -- trg_ledger_balance credits the owner's wallet from this row.
  INSERT INTO credit_ledger(company_id, batch_id, txn_type, quantity)
  VALUES (v_owner, v_batch, 'ISSUE', p_qty);

  RETURN v_batch;
END $$;


-- 7.2 --------------------------------------------------------- execute a trade
-- The core ACID transaction. Either the whole trade exists or none of it does.
CREATE OR REPLACE FUNCTION fn_execute_trade(p_buy BIGINT, p_sell BIGINT, p_qty NUMERIC)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  b market_order%ROWTYPE;
  s market_order%ROWTYPE;
  v_price NUMERIC(12,2);
  v_cost  NUMERIC(16,2);
  v_left  NUMERIC := p_qty;
  v_take  NUMERIC;
  v_trade BIGINT;
  v_cash  NUMERIC;
  h RECORD;
BEGIN
  -- Lock the two orders in ascending id order. Any other ordering lets two
  -- concurrent trades touching the same pair deadlock each other.
  IF p_buy < p_sell THEN
    SELECT * INTO b FROM market_order WHERE order_id = p_buy  FOR UPDATE;
    SELECT * INTO s FROM market_order WHERE order_id = p_sell FOR UPDATE;
  ELSE
    SELECT * INTO s FROM market_order WHERE order_id = p_sell FOR UPDATE;
    SELECT * INTO b FROM market_order WHERE order_id = p_buy  FOR UPDATE;
  END IF;

  IF b.order_id IS NULL OR s.order_id IS NULL
     OR b.side <> 'BUY' OR s.side <> 'SELL'
     OR b.status NOT IN ('OPEN', 'PARTIAL')
     OR s.status NOT IN ('OPEN', 'PARTIAL')
     OR b.company_id = s.company_id
     OR b.price_per_credit < s.price_per_credit
     OR p_qty > b.quantity - b.filled_qty
     OR p_qty > s.quantity - s.filled_qty
     OR p_qty <= 0 THEN
    RAISE EXCEPTION 'Orders cannot be matched' USING ERRCODE = 'CX003';
  END IF;

  -- Price-time priority: the order that rested first sets the price.
  v_price := CASE WHEN b.created_at < s.created_at THEN b.price_per_credit
                  ELSE s.price_per_credit END;
  v_cost  := ROUND(p_qty * v_price, 2);

  -- Lock both wallets, again in a deterministic order.
  PERFORM 1 FROM credit_account
   WHERE company_id IN (b.company_id, s.company_id)
   ORDER BY company_id
   FOR UPDATE;

  SELECT cash_balance INTO v_cash FROM credit_account WHERE company_id = b.company_id;
  IF v_cash < v_cost THEN
    RAISE EXCEPTION 'Buyer has insufficient cash (% < %)', v_cash, v_cost
      USING ERRCODE = 'CX002';
  END IF;

  INSERT INTO trade(buy_order_id, sell_order_id, quantity, price)
  VALUES (p_buy, p_sell, p_qty, v_price)
  RETURNING trade_id INTO v_trade;

  -- Move credits oldest vintage first (FIFO): older credits expire sooner.
  -- Holdings are read *after* the locks, so a concurrent trade on the same
  -- sell order cannot make us double-spend.
  FOR h IN SELECT batch_id, qty FROM v_credit_holdings
            WHERE company_id = s.company_id
            ORDER BY vintage_year, batch_id
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(h.qty, v_left);
    INSERT INTO credit_ledger(company_id, batch_id, txn_type, quantity, ref_trade_id)
      VALUES (s.company_id, h.batch_id, 'TRADE_OUT', -v_take, v_trade);
    INSERT INTO credit_ledger(company_id, batch_id, txn_type, quantity, ref_trade_id)
      VALUES (b.company_id, h.batch_id, 'TRADE_IN',   v_take, v_trade);
    v_left := v_left - v_take;
  END LOOP;

  IF v_left > 0 THEN
    RAISE EXCEPTION 'Seller lacks tradable credits' USING ERRCODE = 'CX001';
  END IF;

  UPDATE credit_account SET cash_balance = cash_balance - v_cost, updated_at = now()
   WHERE company_id = b.company_id;
  UPDATE credit_account SET cash_balance = cash_balance + v_cost, updated_at = now()
   WHERE company_id = s.company_id;
  INSERT INTO payment(trade_id, payer_company_id, payee_company_id, amount)
  VALUES (v_trade, b.company_id, s.company_id, v_cost);

  UPDATE market_order
     SET filled_qty = filled_qty + p_qty,
         status = CASE WHEN filled_qty + p_qty >= quantity THEN 'FILLED' ELSE 'PARTIAL' END
   WHERE order_id IN (p_buy, p_sell);

  -- NOTIFY is transactional: if this transaction rolls back, nothing is sent.
  PERFORM pg_notify('trade_executed', json_build_object(
    'tradeId', v_trade,
    'quantity', p_qty,
    'price', v_price,
    'buyerCompanyId', b.company_id,
    'sellerCompanyId', s.company_id)::text);

  RETURN v_trade;
END $$;


-- 7.3 -------------------------------------------------------- matching engine
CREATE OR REPLACE FUNCTION fn_match_orders() RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  b_cur  RECORD;
  s_cur  RECORD;
  v_qty  NUMERIC;
  v_count INT := 0;
  v_guard INT;
BEGIN
  FOR b_cur IN
    SELECT * FROM market_order
     WHERE side = 'BUY' AND status IN ('OPEN', 'PARTIAL')
     ORDER BY price_per_credit DESC, created_at, order_id
  LOOP
    v_guard := 0;
    WHILE TRUE LOOP
      v_guard := v_guard + 1;
      IF v_guard > 500 THEN EXIT; END IF;              -- no infinite loop, ever
      EXIT WHEN b_cur.filled_qty >= b_cur.quantity;

      -- SKIP LOCKED: if another matcher is already filling this order, take the
      -- next best counterparty instead of blocking. Without this, two concurrent
      -- POST /orders requests can both fill the same order past its quantity.
      SELECT * INTO s_cur
        FROM market_order
       WHERE side = 'SELL'
         AND status IN ('OPEN', 'PARTIAL')
         AND price_per_credit <= b_cur.price_per_credit
         AND company_id <> b_cur.company_id
       ORDER BY price_per_credit, created_at, order_id
       LIMIT 1
       FOR UPDATE SKIP LOCKED;
      EXIT WHEN NOT FOUND;

      v_qty := LEAST(b_cur.quantity - b_cur.filled_qty, s_cur.quantity - s_cur.filled_qty);
      EXIT WHEN v_qty <= 0;

      -- Each attempt runs in its own sub-transaction. A counterparty who cannot
      -- trade (no credits / no cash / stale order) is skipped, not fatal.
      BEGIN
        PERFORM fn_execute_trade(b_cur.order_id, s_cur.order_id, v_qty);
        v_count := v_count + 1;
      EXCEPTION
        WHEN SQLSTATE 'CX001' OR SQLSTATE 'CX002' OR SQLSTATE 'CX003' THEN
          NULL;
      END;
    END LOOP;
  END LOOP;
  RETURN v_count;
END $$;


-- 7.4 --------------------------------------------------------- retire credits
-- Returns how much was *actually* retired, which may be less than requested.
CREATE OR REPLACE FUNCTION fn_retire_credits(p_company INT, p_qty NUMERIC, p_period INT)
RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE v_left NUMERIC := p_qty; v_take NUMERIC; h RECORD;
BEGIN
  PERFORM 1 FROM credit_account WHERE company_id = p_company FOR UPDATE;
  FOR h IN SELECT batch_id, qty FROM v_credit_holdings
            WHERE company_id = p_company
            ORDER BY vintage_year, batch_id
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(h.qty, v_left);
    INSERT INTO credit_ledger(company_id, batch_id, txn_type, quantity)
      VALUES (p_company, h.batch_id, 'RETIRE', -v_take);
    INSERT INTO credit_retirement(company_id, period_id, batch_id, quantity)
      VALUES (p_company, p_period, h.batch_id, v_take);
    v_left := v_left - v_take;
  END LOOP;
  RETURN p_qty - v_left;
END $$;


-- 7.5 ---------------------------------------------------- period close / run
-- Returns exactly one row per company that has a cap for the period, including
-- the compliant ones, so the admin results table needs a single query.
CREATE OR REPLACE FUNCTION fn_period_compliance(p_period INT, p_rate NUMERIC DEFAULT 3000)
RETURNS TABLE (
  company_id INT, company TEXT, cap_tonnes NUMERIC, emitted NUMERIC,
  excess NUMERIC, retired NUMERIC, fine NUMERIC, outcome TEXT)
LANGUAGE plpgsql AS $$
DECLARE rec RECORD; v_excess NUMERIC; v_ret NUMERIC; v_rest NUMERIC;
BEGIN
  IF (SELECT status FROM compliance_period WHERE period_id = p_period) <> 'OPEN' THEN
    RAISE EXCEPTION 'Period % is already closed', p_period USING ERRCODE = 'CX003';
  END IF;

  FOR rec IN
    SELECT c.company_id AS cid, c.name AS cname, ec.cap_tonnes AS cap,
           COALESCE(pt.tonnes, 0) AS emitted
      FROM emission_cap ec
      JOIN company c ON c.company_id = ec.company_id
      LEFT JOIN period_total pt
             ON pt.company_id = ec.company_id AND pt.period_id = ec.period_id
     WHERE ec.period_id = p_period
     ORDER BY c.company_id
  LOOP
    v_excess := GREATEST(rec.emitted - rec.cap, 0);
    v_ret := 0;
    v_rest := 0;

    IF v_excess > 0 THEN
      v_ret  := fn_retire_credits(rec.cid, v_excess, p_period);
      v_rest := v_excess - v_ret;
      IF v_rest > 0 THEN
        -- Re-running the compliance pass is idempotent.
        INSERT INTO penalty(company_id, period_id, excess_tonnes, rate_per_tonne, fine_amount)
        VALUES (rec.cid, p_period, v_rest, p_rate, ROUND(v_rest * p_rate, 2))
        ON CONFLICT (company_id, period_id) DO UPDATE
          SET excess_tonnes  = EXCLUDED.excess_tonnes,
              rate_per_tonne = EXCLUDED.rate_per_tonne,
              fine_amount    = EXCLUDED.fine_amount,
              issued_at      = now();
      END IF;
    END IF;

    company_id := rec.cid;
    company    := rec.cname;
    cap_tonnes := rec.cap;
    emitted    := rec.emitted;
    excess     := v_excess;
    retired    := v_ret;
    fine       := ROUND(v_rest * p_rate, 2);
    outcome    := CASE WHEN v_excess = 0 THEN 'COMPLIANT'
                       WHEN v_rest   = 0 THEN 'CREDITED'
                       ELSE 'PENALISED' END;
    RETURN NEXT;
  END LOOP;

  UPDATE compliance_period SET status = 'CLOSED' WHERE period_id = p_period;
END $$;


-- 7.6 --------------------------------------------------------- expire credits
CREATE OR REPLACE FUNCTION fn_expire_credits() RETURNS INT LANGUAGE plpgsql AS $$
DECLARE r RECORD; n INT := 0;
BEGIN
  FOR r IN
    SELECT l.company_id, l.batch_id, SUM(l.quantity) AS qty
    FROM credit_ledger l
    JOIN credit_batch b ON b.batch_id = l.batch_id
    WHERE b.status = 'ACTIVE'
      AND b.expiry_year IS NOT NULL
      AND b.expiry_year < EXTRACT(YEAR FROM CURRENT_DATE)::INT
    GROUP BY l.company_id, l.batch_id
    HAVING SUM(l.quantity) > 0
  LOOP
    INSERT INTO credit_ledger(company_id, batch_id, txn_type, quantity)
      VALUES (r.company_id, r.batch_id, 'EXPIRE', -r.qty);
    n := n + 1;
  END LOOP;

  UPDATE credit_batch SET status = 'EXPIRED'
   WHERE status = 'ACTIVE'
     AND expiry_year IS NOT NULL
     AND expiry_year < EXTRACT(YEAR FROM CURRENT_DATE)::INT;
  RETURN n;
END $$;


-- 7.7 ------------------------------------------------------- daily price OHLC
-- Always guarantees a row for the day, even with no trades, so the price chart
-- has no holes in it.
CREATE OR REPLACE FUNCTION fn_refresh_price_history(p_day DATE) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO price_history(price_date, open_price, high_price, low_price, close_price, volume)
  SELECT p_day,
         (ARRAY_AGG(price ORDER BY trade_ts))[1],
         MAX(price),
         MIN(price),
         (ARRAY_AGG(price ORDER BY trade_ts DESC))[1],
         COALESCE(SUM(quantity), 0)
    FROM trade
   WHERE trade_ts >= p_day AND trade_ts < p_day + 1
  ON CONFLICT (price_date) DO UPDATE
    SET open_price  = EXCLUDED.open_price,
        high_price  = EXCLUDED.high_price,
        low_price   = EXCLUDED.low_price,
        close_price = EXCLUDED.close_price,
        volume      = EXCLUDED.volume;

  INSERT INTO price_history(price_date, volume)
  SELECT p_day, 0
  WHERE NOT EXISTS (SELECT 1 FROM trade WHERE trade_ts >= p_day AND trade_ts < p_day + 1)
  ON CONFLICT (price_date) DO NOTHING;
END $$;


-- 7.8 ---------------------------------------------------- partition maintenance
-- Creates the next N yearly partitions and moves anything the DEFAULT partition
-- caught back into the correct year.
--
-- The move issues DELETE on emission_reading, which trg_reading_immutable blocks.
-- That is why the function sets app.maintenance: the trigger checks that flag
-- and stands down for maintenance only.
CREATE OR REPLACE FUNCTION fn_ensure_partitions(p_years INT DEFAULT 2)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  y INT; n INT := 0; moved BIGINT; total BIGINT := 0;
BEGIN
  PERFORM set_config('app.maintenance', 'on', true);

  FOR y IN
    SELECT generate_series(EXTRACT(YEAR FROM CURRENT_DATE)::INT,
                           EXTRACT(YEAR FROM CURRENT_DATE)::INT + p_years)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class
                    WHERE relname = format('emission_reading_%s', y)
                      AND relkind = 'r') THEN
      EXECUTE format(
        'CREATE TABLE emission_reading_%I PARTITION OF emission_reading
           FOR VALUES FROM (%L) TO (%L)',
        y, format('%s-01-01', y), format('%s-01-01', y + 1));
      n := n + 1;
    END IF;

    -- Re-home anything sitting in the DEFAULT partition for this year.
    EXECUTE format(
      'WITH moved AS (
         DELETE FROM emission_reading_default
          WHERE reading_ts >= %L AND reading_ts < %L
          RETURNING *
       )
       INSERT INTO emission_reading_%I SELECT * FROM moved',
      format('%s-01-01', y), format('%s-01-01', y + 1), y);
    GET DIAGNOSTICS moved = ROW_COUNT;
    total := total + COALESCE(moved, 0);
  END LOOP;

  RAISE NOTICE 'fn_ensure_partitions: % partition(s) created, % row(s) re-homed', n, total;
  RETURN n;
END $$;


-- 7.9 ------------------------------------------- rebuild the running totals
-- Use after a bulk load that ran with triggers disabled.
CREATE OR REPLACE FUNCTION fn_rebuild_period_totals() RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE n INT;
BEGIN
  TRUNCATE period_total;
  INSERT INTO period_total(company_id, period_id, tonnes)
  SELECT f.company_id, cp.period_id, SUM(r.co2_tonnes)
  FROM emission_reading r
  JOIN facility f ON f.facility_id = r.facility_id
  JOIN compliance_period cp
    ON r.reading_ts::date BETWEEN cp.start_date AND cp.end_date
  GROUP BY f.company_id, cp.period_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;


-- 7.10 --------------------------------------------- backfill price history
-- Used once after seeding, so the price chart has history immediately.
CREATE OR REPLACE FUNCTION fn_backfill_price_history(p_from DATE, p_to DATE)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE d DATE; n INT := 0;
BEGIN
  d := p_from;
  WHILE d <= p_to LOOP
    PERFORM fn_refresh_price_history(d);
    n := n + 1;
    d := d + 1;
  END LOOP;
  RETURN n;
END $$;
