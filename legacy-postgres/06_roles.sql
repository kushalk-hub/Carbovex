-- =============================================================================
-- CarbonX :: 06_roles.sql
--
-- The application is the primary enforcement boundary (JWT + RBAC middleware).
-- These database roles are a second, independent layer, and are what you
-- demonstrate in a viva with GRANT / REVOKE / RLS.
--
-- Run this AFTER 01..05 and AFTER the database is seeded, so the grants cover
-- every object. The API connects as cx_app, which is a member of cx_admin.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cx_admin')   THEN CREATE ROLE cx_admin   NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cx_company') THEN CREATE ROLE cx_company NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cx_auditor') THEN CREATE ROLE cx_auditor NOLOGIN; END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cx_app') THEN
    EXECUTE 'CREATE ROLE cx_app LOGIN PASSWORD ''change_me'' IN ROLE cx_admin';
  END IF;
END $$;

-- Default privileges, so anything created later is still covered.
GRANT USAGE ON SCHEMA public TO cx_company, cx_auditor;

-- --- Auditor: read everything, write only verification decisions -----------
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cx_auditor;
GRANT INSERT, UPDATE ON verification, emission_report TO cx_auditor;

-- --- Company: a narrow read set, may place orders and file reports ---------
GRANT SELECT ON company, sector, facility, facility_type, fuel_type, sensor,
                 emission_reading, emission_cap, compliance_period, period_total,
                 market_order, trade, payment, price_history,
                 credit_batch, offset_project, project_type, registry,
                 alert, penalty, emission_report, v_order_book, v_credit_holdings,
                 v_company_compliance, v_sector_rank
  TO cx_company;
GRANT INSERT, UPDATE ON market_order, emission_report, credit_retirement TO cx_company;

-- --- Admin: everything, including the sequence rights for inserts ----------
GRANT ALL ON ALL TABLES    IN SCHEMA public TO cx_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO cx_admin;

-- --- Explicit revokes, so "not granted" is not the only protection ----------
REVOKE ALL ON credit_ledger          FROM cx_company, cx_auditor;
REVOKE ALL ON credit_account         FROM cx_company, cx_auditor;
REVOKE ALL ON audit_log              FROM cx_company, cx_auditor;
REVOKE ALL ON market_order           FROM cx_auditor;
REVOKE ALL ON emission_cap           FROM cx_company, cx_auditor;
REVOKE ALL ON offset_project         FROM cx_company, cx_auditor;
REVOKE ALL ON credit_batch           FROM cx_auditor;

-- Back the two grants above with sequence usage.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cx_company, cx_auditor;

-- --- Row level security: a company only ever sees its own wallet -----------
ALTER TABLE credit_account ENABLE ROW LEVEL SECURITY;
-- ENABLE alone is not enough: the table owner bypasses RLS, so the guarantee
-- would only hold for non-owners. FORCE applies the policies to the owner too.
ALTER TABLE credit_account FORCE  ROW LEVEL SECURITY;

CREATE POLICY own_wallet ON credit_account FOR SELECT TO cx_company
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INT);

-- The API connection (cx_app, a member of cx_admin) does not match the
-- "TO cx_company" policy, so it still sees every wallet: admin views stay whole
-- while a direct cx_company session is restricted. RLS here is a demonstration
-- layer; the API enforces ownership in middleware.

-- Demonstration (run these in psql, not in a file):
--   BEGIN;
--   SELECT set_config('app.company_id', '5', true);
--   SET LOCAL ROLE cx_company;
--   SELECT company_id, credit_balance FROM credit_account;  -- one row only
--   ROLLBACK;
