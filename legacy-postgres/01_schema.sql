-- =============================================================================
-- CarbonX :: 01_schema.sql
-- Tables, partitions and constraints. Run this first.
--   psql -d carbon_exchange -f db/01_schema.sql
-- or, without psql installed:  npm run db:migrate
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- digest() for sensor key hashing

-- Drop in dependency-safe order so this file is re-runnable in development.
DROP TABLE IF EXISTS audit_log, penalty, payment, trade, market_order, price_history,
  credit_retirement, credit_ledger, credit_account, credit_batch, offset_project,
  project_type, registry, alert, verification, emission_report, emission_cap,
  emission_reading, emission_reading_default, period_total, compliance_period,
  emission_source, sensor, facility_fuel, facility, fuel_type, facility_type,
  app_user, verifier, company, sector, city, state, country CASCADE;
DROP VIEW IF EXISTS v_sector_rank, v_company_compliance_audit, v_company_compliance,
  v_order_book, v_facility_period_emission, v_credit_holdings CASCADE;
DROP MATERIALIZED VIEW IF EXISTS mv_monthly_emission CASCADE;


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
  latitude  NUMERIC(9,6) CHECK (latitude IS NULL OR latitude BETWEEN  -90 AND  90),
  longitude NUMERIC(9,6) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  UNIQUE (state_id, name)
);


-- ============ ORGANIZATION ============
CREATE TABLE sector (
  sector_id   SERIAL PRIMARY KEY,
  name        VARCHAR(60) UNIQUE NOT NULL,
  description TEXT
);

CREATE TABLE verifier (
  verifier_id      SERIAL PRIMARY KEY,
  name             VARCHAR(120) NOT NULL,
  accreditation_no VARCHAR(50) UNIQUE NOT NULL
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
  -- A COMPANY user must belong to a company; an AUDITOR must be accredited.
  -- (The original spec only enforced the first half.)
  CONSTRAINT user_org_matches_role CHECK (
    (role = 'COMPANY' AND company_id IS NOT NULL) OR
    (role = 'AUDITOR' AND verifier_id IS NOT NULL) OR
    (role = 'ADMIN'))
);


-- ============ FACILITIES ============
CREATE TABLE facility_type (
  facility_type_id SERIAL PRIMARY KEY,
  name VARCHAR(60) UNIQUE NOT NULL      -- Coal plant, Cement kiln, Steel mill...
);

CREATE TABLE fuel_type (
  fuel_id         SERIAL PRIMARY KEY,
  name            VARCHAR(40) UNIQUE NOT NULL,
  unit            VARCHAR(10) NOT NULL, -- tonne, m3, kL, MWh
  emission_factor NUMERIC(10,4) NOT NULL CHECK (emission_factor >= 0)  -- tCO2 per unit
);

CREATE TABLE facility (
  facility_id            SERIAL PRIMARY KEY,
  company_id             INT NOT NULL REFERENCES company(company_id),
  city_id                INT REFERENCES city(city_id),
  facility_type_id       INT REFERENCES facility_type(facility_type_id),
  name                   VARCHAR(120) NOT NULL,
  latitude               NUMERIC(9,6),
  longitude              NUMERIC(9,6),
  capacity_mw            NUMERIC(10,2) CHECK (capacity_mw >= 0),
  commissioned_year      INT CHECK (commissioned_year BETWEEN 1900 AND 2100),
  baseline_annual_tonnes NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (baseline_annual_tonnes >= 0),
  status                 VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','IDLE','CLOSED'))
);

CREATE TABLE facility_fuel (
  facility_id        INT NOT NULL REFERENCES facility(facility_id) ON DELETE CASCADE,
  fuel_id            INT NOT NULL REFERENCES fuel_type(fuel_id),
  annual_consumption NUMERIC(14,2) NOT NULL CHECK (annual_consumption >= 0),
  PRIMARY KEY (facility_id, fuel_id)
);

CREATE TABLE sensor (
  sensor_id    SERIAL PRIMARY KEY,
  facility_id  INT NOT NULL REFERENCES facility(facility_id) ON DELETE CASCADE,
  serial_no    VARCHAR(50) UNIQUE NOT NULL,
  sensor_type  VARCHAR(10) NOT NULL CHECK (sensor_type IN ('CO2','CH4','N2O','FLOW')),
  -- sha256 hex of a 32-byte random token, NOT a bcrypt digest: the ingest path
  -- has to match this row on every single request, and bcrypt is deliberately slow.
  api_key_hash TEXT NOT NULL,
  installed_on DATE NOT NULL DEFAULT CURRENT_DATE,
  status       VARCHAR(10) NOT NULL DEFAULT 'ONLINE' CHECK (status IN ('ONLINE','OFFLINE','FAULTY')),
  last_seen_at TIMESTAMPTZ
);


-- ============ MONITORING ============
CREATE TABLE emission_source (
  source_id SERIAL PRIMARY KEY,
  scope     SMALLINT NOT NULL CHECK (scope IN (1,2,3)),
  name      VARCHAR(60) NOT NULL     -- Stationary combustion, Process emissions...
);

CREATE TABLE compliance_period (
  period_id  SERIAL PRIMARY KEY,
  year       INT UNIQUE NOT NULL,
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  deadline   DATE NOT NULL,
  status     VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  CHECK (end_date > start_date)
);

-- Incrementally maintained running total of emissions per company per period.
-- Reading this is O(1); re-aggregating emission_reading is not. Rebuilt by
-- fn_rebuild_period_totals() and verified by v_company_compliance_audit.
CREATE TABLE period_total (
  company_id INT NOT NULL REFERENCES company(company_id),
  period_id  INT NOT NULL REFERENCES compliance_period(period_id),
  tonnes     NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (tonnes >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, period_id)
);

-- Large time-series table, range-partitioned by month-of-year.
-- Primary key must include the partition key.
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

-- A DEFAULT partition means a mis-dated reading lands somewhere instead of
-- raising "no partition of relation found" and killing the whole ingest batch.
CREATE TABLE emission_reading_default PARTITION OF emission_reading DEFAULT;

CREATE TABLE emission_reading_2024 PARTITION OF emission_reading FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE emission_reading_2025 PARTITION OF emission_reading FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE emission_reading_2026 PARTITION OF emission_reading FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE emission_reading_2027 PARTITION OF emission_reading FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');

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
  -- NOT NULL: every alert is period-scoped, and a nullable period_id would let
  -- the UNIQUE constraint below be bypassed (NULLs compare distinct).
  period_id  INT NOT NULL REFERENCES compliance_period(period_id),
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
  name        VARCHAR(80) UNIQUE NOT NULL      -- Verra, Gold Standard, India CCTS
);

CREATE TABLE project_type (
  project_type_id SERIAL PRIMARY KEY,
  name            VARCHAR(60) UNIQUE NOT NULL  -- Solar, Wind, Reforestation, Biogas
);

CREATE TABLE offset_project (
  project_id         SERIAL PRIMARY KEY,
  registry_id        INT REFERENCES registry(registry_id),
  project_type_id    INT REFERENCES project_type(project_type_id),
  owner_company_id   INT NOT NULL REFERENCES company(company_id),
  city_id            INT REFERENCES city(city_id),
  name               VARCHAR(120) NOT NULL,
  start_date         DATE,
  est_annual_credits NUMERIC(12,2) CHECK (est_annual_credits >= 0),
  status             VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PENDING','ACTIVE','CLOSED'))
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

-- credit_balance and cash_balance are deliberate denormalizations, kept correct
-- by trg_ledger_balance and by fn_execute_trade respectively.
CREATE TABLE credit_account (
  account_id     SERIAL PRIMARY KEY,
  company_id     INT UNIQUE NOT NULL REFERENCES company(company_id),
  credit_balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit_balance >= 0),
  cash_balance   NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (cash_balance >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only. Enforced by trg_ledger_immutable (BEFORE UPDATE OR DELETE).
CREATE TABLE credit_ledger (
  ledger_id    BIGSERIAL PRIMARY KEY,
  company_id   INT NOT NULL REFERENCES company(company_id),
  batch_id     INT NOT NULL REFERENCES credit_batch(batch_id),
  txn_type     VARCHAR(10) NOT NULL
               CHECK (txn_type IN ('ISSUE','TRADE_IN','TRADE_OUT','RETIRE','EXPIRE','ADJUST')),
  quantity     NUMERIC(14,2) NOT NULL CHECK (quantity <> 0),  -- signed
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
  order_id         BIGSERIAL PRIMARY KEY,
  company_id       INT NOT NULL REFERENCES company(company_id),
  side             VARCHAR(4) NOT NULL CHECK (side IN ('BUY','SELL')),
  quantity         NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  filled_qty       NUMERIC(14,2) NOT NULL DEFAULT 0,
  price_per_credit NUMERIC(12,2) NOT NULL CHECK (price_per_credit > 0),
  status           VARCHAR(10) NOT NULL DEFAULT 'OPEN'
                   CHECK (status IN ('OPEN','PARTIAL','FILLED','CANCELLED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
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
  price_date  DATE PRIMARY KEY,
  open_price  NUMERIC(12,2), high_price NUMERIC(12,2),
  low_price   NUMERIC(12,2), close_price NUMERIC(12,2),
  volume      NUMERIC(16,2) NOT NULL DEFAULT 0
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
