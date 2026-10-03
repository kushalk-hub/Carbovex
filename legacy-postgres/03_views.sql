-- =============================================================================
-- CarbonX :: 03_views.sql
-- =============================================================================

-- Credits held per company per batch. Excludes expired batches, so it is always
-- a valid "what can this company actually sell right now" list.
CREATE VIEW v_credit_holdings AS
SELECT l.company_id, l.batch_id, b.vintage_year, SUM(l.quantity) AS qty
FROM credit_ledger l
JOIN credit_batch b ON b.batch_id = l.batch_id
WHERE b.status = 'ACTIVE'
  AND (b.expiry_year IS NULL OR b.expiry_year >= EXTRACT(YEAR FROM CURRENT_DATE)::INT)
GROUP BY l.company_id, l.batch_id, b.vintage_year
HAVING SUM(l.quantity) > 0;


-- Emissions per facility per period. Cross join keeps facilities with no
-- readings visible at zero instead of dropping them.
CREATE VIEW v_facility_period_emission AS
SELECT f.facility_id, cp.period_id, cp.year, COALESCE(SUM(r.co2_tonnes), 0) AS emitted
FROM facility f
CROSS JOIN compliance_period cp
LEFT JOIN emission_reading r
  ON r.facility_id = f.facility_id
 AND r.reading_ts >= cp.start_date
 AND r.reading_ts <  cp.end_date + 1
GROUP BY f.facility_id, cp.period_id, cp.year;


-- Company emissions vs cap.
-- Reads the incrementally maintained period_total, so this is O(companies x periods)
-- instead of scanning every reading. v_company_compliance_audit exists to prove
-- the shortcut is not lying.
CREATE VIEW v_company_compliance AS
SELECT c.company_id, c.name, s.name AS sector, cp.period_id, cp.year,
       ec.cap_tonnes,
       COALESCE(pt.tonnes, 0)                                AS emitted,
       ec.cap_tonnes - COALESCE(pt.tonnes, 0)                AS headroom,
       ROUND(100 * COALESCE(pt.tonnes, 0) / ec.cap_tonnes, 1) AS pct_used
FROM emission_cap ec
JOIN company c             ON c.company_id  = ec.company_id
JOIN compliance_period cp  ON cp.period_id  = ec.period_id
LEFT JOIN sector s         ON s.sector_id   = c.sector_id
LEFT JOIN period_total pt  ON pt.company_id = ec.company_id
                          AND pt.period_id  = ec.period_id;


-- The same emissions figures recomputed from raw readings. Never used by the
-- application; it exists purely as the correctness check in the test suite.
--   SELECT * FROM v_company_compliance_audit WHERE fast_emitted <> actual_emitted;
-- must return zero rows.
CREATE VIEW v_company_compliance_audit AS
SELECT v.company_id, v.period_id, v.emitted AS fast_emitted,
       COALESCE(x.actual, 0) AS actual_emitted
FROM v_company_compliance v
LEFT JOIN LATERAL (
  SELECT SUM(r.co2_tonnes) AS actual
  FROM facility f
  JOIN emission_reading r ON r.facility_id = f.facility_id
  WHERE f.company_id = v.company_id
    AND r.reading_ts >= (SELECT start_date FROM compliance_period WHERE period_id = v.period_id)
    AND r.reading_ts <  (SELECT end_date   FROM compliance_period WHERE period_id = v.period_id) + 1
) x ON TRUE;


-- Resting orders, best price first, time priority within a price level.
CREATE VIEW v_order_book AS
SELECT order_id, company_id, side, price_per_credit,
       quantity - filled_qty AS remaining, created_at
FROM market_order
WHERE status IN ('OPEN', 'PARTIAL');


-- Sector leaderboard. PARTITION BY needs the sector name, not the id, because
-- companies with no sector are all lumped into one 'Unclassified' group.
CREATE VIEW v_sector_rank AS
SELECT COALESCE(v.sector, 'Unclassified') AS sector,
       v.company_id, v.name AS company, v.year, v.emitted, v.pct_used,
       RANK() OVER (PARTITION BY COALESCE(v.sector, 'Unclassified'), v.year
                    ORDER BY v.emitted DESC) AS rank_in_sector
FROM v_company_compliance v;


-- Monthly rollup per facility, refreshed nightly by jobs/dailyPrice.js.
-- Served by GET /api/facilities/:id/readings?bucket=month.
CREATE MATERIALIZED VIEW mv_monthly_emission AS
SELECT facility_id, date_trunc('month', reading_ts) AS month, SUM(co2_tonnes) AS tonnes
FROM emission_reading
GROUP BY 1, 2;
CREATE UNIQUE INDEX ON mv_monthly_emission (facility_id, month);
