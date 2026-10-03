-- =============================================================================
-- CarbonX :: 08_seed_demo.sql
--
-- Companies, facilities, sensors, ~2.75 years of daily readings, caps and cash.
--
-- CCTS-745 (India's facility-level obligated dataset, published on Zenodo) is
-- the intended real source. Load it into stg_ccts_raw first (block at the top)
-- and this script will use those companies and facilities. If stg_ccts_raw is
-- empty it generates a realistic synthetic dataset instead, so the project runs
-- with no download.
--
--   Target: ~400 companies, ~745 facilities, ~745k readings.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Optional: real CCTS-745 staging table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stg_ccts_raw (
  entity VARCHAR(200), sector VARCHAR(80), facility VARCHAR(200),
  state VARCHAR(80), city VARCHAR(80), lat NUMERIC(9,6), lng NUMERIC(9,6),
  baseline_ghg NUMERIC(16,2)
);
-- Load the CSV without psql:  node scripts/importCcts.js data/ccts745.csv
--
-- INSERT INTO company(name, sector_id, reg_number, email)
-- SELECT DISTINCT r.entity,
--        (SELECT sector_id FROM sector WHERE name = r.sector),
--        'CCTS-' || lpad((row_number() OVER ())::TEXT, 6, '0'),
--        lower(regexp_replace(r.entity, '\W+', '', 'g')) || '@ccts.demo'
--   FROM stg_ccts_raw r
--  WHERE r.entity IS NOT NULL AND r.entity <> ''
-- ON CONFLICT (reg_number) DO NOTHING;
--
-- INSERT INTO facility(company_id, city_id, facility_type_id, name,
--                      latitude, longitude, commissioned_year, baseline_annual_tonnes)
-- SELECT c.company_id, ci.city_id, NULL,
--        COALESCE(NULLIF(r.facility, ''), r.entity || ' unit'),
--        r.lat, r.lng, 2000, COALESCE(r.baseline_ghg, 0)
--   FROM stg_ccts_raw r
--   JOIN company c ON c.name = r.entity
--   LEFT JOIN city ci ON ci.name = r.city
--  WHERE r.entity IS NOT NULL
-- ON CONFLICT DO NOTHING;

-- =============================================================================
-- 1. Companies — synthetic fallback, skipped if any already exist
-- =============================================================================
INSERT INTO company(name, sector_id, reg_number, email, phone, address, status)
SELECT
  p.pname || ' ' || s.sname || ' ' || lpad(i::TEXT, 3, '0'),
  sec.sector_id,
  'CX-' || lpad((row_number() OVER ())::TEXT, 6, '0'),
  lower(regexp_replace(p.pname || s.sname || i::TEXT, '\W+', '', 'g')) || '@demo.in',
  '+91-9' || lpad((100000000 + (random() * 899999999))::BIGINT::TEXT, 9, '0'),
  loc.city || ', ' || loc.state,
  CASE WHEN random() < 0.04 THEN 'SUSPENDED' ELSE 'ACTIVE' END
FROM generate_series(1, 400) AS i
CROSS JOIN LATERAL (
  SELECT name AS pname FROM unnest(ARRAY[
    'Aarti','Adani','Anil','Apollo','Asian','Bajaj','Balaji','Bharat','Binni','Birla',
    'CESC','Century','Dalmia','Deep','Emami','Epsilon','Escorts','GMR','Godrej',
    'Grasim','Gupta','Hindalco','Hinduja','IFFCO','Indorama','Jindal','JSW','Kirloskar',
    'Kumar','Larsen','Madras','Mahindra','Man','Mechkem','Meghmani','Mittal',
    'Mohan','Nagarjuna','NOCIL','Ocior','ONGC','Orbit','Punjab','Raamraa','Rajasthan',
    'Reliance','Renaissance','Shree','Shriram','Siddharth','Srei','Sunrise',
    'Surya','Tata','Techno','Thermax','Ultra','Vardhman','Vishnu','Welspun'
  ]) AS name ORDER BY random() LIMIT 1
) p
CROSS JOIN LATERAL (
  SELECT name AS sname FROM unnest(ARRAY[
    'Power','Cement','Steel','Aluminium','Fertiliser','Petrochemicals',
    'Pulp','Textile','Chlor','Refinery','Industries','Enterprises','Limited',
    'Group','Holdings','Energy','Chemicals','Alloys','Papers','Systems'
  ]) AS name ORDER BY random() LIMIT 1
) s
CROSS JOIN LATERAL (SELECT sector_id FROM sector ORDER BY random() LIMIT 1) sec
CROSS JOIN LATERAL (
  SELECT c.name AS city, st.name AS state
    FROM city c JOIN state st ON st.state_id = c.state_id
   ORDER BY random() LIMIT 1
) loc
WHERE NOT EXISTS (SELECT 1 FROM company);

-- =============================================================================
-- 2. Facilities — ~745, spread over the geocoded cities
-- =============================================================================
INSERT INTO facility(company_id, city_id, facility_type_id, name,
                     latitude, longitude, capacity_mw, commissioned_year,
                     baseline_annual_tonnes, status)
SELECT
  co.company_id,
  loc.city_id,
  ft.facility_type_id,
  left(co.name, 60) || ' ' || left(loc.city, 20) || ' U' || k,
  round((loc.lat + (random() - 0.5) * 0.35)::NUMERIC, 6),
  round((loc.lng + (random() - 0.5) * 0.35)::NUMERIC, 6),
  round((20 + random() * 980)::NUMERIC, 2),
  1975 + (random() * 45)::INT,
  ROUND((
     CASE s.name
       WHEN 'Power'         THEN 1800000 + random() * 5200000
       WHEN 'Cement'        THEN  600000 + random() * 1800000
       WHEN 'Steel'         THEN  900000 + random() * 2600000
       WHEN 'Aluminium'     THEN  250000 + random() *  700000
       WHEN 'Fertiliser'    THEN  300000 + random() *  900000
       WHEN 'Petrochemicals' THEN 150000 + random() *  500000
       WHEN 'Pulp & Paper'  THEN   40000 + random() *  120000
       WHEN 'Textile'       THEN   15000 + random() *   60000
       WHEN 'Chlor-Alkali'  THEN  120000 + random() *  400000
       ELSE                      80000 + random() *  300000
     END
  )::NUMERIC, 2),
  CASE WHEN random() < 0.05 THEN 'IDLE' ELSE 'ACTIVE' END
FROM company co
JOIN sector s ON s.sector_id = co.sector_id
CROSS JOIN generate_series(1, 2) AS k
CROSS JOIN LATERAL (
  SELECT c.city_id, c.latitude AS lat, c.longitude AS lng
    FROM city c ORDER BY random() LIMIT 1
) loc
CROSS JOIN LATERAL (SELECT facility_type_id FROM facility_type ORDER BY random() LIMIT 1) ft
WHERE NOT EXISTS (SELECT 1 FROM facility)
LIMIT 745;

-- =============================================================================
-- 3. Fuel mix — the dominant fuel depends on the company's sector
-- =============================================================================
INSERT INTO facility_fuel(facility_id, fuel_id, annual_consumption)
SELECT f.facility_id, fu.fuel_id,
       ROUND((f.baseline_annual_tonnes / NULLIF(fu.emission_factor, 0) * 0.75)::NUMERIC, 2)
FROM facility f
JOIN company co ON co.company_id = f.company_id
JOIN sector  s  ON s.sector_id  = co.sector_id
CROSS JOIN LATERAL (
  SELECT ft.fuel_id, ft.emission_factor
    FROM fuel_type ft
   WHERE CASE s.name
           WHEN 'Power'         THEN ft.name IN ('Coal', 'Natural gas')
           WHEN 'Cement'        THEN ft.name IN ('Pet coke', 'Coal')
           WHEN 'Steel'         THEN ft.name IN ('Pet coke', 'Coal')
           WHEN 'Aluminium'     THEN ft.name IN ('Pet coke', 'Grid power')
           WHEN 'Fertiliser'    THEN ft.name IN ('Natural gas', 'Coal')
           WHEN 'Petrochemicals' THEN ft.name IN ('Natural gas', 'Fuel oil')
           ELSE                     ft.name IN ('Natural gas', 'Diesel', 'Grid power')
         END
   ORDER BY random() LIMIT 1
) fu
WHERE NOT EXISTS (SELECT 1 FROM facility_fuel);

-- =============================================================================
-- 4. Sensors
--
--   plaintext key : demo-sensor-key-001
--   backend env   : SENSOR_KEY=demo-sensor-key-001
--
-- Every demo sensor shares one key so the simulator can post as any of them.
-- In production each sensor gets its own 32-byte random token, stored as
-- sha256 (never bcrypt — the ingest path checks this on every request).
-- =============================================================================
INSERT INTO sensor(facility_id, serial_no, sensor_type, api_key_hash, installed_on, status)
SELECT f.facility_id,
       'SEN-' || lpad(f.facility_id::TEXT, 6, '0'),
       (ARRAY['CO2','CO2','CO2','FLOW','CH4'])[1 + (f.facility_id % 5)],
       encode(digest('demo-sensor-key-001', 'sha256'), 'hex'),
       DATE '2023-01-01' + (f.facility_id % 700),
       CASE WHEN f.facility_id % 17 = 0 THEN 'OFFLINE' ELSE 'ONLINE' END
FROM facility f
WHERE NOT EXISTS (SELECT 1 FROM sensor);

-- =============================================================================
-- 5. Daily readings, 2024-01-01 → 2026-09-30, ±15% around baseline
-- =============================================================================
-- Both AFTER INSERT triggers on emission_reading are O(1), so they can stay
-- enabled. If you want a faster load, uncomment the two ALTER lines and then
-- rely on fn_rebuild_period_totals() in step 7 to fill the totals in.

-- ALTER TABLE emission_reading DISABLE TRIGGER USER;

-- MATERIALIZED so the "one sensor per facility" lookup runs 745 times, not
-- once per generated row.
CREATE TEMP TABLE _seed_fmap ON COMMIT DROP AS
SELECT f.facility_id,
       f.baseline_annual_tonnes,
       (SELECT s.sensor_id FROM sensor s
         WHERE s.facility_id = f.facility_id AND s.status = 'ONLINE'
         ORDER BY s.sensor_id LIMIT 1) AS sensor_id
  FROM facility f;

INSERT INTO emission_reading(facility_id, sensor_id, source_id, reading_ts, co2_tonnes, verified)
SELECT fmap.facility_id,
       fmap.sensor_id,
       1,
       d,
       ROUND((fmap.baseline_annual_tonnes / 365.0
              * (0.85 + random() * 0.30)
              * (1 + 0.06 * sin(EXTRACT(DOY FROM d)::NUMERIC / 58.0))
             )::NUMERIC, 3),
       d < now() - INTERVAL '30 days'
FROM _seed_fmap fmap
CROSS JOIN LATERAL generate_series('2024-01-01'::timestamptz, '2026-09-30'::timestamptz,
                                   INTERVAL '1 day') AS g(d)
WHERE NOT EXISTS (SELECT 1 FROM emission_reading);

-- ALTER TABLE emission_reading ENABLE TRIGGER USER;

-- =============================================================================
-- 6. Caps
--
-- 90%-105% of the company's annual baseline, pro-rated by how much of the
-- period has already elapsed. Without the pro-rating, 2026 (only 9 months of
-- readings so far) would sit at ~75% of every cap and no company would ever
-- breach anything.
-- =============================================================================
INSERT INTO emission_cap(company_id, period_id, cap_tonnes)
SELECT f.company_id, cp.period_id,
       ROUND(SUM(f.baseline_annual_tonnes) * (0.90 + random() * 0.15)
             * LEAST(1, GREATEST(
                 (CURRENT_DATE - cp.start_date)::NUMERIC
                 / GREATEST((cp.end_date - cp.start_date + 1)::NUMERIC, 1), 0.01)), 2)
FROM facility f
CROSS JOIN compliance_period cp
WHERE cp.start_date <= CURRENT_DATE
GROUP BY f.company_id, cp.period_id
ON CONFLICT (company_id, period_id) DO NOTHING;

-- =============================================================================
-- 7. Wallets and derived data
-- =============================================================================
UPDATE credit_account SET cash_balance = 50000000;

-- Idempotent and cheap enough to always run: repairs the running totals if the
-- load above ran with triggers disabled, and is a no-op otherwise.
SELECT fn_rebuild_period_totals();
REFRESH MATERIALIZED VIEW mv_monthly_emission;

-- Seed the alerts the dashboard shows before the first live reading arrives.
INSERT INTO alert(company_id, period_id, alert_type, message)
SELECT company_id, period_id,
       CASE WHEN pct_used >= 100 THEN 'CAP_EXCEEDED' ELSE 'CAP_90' END,
       format('Emissions at %s%% of cap', pct_used)
FROM v_company_compliance
WHERE pct_used >= 90
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 8. Summary
-- =============================================================================
DO $$
DECLARE v_co INT; v_fa INT; v_se INT; v_re BIGINT; v_al INT; v_ca INT;
BEGIN
  SELECT count(*) INTO v_co FROM company;
  SELECT count(*) INTO v_fa FROM facility;
  SELECT count(*) INTO v_se FROM sensor;
  SELECT count(*) INTO v_re FROM emission_reading;
  SELECT count(*) INTO v_al FROM alert;
  SELECT count(*) INTO v_ca FROM emission_cap;
  RAISE NOTICE 'Seeded: % companies, % facilities, % sensors, % readings, % caps, % alerts',
    v_co, v_fa, v_se, v_re, v_ca, v_al;
END $$;
