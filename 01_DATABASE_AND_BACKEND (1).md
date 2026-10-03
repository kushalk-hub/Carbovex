# Carbon Credit Exchange & Emission Monitoring System
## Part 1: Database and Backend Guide

**Stack:** PostgreSQL 15+ · Node.js 20 · Express · Socket.IO · JWT
**Scale:** 32 tables, 6 views, 8 functions/procedures, 6 triggers, partitioning, roles, real-time events

> This guide is the single source of truth for the API. The frontend guide (`02_FRONTEND_3D.md`) uses exactly these endpoints, field names (camelCase in JSON) and socket events.

---

## 1. System overview

```
 Sensors / Simulator ──► POST /api/readings ─┐
                                              ▼
 Browser (3D React app) ◄── REST + WebSocket ── Express API ◄──► PostgreSQL
                                              ▲                    │  triggers, functions
                                              └── LISTEN/NOTIFY ◄──┘  (alerts, trades)
```

**Business rules**
1. 1 credit = 1 tonne CO2.
2. Every company has an annual **cap** per compliance period.
3. Emissions come from sensor readings; an auditor **verifies** them.
4. Companies under their cap can **sell** surplus credits; companies over it must **buy**.
5. Credits come from **offset projects** (issued as batches with a vintage year) and expire after N years.
6. At period close, the system **retires** credits to cover excess emissions. Anything uncovered becomes a **penalty**.
7. Every credit movement is recorded in an append-only **ledger**. Balances are derived from it.

---

## 2. Folder structure

```
carbon-exchange/
├─ db/
│  ├─ 01_schema.sql          -- tables
│  ├─ 02_indexes.sql
│  ├─ 03_views.sql
│  ├─ 04_functions.sql       -- procedures
│  ├─ 05_triggers.sql
│  ├─ 06_roles.sql
│  ├─ 07_seed_reference.sql  -- countries, sectors, fuels, periods
│  └─ 08_seed_demo.sql       -- generated companies, readings, caps
├─ backend/
│  ├─ package.json
│  ├─ .env.example
│  ├─ src/
│  │  ├─ server.js
│  │  ├─ app.js
│  │  ├─ config/env.js
│  │  ├─ db/pool.js
│  │  ├─ middleware/ (auth.js, rbac.js, validate.js, errors.js)
│  │  ├─ modules/
│  │  │  ├─ auth/ companies/ facilities/ readings/ reports/
│  │  │  ├─ market/ wallet/ projects/ admin/
│  │  ├─ realtime/ (socket.js, pgListener.js)
│  │  └─ jobs/ (sensorSimulator.js, dailyPrice.js, expireCredits.js)
│  └─ tests/
└─ data/ (CCTS-745 CSV, other raw datasets)
```

---

## 3. Entity list and relationships

| Module | Tables |
|---|---|
| Location | `country`, `state`, `city` |
| Organization | `sector`, `company`, `app_user`, `verifier` |
| Facilities | `facility_type`, `fuel_type`, `facility`, `facility_fuel`, `sensor` |
| Monitoring | `emission_source`, `emission_reading` (partitioned), `compliance_period`, `emission_cap`, `emission_report`, `verification`, `alert` |
| Credits | `registry`, `project_type`, `offset_project`, `credit_batch`, `credit_account`, `credit_ledger`, `credit_retirement` |
| Market | `market_order`, `trade`, `payment`, `price_history` |
| Compliance and audit | `penalty`, `audit_log` |

**Cardinalities**
- country 1:N state 1:N city 1:N facility
- sector 1:N company 1:N facility 1:N sensor 1:N emission_reading
- facility M:N fuel_type (via `facility_fuel`)
- company 1:N emission_cap (one per period), 1:1 credit_account
- offset_project 1:N credit_batch 1:N credit_ledger
- market_order 1:N trade (partial fills), trade 1:1 payment
- emission_report 1:1 verification

---

## 4. Schema (`db/01_schema.sql`)

```sql
-- ============ LOCATION ============
CREATE TABLE country (
  country_id SERIAL PRIMARY KEY,
  name       VARCHAR(80) UNIQUE NOT NULL,
  iso_code   CHAR(2) UNIQUE NOT NULL
);
CREATE TABLE state (
  state_id   SERIAL PRIMARY KEY,
  country_id INT NOT NULL REFERENCES country(country_id),
  name       VARCHAR(80) NOT NULL,
  UNIQUE (country_id, name)
);
CREATE TABLE city (
  city_id   SERIAL PRIMARY KEY,
  state_id  INT NOT NULL REFERENCES state(state_id),
  name      VARCHAR(80) NOT NULL,
  latitude  NUMERIC(9,6),
  longitude NUMERIC(9,6),
  UNIQUE (state_id, name)
);

-- ============ ORGANIZATION ============
CREATE TABLE sector (
  sector_id   SERIAL PRIMARY KEY,
  name        VARCHAR(60) UNIQUE NOT NULL,
  description TEXT
);
CREATE TABLE company (
  company_id SERIAL PRIMARY KEY,
  name       VARCHAR(120) NOT NULL,
  sector_id  INT REFERENCES sector(sector_id),
  reg_number VARCHAR(50) UNIQUE,
  email      VARCHAR(120) UNIQUE,
  phone      VARCHAR(20),
  address    TEXT,
  status     VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE verifier (
  verifier_id  SERIAL PRIMARY KEY,
  name         VARCHAR(120) NOT NULL,
  accreditation_no VARCHAR(50) UNIQUE NOT NULL
);
CREATE TABLE app_user (
  user_id       SERIAL PRIMARY KEY,
  company_id    INT REFERENCES company(company_id),
  verifier_id   INT REFERENCES verifier(verifier_id),
  full_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(120) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          VARCHAR(10) NOT NULL CHECK (role IN ('ADMIN','COMPANY','AUDITOR')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (role <> 'COMPANY' OR company_id IS NOT NULL)
);

-- ============ FACILITIES ============
CREATE TABLE facility_type (
  facility_type_id SERIAL PRIMARY KEY,
  name VARCHAR(60) UNIQUE NOT NULL            -- Coal plant, Cement kiln, Steel mill...
);
CREATE TABLE fuel_type (
  fuel_id         SERIAL PRIMARY KEY,
  name            VARCHAR(40) UNIQUE NOT NULL,
  unit            VARCHAR(10) NOT NULL,        -- tonne, m3, kL, MWh
  emission_factor NUMERIC(10,4) NOT NULL CHECK (emission_factor >= 0)  -- tCO2 per unit
);
CREATE TABLE facility (
  facility_id      SERIAL PRIMARY KEY,
  company_id       INT NOT NULL REFERENCES company(company_id),
  city_id          INT REFERENCES city(city_id),
  facility_type_id INT REFERENCES facility_type(facility_type_id),
  name             VARCHAR(120) NOT NULL,
  latitude         NUMERIC(9,6),
  longitude        NUMERIC(9,6),
  capacity_mw      NUMERIC(10,2),
  commissioned_year INT CHECK (commissioned_year BETWEEN 1900 AND 2100),
  baseline_annual_tonnes NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (baseline_annual_tonnes >= 0),
  status           VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','IDLE','CLOSED'))
);
CREATE TABLE facility_fuel (
  facility_id INT NOT NULL REFERENCES facility(facility_id) ON DELETE CASCADE,
  fuel_id     INT NOT NULL REFERENCES fuel_type(fuel_id),
  annual_consumption NUMERIC(14,2) NOT NULL CHECK (annual_consumption >= 0),
  PRIMARY KEY (facility_id, fuel_id)
);
CREATE TABLE sensor (
  sensor_id    SERIAL PRIMARY KEY,
  facility_id  INT NOT NULL REFERENCES facility(facility_id) ON DELETE CASCADE,
  serial_no    VARCHAR(50) UNIQUE NOT NULL,
  sensor_type  VARCHAR(10) NOT NULL CHECK (sensor_type IN ('CO2','CH4','N2O','FLOW')),
  api_key_hash TEXT NOT NULL,
  installed_on DATE NOT NULL DEFAULT CURRENT_DATE,
  status       VARCHAR(10) NOT NULL DEFAULT 'ONLINE' CHECK (status IN ('ONLINE','OFFLINE','FAULTY'))
);

-- ============ MONITORING ============
CREATE TABLE emission_source (
  source_id SERIAL PRIMARY KEY,
  scope     SMALLINT NOT NULL CHECK (scope IN (1,2,3)),
  name      VARCHAR(60) NOT NULL                -- Stationary combustion, Purchased electricity...
);

CREATE TABLE emission_reading (
  reading_id  BIGSERIAL,
  facility_id INT NOT NULL REFERENCES facility(facility_id),
  sensor_id   INT REFERENCES sensor(sensor_id),
  source_id   INT REFERENCES emission_source(source_id),
  reading_ts  TIMESTAMPTZ NOT NULL,
  co2_tonnes  NUMERIC(12,3) NOT NULL CHECK (co2_tonnes >= 0),
  verified    BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (reading_id, reading_ts)
) PARTITION BY RANGE (reading_ts);

CREATE TABLE emission_reading_2024 PARTITION OF emission_reading FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE emission_reading_2025 PARTITION OF emission_reading FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE emission_reading_2026 PARTITION OF emission_reading FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE emission_reading_2027 PARTITION OF emission_reading FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');

CREATE TABLE compliance_period (
  period_id  SERIAL PRIMARY KEY,
  year       INT UNIQUE NOT NULL,
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  deadline   DATE NOT NULL,
  status     VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  CHECK (end_date > start_date)
);
CREATE TABLE emission_cap (
  cap_id     SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES company(company_id),
  period_id  INT NOT NULL REFERENCES compliance_period(period_id),
  cap_tonnes NUMERIC(14,2) NOT NULL CHECK (cap_tonnes > 0),
  UNIQUE (company_id, period_id)
);
CREATE TABLE emission_report (
  report_id    SERIAL PRIMARY KEY,
  company_id   INT NOT NULL REFERENCES company(company_id),
  period_id    INT NOT NULL REFERENCES compliance_period(period_id),
  total_tonnes NUMERIC(14,2) NOT NULL CHECK (total_tonnes >= 0),
  status       VARCHAR(10) NOT NULL DEFAULT 'DRAFT'
               CHECK (status IN ('DRAFT','SUBMITTED','VERIFIED','REJECTED')),
  submitted_at TIMESTAMPTZ,
  UNIQUE (company_id, period_id)
);
CREATE TABLE verification (
  verification_id SERIAL PRIMARY KEY,
  report_id   INT UNIQUE NOT NULL REFERENCES emission_report(report_id),
  verifier_id INT NOT NULL REFERENCES verifier(verifier_id),
  decision    VARCHAR(10) NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  remarks     TEXT,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE alert (
  alert_id   SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES company(company_id),
  period_id  INT REFERENCES compliance_period(period_id),
  alert_type VARCHAR(20) NOT NULL
             CHECK (alert_type IN ('CAP_90','CAP_EXCEEDED','SENSOR_OFFLINE','LOW_BALANCE')),
  message    TEXT NOT NULL,
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, period_id, alert_type)
);

-- ============ CREDITS ============
CREATE TABLE registry (
  registry_id SERIAL PRIMARY KEY,
  name        VARCHAR(80) UNIQUE NOT NULL         -- Verra, Gold Standard, India CCTS
);
CREATE TABLE project_type (
  project_type_id SERIAL PRIMARY KEY,
  name            VARCHAR(60) UNIQUE NOT NULL     -- Solar, Wind, Reforestation, Biogas
);
CREATE TABLE offset_project (
  project_id      SERIAL PRIMARY KEY,
  registry_id     INT REFERENCES registry(registry_id),
  project_type_id INT REFERENCES project_type(project_type_id),
  owner_company_id INT NOT NULL REFERENCES company(company_id),
  city_id         INT REFERENCES city(city_id),
  name            VARCHAR(120) NOT NULL,
  start_date      DATE,
  est_annual_credits NUMERIC(12,2) CHECK (est_annual_credits >= 0),
  status          VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PENDING','ACTIVE','CLOSED'))
);
CREATE TABLE credit_batch (
  batch_id     SERIAL PRIMARY KEY,
  project_id   INT NOT NULL REFERENCES offset_project(project_id),
  vintage_year INT NOT NULL,
  quantity     NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  serial_start BIGINT,
  serial_end   BIGINT,
  expiry_year  INT,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXPIRED','SUSPENDED')),
  CHECK (expiry_year IS NULL OR expiry_year >= vintage_year)
);
CREATE TABLE credit_account (
  account_id     SERIAL PRIMARY KEY,
  company_id     INT UNIQUE NOT NULL REFERENCES company(company_id),
  credit_balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit_balance >= 0),
  cash_balance   NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (cash_balance >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE credit_ledger (
  ledger_id    BIGSERIAL PRIMARY KEY,
  company_id   INT NOT NULL REFERENCES company(company_id),
  batch_id     INT NOT NULL REFERENCES credit_batch(batch_id),
  txn_type     VARCHAR(10) NOT NULL
               CHECK (txn_type IN ('ISSUE','TRADE_IN','TRADE_OUT','RETIRE','EXPIRE','ADJUST')),
  quantity     NUMERIC(14,2) NOT NULL CHECK (quantity <> 0),   -- signed
  ref_trade_id BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE credit_retirement (
  retirement_id SERIAL PRIMARY KEY,
  company_id    INT NOT NULL REFERENCES company(company_id),
  period_id     INT REFERENCES compliance_period(period_id),
  batch_id      INT NOT NULL REFERENCES credit_batch(batch_id),
  quantity      NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  retired_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ MARKET ============
CREATE TABLE market_order (
  order_id    BIGSERIAL PRIMARY KEY,
  company_id  INT NOT NULL REFERENCES company(company_id),
  side        VARCHAR(4) NOT NULL CHECK (side IN ('BUY','SELL')),
  quantity    NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  filled_qty  NUMERIC(14,2) NOT NULL DEFAULT 0,
  price_per_credit NUMERIC(12,2) NOT NULL CHECK (price_per_credit > 0),
  status      VARCHAR(10) NOT NULL DEFAULT 'OPEN'
              CHECK (status IN ('OPEN','PARTIAL','FILLED','CANCELLED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (filled_qty >= 0 AND filled_qty <= quantity)
);
CREATE TABLE trade (
  trade_id      BIGSERIAL PRIMARY KEY,
  buy_order_id  BIGINT NOT NULL REFERENCES market_order(order_id),
  sell_order_id BIGINT NOT NULL REFERENCES market_order(order_id),
  quantity      NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  price         NUMERIC(12,2) NOT NULL CHECK (price > 0),
  trade_ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (buy_order_id <> sell_order_id)
);
CREATE TABLE payment (
  payment_id       BIGSERIAL PRIMARY KEY,
  trade_id         BIGINT UNIQUE NOT NULL REFERENCES trade(trade_id),
  payer_company_id INT NOT NULL REFERENCES company(company_id),
  payee_company_id INT NOT NULL REFERENCES company(company_id),
  amount           NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  method           VARCHAR(10) NOT NULL DEFAULT 'WALLET',
  status           VARCHAR(10) NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID','FAILED')),
  paid_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE price_history (
  price_date DATE PRIMARY KEY,
  open_price NUMERIC(12,2), high_price NUMERIC(12,2),
  low_price  NUMERIC(12,2), close_price NUMERIC(12,2),
  volume     NUMERIC(16,2) NOT NULL DEFAULT 0
);

-- ============ COMPLIANCE & AUDIT ============
CREATE TABLE penalty (
  penalty_id     SERIAL PRIMARY KEY,
  company_id     INT NOT NULL REFERENCES company(company_id),
  period_id      INT NOT NULL REFERENCES compliance_period(period_id),
  excess_tonnes  NUMERIC(14,2) NOT NULL CHECK (excess_tonnes > 0),
  rate_per_tonne NUMERIC(12,2) NOT NULL,
  fine_amount    NUMERIC(16,2) NOT NULL,
  status         VARCHAR(10) NOT NULL DEFAULT 'UNPAID' CHECK (status IN ('UNPAID','PAID','WAIVED')),
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, period_id)
);
CREATE TABLE audit_log (
  audit_id   BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  operation  VARCHAR(6) NOT NULL,
  row_pk     TEXT,
  old_data   JSONB,
  new_data   JSONB,
  changed_by INT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Normalization notes (for your viva)
- **1NF:** every column is atomic; no repeating groups (fuels are in `facility_fuel`, not a list column).
- **2NF:** in composite-key tables (`facility_fuel`) every non-key attribute depends on the whole key.
- **3NF:** location is split into country/state/city; sector, fuel, and facility type are lookup tables, so there are no transitive dependencies.
- **Deliberate denormalization:** `credit_account.credit_balance` duplicates the sum of the ledger for speed. It is kept correct by a trigger, so it can never drift.

---

## 5. Indexes (`db/02_indexes.sql`)

```sql
CREATE INDEX idx_facility_company     ON facility (company_id);
CREATE INDEX idx_facility_city        ON facility (city_id);
CREATE INDEX idx_reading_fac_ts       ON emission_reading (facility_id, reading_ts DESC);
CREATE INDEX idx_reading_ts_brin      ON emission_reading USING BRIN (reading_ts);
CREATE INDEX idx_ledger_company_batch ON credit_ledger (company_id, batch_id);
CREATE INDEX idx_order_book           ON market_order (side, status, price_per_credit, created_at);
CREATE INDEX idx_order_company        ON market_order (company_id, status);
CREATE INDEX idx_trade_ts             ON trade (trade_ts DESC);
CREATE INDEX idx_alert_company_unread ON alert (company_id) WHERE is_read = FALSE;  -- partial index
CREATE INDEX idx_audit_table_time     ON audit_log (table_name, changed_at DESC);
```

Demonstrate their value in your report:
```sql
EXPLAIN ANALYZE SELECT SUM(co2_tonnes) FROM emission_reading
WHERE facility_id = 42 AND reading_ts >= '2026-01-01';
```
Take a screenshot with and without the index. Partition pruning also shows up in the plan.

---

## 6. Views (`db/03_views.sql`)

```sql
-- Credits held per company per batch (excludes expired batches)
CREATE VIEW v_credit_holdings AS
SELECT l.company_id, l.batch_id, b.vintage_year, SUM(l.quantity) AS qty
FROM credit_ledger l
JOIN credit_batch b ON b.batch_id = l.batch_id
WHERE b.status = 'ACTIVE'
  AND (b.expiry_year IS NULL OR b.expiry_year >= EXTRACT(YEAR FROM CURRENT_DATE))
GROUP BY l.company_id, l.batch_id, b.vintage_year
HAVING SUM(l.quantity) > 0;

-- Emissions per facility per period
CREATE VIEW v_facility_period_emission AS
SELECT f.facility_id, cp.period_id, cp.year, COALESCE(SUM(r.co2_tonnes),0) AS emitted
FROM facility f
CROSS JOIN compliance_period cp
LEFT JOIN emission_reading r
  ON r.facility_id = f.facility_id
 AND r.reading_ts >= cp.start_date AND r.reading_ts < cp.end_date + 1
GROUP BY f.facility_id, cp.period_id, cp.year;

-- Company emissions vs cap
CREATE VIEW v_company_compliance AS
SELECT c.company_id, c.name, cp.period_id, cp.year, ec.cap_tonnes,
       COALESCE(SUM(r.co2_tonnes),0)                              AS emitted,
       ec.cap_tonnes - COALESCE(SUM(r.co2_tonnes),0)              AS headroom,
       ROUND(100*COALESCE(SUM(r.co2_tonnes),0)/ec.cap_tonnes, 1)  AS pct_used
FROM emission_cap ec
JOIN company c            ON c.company_id = ec.company_id
JOIN compliance_period cp ON cp.period_id = ec.period_id
LEFT JOIN facility f      ON f.company_id = c.company_id
LEFT JOIN emission_reading r
  ON r.facility_id = f.facility_id
 AND r.reading_ts >= cp.start_date AND r.reading_ts < cp.end_date + 1
GROUP BY c.company_id, c.name, cp.period_id, cp.year, ec.cap_tonnes;

-- Open order book, price-time priority
CREATE VIEW v_order_book AS
SELECT order_id, company_id, side, price_per_credit,
       quantity - filled_qty AS remaining, created_at
FROM market_order
WHERE status IN ('OPEN','PARTIAL')
ORDER BY CASE WHEN side='BUY' THEN -price_per_credit ELSE price_per_credit END, created_at;

-- Sector leaderboard (window function)
CREATE VIEW v_sector_rank AS
SELECT s.name AS sector, c.company_id, c.name AS company, v.year, v.emitted,
       RANK() OVER (PARTITION BY s.sector_id, v.year ORDER BY v.emitted DESC) AS rank_in_sector
FROM v_company_compliance v
JOIN company c ON c.company_id = v.company_id
JOIN sector s  ON s.sector_id = c.sector_id;

-- Materialized: monthly emissions per facility (refresh nightly)
CREATE MATERIALIZED VIEW mv_monthly_emission AS
SELECT facility_id, date_trunc('month', reading_ts) AS month, SUM(co2_tonnes) AS tonnes
FROM emission_reading GROUP BY 1,2;
CREATE UNIQUE INDEX ON mv_monthly_emission (facility_id, month);
```

---

## 7. Functions and procedures (`db/04_functions.sql`)

### 7.1 Issue a credit batch
```sql
CREATE OR REPLACE FUNCTION fn_issue_batch(p_project INT, p_vintage INT, p_qty NUMERIC, p_expiry INT DEFAULT NULL)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE v_owner INT; v_batch INT;
BEGIN
  SELECT owner_company_id INTO v_owner FROM offset_project WHERE project_id = p_project;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Unknown project' USING ERRCODE='CX003'; END IF;
  INSERT INTO credit_batch(project_id, vintage_year, quantity, expiry_year)
  VALUES (p_project, p_vintage, p_qty, COALESCE(p_expiry, p_vintage + 5))
  RETURNING batch_id INTO v_batch;
  INSERT INTO credit_ledger(company_id, batch_id, txn_type, quantity)
  VALUES (v_owner, v_batch, 'ISSUE', p_qty);
  RETURN v_batch;
END $$;
```

### 7.2 Execute one trade (the core ACID transaction)
```sql
CREATE OR REPLACE FUNCTION fn_execute_trade(p_buy BIGINT, p_sell BIGINT, p_qty NUMERIC)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  b market_order%ROWTYPE;  s market_order%ROWTYPE;
  v_price NUMERIC(12,2);   v_cost NUMERIC(16,2);
  v_left NUMERIC := p_qty; v_take NUMERIC;
  h RECORD;  v_trade BIGINT;  v_cash NUMERIC;
BEGIN
  -- lock orders in a fixed order to avoid deadlocks
  IF p_buy < p_sell THEN
    SELECT * INTO b FROM market_order WHERE order_id = p_buy  FOR UPDATE;
    SELECT * INTO s FROM market_order WHERE order_id = p_sell FOR UPDATE;
  ELSE
    SELECT * INTO s FROM market_order WHERE order_id = p_sell FOR UPDATE;
    SELECT * INTO b FROM market_order WHERE order_id = p_buy  FOR UPDATE;
  END IF;

  IF b.order_id IS NULL OR s.order_id IS NULL OR b.side <> 'BUY' OR s.side <> 'SELL'
     OR b.status NOT IN ('OPEN','PARTIAL') OR s.status NOT IN ('OPEN','PARTIAL')
     OR b.company_id = s.company_id OR b.price_per_credit < s.price_per_credit
     OR p_qty > b.quantity - b.filled_qty OR p_qty > s.quantity - s.filled_qty OR p_qty <= 0 THEN
    RAISE EXCEPTION 'Orders cannot be matched' USING ERRCODE='CX003';
  END IF;

  -- resting (older) order sets the price
  v_price := CASE WHEN b.created_at < s.created_at THEN b.price_per_credit ELSE s.price_per_credit END;
  v_cost  := ROUND(p_qty * v_price, 2);

  -- lock both wallets (fixed order again)
  PERFORM 1 FROM credit_account
   WHERE company_id IN (b.company_id, s.company_id) ORDER BY company_id FOR UPDATE;

  SELECT cash_balance INTO v_cash FROM credit_account WHERE company_id = b.company_id;
  IF v_cash < v_cost THEN
    RAISE EXCEPTION 'Buyer has insufficient cash (% < %)', v_cash, v_cost USING ERRCODE='CX002';
  END IF;

  INSERT INTO trade(buy_order_id, sell_order_id, quantity, price)
  VALUES (p_buy, p_sell, p_qty, v_price) RETURNING trade_id INTO v_trade;

  -- move credits oldest vintage first (FIFO); ledger trigger updates balances
  FOR h IN SELECT batch_id, qty FROM v_credit_holdings
            WHERE company_id = s.company_id ORDER BY vintage_year, batch_id LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(h.qty, v_left);
    INSERT INTO credit_ledger(company_id,batch_id,txn_type,quantity,ref_trade_id)
      VALUES (s.company_id, h.batch_id, 'TRADE_OUT', -v_take, v_trade);
    INSERT INTO credit_ledger(company_id,batch_id,txn_type,quantity,ref_trade_id)
      VALUES (b.company_id, h.batch_id, 'TRADE_IN',   v_take, v_trade);
    v_left := v_left - v_take;
  END LOOP;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'Seller lacks tradable credits' USING ERRCODE='CX001';
  END IF;

  UPDATE credit_account SET cash_balance = cash_balance - v_cost, updated_at = now() WHERE company_id = b.company_id;
  UPDATE credit_account SET cash_balance = cash_balance + v_cost, updated_at = now() WHERE company_id = s.company_id;
  INSERT INTO payment(trade_id, payer_company_id, payee_company_id, amount)
  VALUES (v_trade, b.company_id, s.company_id, v_cost);

  UPDATE market_order SET filled_qty = filled_qty + p_qty,
         status = CASE WHEN filled_qty + p_qty >= quantity THEN 'FILLED' ELSE 'PARTIAL' END
   WHERE order_id IN (p_buy, p_sell);

  PERFORM pg_notify('trade_executed', json_build_object(
    'tradeId', v_trade, 'quantity', p_qty, 'price', v_price,
    'buyerCompanyId', b.company_id, 'sellerCompanyId', s.company_id)::text);
  RETURN v_trade;
END $$;
```

If any statement fails, PostgreSQL rolls back the entire function. That gives you **atomicity**: the seller is debited and the buyer credited, or nothing happens.

### 7.3 Matching engine
```sql
CREATE OR REPLACE FUNCTION fn_match_orders() RETURNS INT LANGUAGE plpgsql AS $$
DECLARE b RECORD; s RECORD; v_qty NUMERIC; v_count INT := 0;
BEGIN
  FOR b IN SELECT * FROM market_order WHERE side='BUY' AND status IN ('OPEN','PARTIAL')
           ORDER BY price_per_credit DESC, created_at LOOP
    LOOP
      SELECT * INTO b FROM market_order WHERE order_id = b.order_id;       -- refresh
      EXIT WHEN b.status NOT IN ('OPEN','PARTIAL');
      SELECT * INTO s FROM market_order
       WHERE side='SELL' AND status IN ('OPEN','PARTIAL')
         AND price_per_credit <= b.price_per_credit AND company_id <> b.company_id
       ORDER BY price_per_credit, created_at LIMIT 1;
      EXIT WHEN NOT FOUND;
      v_qty := LEAST(b.quantity - b.filled_qty, s.quantity - s.filled_qty);
      BEGIN
        PERFORM fn_execute_trade(b.order_id, s.order_id, v_qty);
        v_count := v_count + 1;
      EXCEPTION WHEN SQLSTATE 'CX001' OR SQLSTATE 'CX002' THEN
        EXIT;     -- skip this buyer; the failed trade was rolled back by the sub-transaction
      END;
    END LOOP;
  END LOOP;
  RETURN v_count;
END $$;
```

### 7.4 Retire credits
```sql
CREATE OR REPLACE FUNCTION fn_retire_credits(p_company INT, p_qty NUMERIC, p_period INT)
RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE v_left NUMERIC := p_qty; v_take NUMERIC; h RECORD;
BEGIN
  PERFORM 1 FROM credit_account WHERE company_id = p_company FOR UPDATE;
  FOR h IN SELECT batch_id, qty FROM v_credit_holdings
            WHERE company_id = p_company ORDER BY vintage_year, batch_id LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(h.qty, v_left);
    INSERT INTO credit_ledger(company_id,batch_id,txn_type,quantity) VALUES (p_company,h.batch_id,'RETIRE',-v_take);
    INSERT INTO credit_retirement(company_id,period_id,batch_id,quantity) VALUES (p_company,p_period,h.batch_id,v_take);
    v_left := v_left - v_take;
  END LOOP;
  RETURN p_qty - v_left;     -- how much was actually retired
END $$;
```

### 7.5 Period-end compliance run
```sql
CREATE OR REPLACE FUNCTION fn_period_compliance(p_period INT, p_rate NUMERIC DEFAULT 3000)
RETURNS TABLE (company_id INT, excess NUMERIC, retired NUMERIC, fined NUMERIC)
LANGUAGE plpgsql AS $$
DECLARE rec RECORD; v_excess NUMERIC; v_ret NUMERIC; v_rest NUMERIC;
BEGIN
  IF (SELECT status FROM compliance_period WHERE period_id = p_period) <> 'OPEN' THEN
    RAISE EXCEPTION 'Period already closed' USING ERRCODE='CX003';
  END IF;

  FOR rec IN
    SELECT v.company_id AS cid, v.cap_tonnes, v.emitted
    FROM v_company_compliance v WHERE v.period_id = p_period
  LOOP
    v_excess := rec.emitted - rec.cap_tonnes;
    IF v_excess > 0 THEN
      v_ret  := fn_retire_credits(rec.cid, v_excess, p_period);
      v_rest := v_excess - v_ret;
      IF v_rest > 0 THEN
        INSERT INTO penalty(company_id, period_id, excess_tonnes, rate_per_tonne, fine_amount)
        VALUES (rec.cid, p_period, v_rest, p_rate, ROUND(v_rest * p_rate, 2));
      END IF;
      company_id := rec.cid; excess := v_excess; retired := v_ret; fined := v_rest * p_rate;
      RETURN NEXT;
    END IF;
  END LOOP;

  UPDATE compliance_period SET status = 'CLOSED' WHERE period_id = p_period;
END $$;
```

### 7.6 Expire old credits
```sql
CREATE OR REPLACE FUNCTION fn_expire_credits() RETURNS INT LANGUAGE plpgsql AS $$
DECLARE r RECORD; n INT := 0;
BEGIN
  FOR r IN
    SELECT l.company_id, l.batch_id, SUM(l.quantity) AS qty
    FROM credit_ledger l JOIN credit_batch b ON b.batch_id = l.batch_id
    WHERE b.expiry_year < EXTRACT(YEAR FROM CURRENT_DATE)
    GROUP BY l.company_id, l.batch_id HAVING SUM(l.quantity) > 0
  LOOP
    INSERT INTO credit_ledger(company_id,batch_id,txn_type,quantity) VALUES (r.company_id,r.batch_id,'EXPIRE',-r.qty);
    n := n + 1;
  END LOOP;
  UPDATE credit_batch SET status='EXPIRED' WHERE expiry_year < EXTRACT(YEAR FROM CURRENT_DATE);
  RETURN n;
END $$;
```

### 7.7 Daily price rollup
```sql
CREATE OR REPLACE FUNCTION fn_refresh_price_history(p_day DATE) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO price_history(price_date, open_price, high_price, low_price, close_price, volume)
  SELECT p_day,
         (ARRAY_AGG(price ORDER BY trade_ts))[1],
         MAX(price), MIN(price),
         (ARRAY_AGG(price ORDER BY trade_ts DESC))[1],
         SUM(quantity)
  FROM trade WHERE trade_ts >= p_day AND trade_ts < p_day + 1
  HAVING COUNT(*) > 0
  ON CONFLICT (price_date) DO UPDATE SET
    open_price=EXCLUDED.open_price, high_price=EXCLUDED.high_price,
    low_price=EXCLUDED.low_price, close_price=EXCLUDED.close_price, volume=EXCLUDED.volume;
$$;
```

---

## 8. Triggers (`db/05_triggers.sql`)

```sql
-- 8.1 every company gets a wallet automatically
CREATE OR REPLACE FUNCTION trg_company_wallet() RETURNS trigger AS $$
BEGIN INSERT INTO credit_account(company_id) VALUES (NEW.company_id); RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER company_wallet AFTER INSERT ON company
FOR EACH ROW EXECUTE FUNCTION trg_company_wallet();

-- 8.2 ledger keeps wallet balance in sync
CREATE OR REPLACE FUNCTION trg_ledger_balance() RETURNS trigger AS $$
BEGIN
  UPDATE credit_account SET credit_balance = credit_balance + NEW.quantity, updated_at = now()
  WHERE company_id = NEW.company_id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_balance AFTER INSERT ON credit_ledger
FOR EACH ROW EXECUTE FUNCTION trg_ledger_balance();

-- 8.3 ledger is append-only
CREATE OR REPLACE FUNCTION trg_ledger_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'credit_ledger is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON credit_ledger
FOR EACH ROW EXECUTE FUNCTION trg_ledger_immutable();

-- 8.4 block SELL orders larger than available credits
CREATE OR REPLACE FUNCTION trg_order_validate() RETURNS trigger AS $$
DECLARE v_bal NUMERIC; v_committed NUMERIC;
BEGIN
  IF NEW.side = 'SELL' THEN
    SELECT credit_balance INTO v_bal FROM credit_account WHERE company_id = NEW.company_id;
    SELECT COALESCE(SUM(quantity - filled_qty),0) INTO v_committed FROM market_order
     WHERE company_id = NEW.company_id AND side='SELL' AND status IN ('OPEN','PARTIAL');
    IF COALESCE(v_bal,0) - v_committed < NEW.quantity THEN
      RAISE EXCEPTION 'Insufficient credits: available %, requested %',
        COALESCE(v_bal,0) - v_committed, NEW.quantity USING ERRCODE='CX001';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER order_validate BEFORE INSERT ON market_order
FOR EACH ROW EXECUTE FUNCTION trg_order_validate();

-- 8.5 cap alerts at 90% and 100% (also pushes a real-time notification)
CREATE OR REPLACE FUNCTION trg_reading_alert() RETURNS trigger AS $$
DECLARE v_company INT; v_p RECORD; v_cap NUMERIC; v_total NUMERIC; v_pct NUMERIC;
        v_type TEXT; v_rows INT;
BEGIN
  SELECT company_id INTO v_company FROM facility WHERE facility_id = NEW.facility_id;
  SELECT period_id, start_date, end_date INTO v_p FROM compliance_period
   WHERE NEW.reading_ts::date BETWEEN start_date AND end_date;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT cap_tonnes INTO v_cap FROM emission_cap WHERE company_id = v_company AND period_id = v_p.period_id;
  IF v_cap IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(SUM(r.co2_tonnes),0) INTO v_total
  FROM emission_reading r JOIN facility f ON f.facility_id = r.facility_id
  WHERE f.company_id = v_company
    AND r.reading_ts >= v_p.start_date AND r.reading_ts < v_p.end_date + 1;

  v_pct  := 100 * v_total / v_cap;
  v_type := CASE WHEN v_pct >= 100 THEN 'CAP_EXCEEDED' WHEN v_pct >= 90 THEN 'CAP_90' END;
  IF v_type IS NOT NULL THEN
    INSERT INTO alert(company_id, period_id, alert_type, message)
    VALUES (v_company, v_p.period_id, v_type, format('Emissions at %s%% of cap', ROUND(v_pct,1)))
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      PERFORM pg_notify('new_alert', json_build_object(
        'companyId', v_company, 'type', v_type, 'pct', ROUND(v_pct,1))::text);
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER reading_alert AFTER INSERT ON emission_reading
FOR EACH ROW EXECUTE FUNCTION trg_reading_alert();

-- 8.6 generic audit trigger
CREATE OR REPLACE FUNCTION trg_audit() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log(table_name, operation, row_pk, old_data, new_data, changed_by)
  VALUES (TG_TABLE_NAME, TG_OP,
          to_jsonb(COALESCE(NEW, OLD)) ->> TG_ARGV[0],
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
          NULLIF(current_setting('app.user_id', true), '')::INT);
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER aud_cap     AFTER INSERT OR UPDATE OR DELETE ON emission_cap    FOR EACH ROW EXECUTE FUNCTION trg_audit('cap_id');
CREATE TRIGGER aud_penalty AFTER INSERT OR UPDATE OR DELETE ON penalty         FOR EACH ROW EXECUTE FUNCTION trg_audit('penalty_id');
CREATE TRIGGER aud_report  AFTER INSERT OR UPDATE OR DELETE ON emission_report FOR EACH ROW EXECUTE FUNCTION trg_audit('report_id');
CREATE TRIGGER aud_order   AFTER INSERT OR UPDATE OR DELETE ON market_order    FOR EACH ROW EXECUTE FUNCTION trg_audit('order_id');
CREATE TRIGGER aud_account AFTER UPDATE ON credit_account                      FOR EACH ROW EXECUTE FUNCTION trg_audit('account_id');
```

> **Performance note:** the alert trigger re-aggregates on every reading, which is fine for a demo. During bulk loads run `ALTER TABLE emission_reading DISABLE TRIGGER USER;` and re-enable afterwards. In production you would move this to a scheduled job.

---

## 9. Roles and security (`db/06_roles.sql`)

```sql
CREATE ROLE cx_admin   NOLOGIN;
CREATE ROLE cx_company NOLOGIN;
CREATE ROLE cx_auditor NOLOGIN;
CREATE ROLE cx_app LOGIN PASSWORD 'change_me' IN ROLE cx_admin;   -- the Node.js API connects as this

-- Auditor: read-only everywhere, can write verification
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cx_auditor;
GRANT INSERT, UPDATE ON verification, emission_report TO cx_auditor;

-- Company: limited
GRANT SELECT ON company, facility, v_order_book, trade, price_history, credit_batch TO cx_company;
GRANT INSERT, UPDATE ON market_order, emission_report TO cx_company;

-- Admin: everything
GRANT ALL ON ALL TABLES IN SCHEMA public TO cx_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO cx_admin;

-- Optional row-level security: a company only sees its own wallet
ALTER TABLE credit_account ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_wallet ON credit_account FOR SELECT TO cx_company
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INT);
```

For the project, enforce roles in the API with JWT and RBAC middleware (section 12). Also keep these SQL roles to demonstrate `GRANT` / `REVOKE` / RLS in the viva.

---

## 10. Data and seeding

### 10.1 Reference data (`07_seed_reference.sql`)
```sql
INSERT INTO country(name, iso_code) VALUES ('India','IN');
INSERT INTO sector(name) VALUES ('Power'),('Cement'),('Steel'),('Aluminium'),
  ('Fertiliser'),('Petrochemicals'),('Pulp & Paper'),('Textile'),('Chlor-Alkali'),('Refinery');
INSERT INTO fuel_type(name, unit, emission_factor) VALUES
  ('Coal','tonne',2.42),('Natural gas','m3',0.00202),('Diesel','kL',2.68),('Fuel oil','kL',3.15);
INSERT INTO emission_source(scope, name) VALUES
  (1,'Stationary combustion'),(1,'Process emissions'),(2,'Purchased electricity'),(3,'Transport');
INSERT INTO registry(name) VALUES ('Verra'),('Gold Standard'),('India CCTS');
INSERT INTO project_type(name) VALUES ('Solar'),('Wind'),('Reforestation'),('Biogas'),('Cookstoves');
INSERT INTO compliance_period(year, start_date, end_date, deadline) VALUES
  (2024,'2024-01-01','2024-12-31','2025-03-31'),
  (2025,'2025-01-01','2025-12-31','2026-03-31'),
  (2026,'2026-01-01','2026-12-31','2027-03-31');
```

Fuel emission factors above are illustrative. Check the official IPCC or CEA factors if you want the numbers to be defensible.

### 10.2 Real data: CCTS-745 (India)
CCTS-745 is a facility-level dataset of India's obligated industrial facilities, published on Zenodo (search "CCTS-745 Zenodo"). It provides sector, location, baseline production, emission intensity, target intensity and derived baseline emissions.

Import with a staging table so you can adapt to its actual column names:
```sql
CREATE TABLE stg_ccts (LIKE facility INCLUDING DEFAULTS);   -- or define columns matching the CSV header
-- \copy stg_ccts_raw FROM 'data/ccts745.csv' CSV HEADER   (use psql's \copy)
-- Then:  INSERT INTO company(name, sector_id)    SELECT DISTINCT ... FROM staging
--        INSERT INTO facility(company_id, ...)   SELECT ... FROM staging JOIN company ...
```
Mapping to aim for:

| CCTS-745 field | Your column |
|---|---|
| Entity / company | `company.name` |
| Sector | `sector.name` (lookup or insert) |
| Facility / location | `facility.name`, `city.name` |
| Baseline GHG emissions | `facility.baseline_annual_tonnes` |

If a facility has no coordinates, geocode its city once and store it in `city.latitude/longitude`. The 3D globe needs them.

### 10.3 Generated data (`08_seed_demo.sql`)
Real data covers companies and facilities. Everything else is generated in pure SQL.

```sql
ALTER TABLE emission_reading DISABLE TRIGGER USER;

-- Daily readings for 2024-01-01 → 2026-09-30, ±15% around baseline
INSERT INTO emission_reading(facility_id, source_id, reading_ts, co2_tonnes, verified)
SELECT f.facility_id, 1, d,
       ROUND((f.baseline_annual_tonnes / 365.0 * (0.85 + random()*0.30))::numeric, 3),
       d < now() - interval '30 days'
FROM facility f
CROSS JOIN generate_series('2024-01-01'::timestamptz, '2026-09-30'::timestamptz, interval '1 day') d;

ALTER TABLE emission_reading ENABLE TRIGGER USER;

-- Caps: 90%–105% of the company's baseline, so some companies end up over and some under
INSERT INTO emission_cap(company_id, period_id, cap_tonnes)
SELECT f.company_id, cp.period_id, ROUND(SUM(f.baseline_annual_tonnes) * (0.90 + random()*0.15), 2)
FROM facility f CROSS JOIN compliance_period cp
GROUP BY f.company_id, cp.period_id;

-- Cash for everyone (₹5 crore)
UPDATE credit_account SET cash_balance = 50000000;
```

Then in Node or SQL: create ~15 offset projects, call `fn_issue_batch` for each, and transfer some starting credits to the larger companies. Finally run a seed script that places random BUY/SELL orders. Use under-cap companies as sellers and over-cap companies as buyers, with prices between ₹800 and ₹2,500, and call `fn_match_orders()` so you have trade history.

**Target sizes:** about 745 facilities and 400+ companies if you use all of CCTS-745, roughly 800k readings, and 500+ trades. That is plenty to show off indexing, partitioning, and `EXPLAIN`.

---

## 11. Showcase queries

```sql
-- 1. Companies that exceeded their cap
SELECT name, year, emitted, cap_tonnes, pct_used
FROM v_company_compliance WHERE emitted > cap_tonnes ORDER BY pct_used DESC;

-- 2. Top 5 traders by volume (₹)
SELECT c.name, SUM(t.quantity*t.price) AS turnover
FROM trade t
JOIN market_order mo ON mo.order_id IN (t.buy_order_id, t.sell_order_id)
JOIN company c ON c.company_id = mo.company_id
GROUP BY c.name ORDER BY turnover DESC LIMIT 5;

-- 3. 30-day moving average price (window function)
SELECT price_date, close_price,
       AVG(close_price) OVER (ORDER BY price_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS ma30
FROM price_history;

-- 4. Hierarchy: all facilities under a country (recursive-style roll-up)
SELECT co.name AS country, st.name AS state, ci.name AS city, COUNT(f.facility_id) AS facilities
FROM facility f JOIN city ci USING(city_id) JOIN state st USING(state_id) JOIN country co USING(country_id)
GROUP BY ROLLUP (co.name, st.name, ci.name);

-- 5. Highest emitter per sector (rank view)
SELECT * FROM v_sector_rank WHERE rank_in_sector = 1;

-- 6. Companies with no sensors online (anti-join)
SELECT c.name FROM company c
WHERE NOT EXISTS (
  SELECT 1 FROM facility f JOIN sensor s ON s.facility_id = f.facility_id
  WHERE f.company_id = c.company_id AND s.status = 'ONLINE');

-- 7. Net credit position: surplus (sellers) vs deficit (buyers)
SELECT v.name, a.credit_balance, GREATEST(v.emitted - v.cap_tonnes, 0) AS needs
FROM v_company_compliance v JOIN credit_account a USING(company_id) WHERE v.year = 2026;

-- 8. Average traded price by month
SELECT date_trunc('month', trade_ts) m, ROUND(AVG(price),2) avg_price, SUM(quantity) volume
FROM trade GROUP BY 1 ORDER BY 1;
```

---

## 12. Backend (Node.js + Express)

### 12.1 Setup
```bash
mkdir backend && cd backend
npm init -y
npm i express pg zod jsonwebtoken bcrypt cors helmet express-rate-limit socket.io node-cron pino dotenv
npm i -D nodemon jest supertest
```
`package.json`: set `"type": "module"` and scripts `"dev": "nodemon src/server.js"`.

`.env.example`
```
PORT=4000
DATABASE_URL=postgres://cx_app:change_me@localhost:5432/carbon_exchange
JWT_SECRET=use-a-long-random-string
JWT_EXPIRES=8h
CORS_ORIGIN=http://localhost:5173
```

### 12.2 `src/db/pool.js`
```js
import pg from 'pg';
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
export const query = (text, params) => pool.query(text, params);

// Runs fn inside a transaction; tags the session so audit triggers know who acted
export async function withTx(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (userId) await client.query("SELECT set_config('app.user_id', $1, true)", [String(userId)]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

### 12.3 `src/middleware/`
```js
// auth.js
import jwt from 'jsonwebtoken';
export function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: p.sub, role: p.role, companyId: p.companyId };
    next();
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
}

// rbac.js
export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' });

// validate.js
export const validate = (schema) => (req, res, next) => {
  const r = schema.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: 'Invalid input', details: r.error.flatten() });
  req.body = r.data; next();
};

// errors.js: turn our custom SQLSTATE codes (CX***) into clean 400 responses
export function errorHandler(err, req, res, next) {
  if (err.code?.startsWith('CX')) return res.status(400).json({ error: err.message, code: err.code });
  if (err.code === '23505') return res.status(409).json({ error: 'Already exists' });
  if (err.code === '23514' || err.code === '23503') return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
```

### 12.4 Auth route
```js
// modules/auth/routes.js
import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { validate } from '../../middleware/validate.js';
const r = Router();

r.post('/login', validate(z.object({ email: z.string().email(), password: z.string().min(6) })),
  async (req, res, next) => {
    try {
      const { rows: [u] } = await query('SELECT * FROM app_user WHERE email=$1 AND is_active', [req.body.email]);
      if (!u || !(await bcrypt.compare(req.body.password, u.password_hash)))
        return res.status(401).json({ error: 'Invalid credentials' });
      const token = jwt.sign({ sub: u.user_id, role: u.role, companyId: u.company_id },
        process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES });
      res.json({ token, user: { id: u.user_id, name: u.full_name, role: u.role, companyId: u.company_id } });
    } catch (e) { next(e); }
  });
export default r;
```
Create the first admin and a few demo users with a one-off script that hashes `bcrypt.hash('demo123', 10)`.

### 12.5 Market route (place and cancel orders)
```js
// modules/market/routes.js
import { Router } from 'express';
import { z } from 'zod';
import { withTx, query } from '../../db/pool.js';
import { auth } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
const r = Router();

const orderSchema = z.object({
  side: z.enum(['BUY', 'SELL']),
  quantity: z.number().positive().max(1e7),
  price: z.number().positive().max(1e6),
});

r.post('/orders', auth, requireRole('COMPANY'), validate(orderSchema), async (req, res, next) => {
  try {
    const { side, quantity, price } = req.body;
    const out = await withTx(req.user.id, async (db) => {
      const { rows: [o] } = await db.query(
        `INSERT INTO market_order(company_id, side, quantity, price_per_credit)
         VALUES ($1,$2,$3,$4) RETURNING order_id`, [req.user.companyId, side, quantity, price]);
      const { rows: [m] } = await db.query('SELECT fn_match_orders() AS trades');
      const { rows: [fresh] } = await db.query(
        `SELECT order_id AS "orderId", side, quantity, filled_qty AS "filledQty",
                price_per_credit AS price, status FROM market_order WHERE order_id=$1`, [o.order_id]);
      return { order: fresh, tradesExecuted: m.trades };
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

r.delete('/orders/:id', auth, requireRole('COMPANY'), async (req, res, next) => {
  try {
    const { rowCount } = await query(
      `UPDATE market_order SET status='CANCELLED'
       WHERE order_id=$1 AND company_id=$2 AND status IN ('OPEN','PARTIAL')`,
      [req.params.id, req.user.companyId]);
    rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Order not found or not cancellable' });
  } catch (e) { next(e); }
});

// Aggregated depth for the 3D order book
r.get('/market/depth', auth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT side, price_per_credit AS price, SUM(quantity - filled_qty) AS qty
       FROM market_order WHERE status IN ('OPEN','PARTIAL')
       GROUP BY side, price_per_credit ORDER BY price_per_credit`);
    const bids = rows.filter(x => x.side === 'BUY').reverse();   // best bid first
    const asks = rows.filter(x => x.side === 'SELL');            // best ask first
    const cum = (arr) => { let c = 0; return arr.map(x => ({ price: +x.price, qty: +x.qty, cumulative: (c += +x.qty) })); };
    res.json({ bids: cum(bids), asks: cum(asks) });
  } catch (e) { next(e); }
});

r.get('/market/trades', auth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT trade_id AS "tradeId", quantity, price, trade_ts AS "ts"
       FROM trade ORDER BY trade_ts DESC LIMIT 50`);
    res.json(rows);
  } catch (e) { next(e); }
});

r.get('/market/prices', auth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT price_date AS date, open_price AS open, high_price AS high,
              low_price AS low, close_price AS close, volume
       FROM price_history ORDER BY price_date DESC LIMIT 180`);
    res.json(rows.reverse());
  } catch (e) { next(e); }
});
export default r;
```

### 12.6 Facilities route (feeds the 3D globe)
```js
r.get('/facilities', auth, async (req, res, next) => {
  try {
    const year = +req.query.year || new Date().getFullYear();
    const { rows } = await query(
      `SELECT f.facility_id AS "id", f.name,
              COALESCE(f.latitude, ci.latitude)   AS "latitude",
              COALESCE(f.longitude, ci.longitude) AS "longitude",
              c.company_id AS "companyId", c.name AS "company", s.name AS "sector",
              fe.emitted::float AS "emitted",
              vc.pct_used::float AS "pctUsed"
       FROM facility f
       JOIN company c ON c.company_id = f.company_id
       LEFT JOIN sector s ON s.sector_id = c.sector_id
       LEFT JOIN city ci ON ci.city_id = f.city_id
       LEFT JOIN v_facility_period_emission fe ON fe.facility_id = f.facility_id AND fe.year = $1
       LEFT JOIN v_company_compliance vc ON vc.company_id = c.company_id AND vc.year = $1
       WHERE COALESCE(f.latitude, ci.latitude) IS NOT NULL`, [year]);
    res.json(rows);
  } catch (e) { next(e); }
});

// time series for one facility (day / week / month buckets)
r.get('/facilities/:id/readings', auth, async (req, res, next) => {
  try {
    const bucket = ['day', 'week', 'month'].includes(req.query.bucket) ? req.query.bucket : 'day';
    const { rows } = await query(
      `SELECT date_trunc('${bucket}', reading_ts) AS "t", SUM(co2_tonnes)::float AS "tonnes"
       FROM emission_reading
       WHERE facility_id = $1 AND reading_ts >= COALESCE($2::timestamptz, now() - interval '90 days')
       GROUP BY 1 ORDER BY 1`, [req.params.id, req.query.from || null]);
    res.json(rows);
  } catch (e) { next(e); }
});
```
The `bucket` value is whitelisted before it goes into the SQL string. Everything else uses parameters, which prevents SQL injection.

### 12.7 Readings ingest (sensor to API)
```js
// POST /api/readings   headers: x-sensor-id, x-sensor-key
// body: { readings: [{ ts: "2026-10-01T10:00:00Z", co2: 12.4 }, ...] }
r.post('/readings', async (req, res, next) => {
  try {
    const { rows: [s] } = await query('SELECT * FROM sensor WHERE sensor_id=$1', [req.headers['x-sensor-id']]);
    if (!s || !(await bcrypt.compare(req.headers['x-sensor-key'] || '', s.api_key_hash)))
      return res.status(401).json({ error: 'Bad sensor credentials' });

    const ts  = req.body.readings.map(x => x.ts);
    const co2 = req.body.readings.map(x => x.co2);
    await query(
      `INSERT INTO emission_reading(facility_id, sensor_id, source_id, reading_ts, co2_tonnes)
       SELECT $1, $2, 1, t, c FROM unnest($3::timestamptz[], $4::numeric[]) AS x(t, c)`,
      [s.facility_id, s.sensor_id, ts, co2]);

    req.app.get('io').emit('reading:new', {
      facilityId: s.facility_id, co2: co2.at(-1), ts: ts.at(-1) });
    res.status(201).json({ inserted: ts.length });
  } catch (e) { next(e); }
});
```

### 12.8 Wallet, reports and admin (endpoint summary)
Same pattern as above: one SQL query per route, wrapped in `auth` and `requireRole`. Key queries:

```sql
-- GET /api/wallet
SELECT credit_balance AS "creditBalance", cash_balance AS "cashBalance"
FROM credit_account WHERE company_id = $1;

-- GET /api/wallet/holdings  (3D coin stacks)
SELECT h.batch_id AS "batchId", h.vintage_year AS "vintage", h.qty::float AS "qty",
       p.name AS "project", pt.name AS "projectType"
FROM v_credit_holdings h
JOIN credit_batch b ON b.batch_id = h.batch_id
JOIN offset_project p ON p.project_id = b.project_id
JOIN project_type pt ON pt.project_type_id = p.project_type_id
WHERE h.company_id = $1 ORDER BY h.vintage_year;

-- POST /api/wallet/retire   body { quantity }
SELECT fn_retire_credits($1, $2, (SELECT period_id FROM compliance_period WHERE status='OPEN' ORDER BY year LIMIT 1));

-- POST /api/admin/compliance/:periodId/run   (ADMIN)
SELECT * FROM fn_period_compliance($1, $2);
```

### 12.9 Real-time layer
```js
// realtime/socket.js
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
export function initSocket(httpServer, app) {
  const io = new Server(httpServer, { cors: { origin: process.env.CORS_ORIGIN } });
  io.use((socket, next) => {
    try {
      const p = jwt.verify(socket.handshake.auth.token, process.env.JWT_SECRET);
      socket.data.user = p; next();
    } catch { next(new Error('unauthorized')); }
  });
  io.on('connection', (socket) => {
    if (socket.data.user.companyId) socket.join(`company:${socket.data.user.companyId}`);
  });
  app.set('io', io);
  return io;
}

// realtime/pgListener.js: converts PostgreSQL NOTIFY into socket events
import pg from 'pg';
import { query } from '../db/pool.js';

const anchor = async (companyId) => {
  const { rows: [r] } = await query(
    `SELECT c.name AS company, COALESCE(f.latitude, ci.latitude) AS lat, COALESCE(f.longitude, ci.longitude) AS lng
     FROM facility f JOIN company c ON c.company_id = f.company_id LEFT JOIN city ci ON ci.city_id = f.city_id
     WHERE f.company_id = $1 AND COALESCE(f.latitude, ci.latitude) IS NOT NULL
     ORDER BY f.baseline_annual_tonnes DESC LIMIT 1`, [companyId]);
  return r && { company: r.company, lat: +r.lat, lng: +r.lng };
};

export async function startPgListener(io) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('LISTEN trade_executed');
  await client.query('LISTEN new_alert');

  client.on('notification', async (msg) => {
    const p = JSON.parse(msg.payload);
    if (msg.channel === 'trade_executed') {
      const [from, to] = await Promise.all([anchor(p.sellerCompanyId), anchor(p.buyerCompanyId)]);
      io.emit('trade:executed', { tradeId: p.tradeId, quantity: p.quantity, price: p.price, from, to });
      io.emit('price:tick', { price: p.price, ts: Date.now() });
    } else if (msg.channel === 'new_alert') {
      io.to(`company:${p.companyId}`).emit('alert:new', p);
      io.emit('alert:global', { companyId: p.companyId, type: p.type });  // lets the globe pulse red
    }
  });
}
```

**Socket events (backend → frontend)**

| Event | Payload |
|---|---|
| `reading:new` | `{ facilityId, co2, ts }` |
| `trade:executed` | `{ tradeId, quantity, price, from:{company,lat,lng}, to:{company,lat,lng} }` |
| `price:tick` | `{ price, ts }` |
| `alert:new` | `{ companyId, type, pct }`, only to that company's room |
| `alert:global` | `{ companyId, type }`, broadcast so the globe can show warnings |

### 12.10 `app.js` and `server.js`
```js
// app.js
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { errorHandler } from './middleware/errors.js';
import authRoutes from './modules/auth/routes.js';
import marketRoutes from './modules/market/routes.js';
// ...import the other route modules

const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', rateLimit({ windowMs: 15*60*1000, max: 50 }), authRoutes);
app.use('/api', marketRoutes);
// app.use('/api', facilityRoutes, walletRoutes, readingRoutes, adminRoutes ...)
app.get('/api/health', (_, res) => res.json({ ok: true }));
app.use(errorHandler);
export default app;

// server.js
import 'dotenv/config';
import http from 'http';
import app from './app.js';
import { initSocket } from './realtime/socket.js';
import { startPgListener } from './realtime/pgListener.js';
import './jobs/dailyPrice.js';

const server = http.createServer(app);
const io = initSocket(server, app);
await startPgListener(io);
server.listen(process.env.PORT, () => console.log(`API on :${process.env.PORT}`));
```

### 12.11 Background jobs
```js
// jobs/dailyPrice.js
import cron from 'node-cron';
import { query } from '../db/pool.js';
cron.schedule('5 0 * * *', async () => {
  await query('SELECT fn_refresh_price_history(CURRENT_DATE - 1)');
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_emission');
});
cron.schedule('0 1 1 1 *', () => query('SELECT fn_expire_credits()'));   // every 1 January

// jobs/sensorSimulator.js: run with `node src/jobs/sensorSimulator.js` during the demo
import { query } from '../db/pool.js';
setInterval(async () => {
  const { rows } = await query(
    `SELECT s.sensor_id, s.facility_id, f.baseline_annual_tonnes / 8760.0 AS hourly
     FROM sensor s JOIN facility f USING (facility_id) WHERE s.status = 'ONLINE' ORDER BY random() LIMIT 5`);
  for (const r of rows) {
    const co2 = +(r.hourly * (0.8 + Math.random() * 0.5) * 24).toFixed(3);   // sped-up: 1 tick ≈ 1 day
    await query(`INSERT INTO emission_reading(facility_id, sensor_id, source_id, reading_ts, co2_tonnes)
                 VALUES ($1,$2,1,now(),$3)`, [r.facility_id, r.sensor_id, co2]);
  }
}, 3000);
```
This is how your frontend's live smoke and globe effects get real data during the presentation.

---

## 13. API reference

| Method | Endpoint | Role | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | public | Returns `{ token, user }` |
| GET | `/api/auth/me` | any | Current user |
| GET | `/api/stats/overview` | any | Global KPIs: total emissions, credits in circulation, 24h volume, last price |
| GET | `/api/facilities?year=` | any | Globe data (lat/lng, emitted, pctUsed) |
| GET | `/api/facilities/:id` | any | Detail, fuels, sensors |
| GET | `/api/facilities/:id/readings?bucket=&from=` | any | Time series |
| GET | `/api/companies/:id/compliance` | company/admin | Cap vs emitted per period |
| POST | `/api/readings` | sensor key | Bulk ingest |
| POST | `/api/reports` | company | Submit period report |
| PATCH | `/api/reports/:id/verify` | auditor | Approve or reject |
| PUT | `/api/caps` | admin | Set caps |
| GET / POST | `/api/projects` | any / admin | Offset projects |
| POST | `/api/projects/:id/batches` | admin | Issue credits (`fn_issue_batch`) |
| GET | `/api/wallet` | company | Balances |
| GET | `/api/wallet/holdings` | company | Credits by batch |
| GET | `/api/wallet/ledger` | company | Credit history |
| POST | `/api/wallet/retire` | company | Voluntary retirement |
| GET | `/api/market/depth` | any | Aggregated order book |
| GET | `/api/market/trades` | any | Latest 50 trades |
| GET | `/api/market/prices` | any | Daily OHLC |
| POST | `/api/orders` | company | Place order (auto-matches) |
| GET | `/api/orders/mine` | company | Own orders |
| DELETE | `/api/orders/:id` | company | Cancel |
| GET | `/api/alerts` | company | Alerts |
| PATCH | `/api/alerts/:id/read` | company | Mark read |
| GET | `/api/penalties` | company/admin | Fines |
| POST | `/api/admin/compliance/:periodId/run` | admin | Close period |
| GET | `/api/audit-log` | admin/auditor | Audit trail |

**Example responses**
```jsonc
// GET /api/facilities
[{ "id": 17, "name": "Mundra Unit 2", "latitude": 22.84, "longitude": 69.72,
   "companyId": 5, "company": "Adani Power", "sector": "Power", "emitted": 1823400.5, "pctUsed": 97.3 }]

// GET /api/market/depth
{ "bids": [{ "price": 1450, "qty": 300, "cumulative": 300 }],
  "asks": [{ "price": 1480, "qty": 250, "cumulative": 250 }] }

// POST /api/orders (201)
{ "order": { "orderId": 903, "side": "BUY", "quantity": 100, "filledQty": 100, "price": 1500, "status": "FILLED" },
  "tradesExecuted": 1 }

// Error
{ "error": "Insufficient credits: available 40.00, requested 100", "code": "CX001" }
```

**Custom error codes:** `CX001` insufficient credits · `CX002` insufficient cash · `CX003` invalid operation.

---

## 14. Testing

1. **Constraints:** inserting a negative reading, a duplicate cap, or a SELL order above the balance must fail.
2. **Atomicity:** force an error mid-trade (for example, drop the buyer's cash). Verify no ledger rows, no payment and no order change remain.
3. **Concurrency:** fire two simultaneous trades against the same sell order using two `psql` sessions or `Promise.all`. The row locks should serialize them and one should fail cleanly.
4. **Compliance run:** seed a company 500 t over its cap with 300 credits, run `fn_period_compliance`, and expect 300 retired plus a 200 t penalty.
5. **API tests:** `supertest` for login, place order, cancel order, and RBAC (a COMPANY user calling an admin route must get 403).
6. **Ledger integrity check (great demo query):**
```sql
SELECT a.company_id FROM credit_account a
LEFT JOIN (SELECT company_id, SUM(quantity) q FROM credit_ledger GROUP BY 1) l USING (company_id)
WHERE a.credit_balance <> COALESCE(l.q, 0);   -- must return 0 rows
```

---

## 15. Security checklist
- Parameterized queries only, with whitelists for anything interpolated (like `bucket`).
- Passwords and sensor keys are hashed with bcrypt, and JWTs expire.
- `helmet`, a locked-down CORS origin and rate limiting on auth routes.
- A least-privilege DB user in production (not a superuser).
- Never return `password_hash` or `api_key_hash`.
- Audit trail on caps, penalties, reports, orders and wallets.

---

## 16. Build order (suggested 3 weeks)

| Week | Tasks |
|---|---|
| 1 | ER diagram → `01_schema.sql` → indexes → reference seed → import CCTS-745 → demo data |
| 2 | Views, functions, triggers, roles → test everything in plain SQL first |
| 3 | Express API, auth, market and wallet routes, sockets, simulator → connect the frontend |

---

## 17. Viva questions to prepare

1. Why is `credit_account.credit_balance` stored if it can be derived? *(Read performance; kept consistent by a trigger.)*
2. How do you prevent double-spending credits? *(Row locks, CHECK >= 0, ledger, atomic function.)*
3. Why FIFO by vintage? *(Older credits expire first and carry less value.)*
4. What ACID property does `fn_execute_trade` demonstrate? *(Atomicity, plus isolation through `FOR UPDATE`.)*
5. Why partition `emission_reading`? *(Large time-series table, partition pruning, easy archival.)*
6. Why lock rows in a fixed order? *(Prevents deadlocks.)*
7. What normal form is the schema in and why? *(3NF, with one documented denormalization.)*
8. Difference between a view and a materialized view, and where you used each?
9. How does the real-time feature work? *(Trigger → `pg_notify` → Node `LISTEN` → Socket.IO.)*
10. How do you stop an auditor from editing orders? *(GRANTs, RBAC middleware, optional RLS.)*
