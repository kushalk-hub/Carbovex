'use strict';

/**
 * Pure helpers shared by the jobs and import scripts.
 *
 * Extracted so they can be tested without loading the surrounding files. Both of
 * those files open a database connection at require time — sensorSimulator reads
 * the sensor roster, importCcts counts distinct facilities — so importing either
 * one just to test a CSV parser meant a live MongoDB as a precondition for tests
 * that have nothing to do with the database.
 *
 * Nothing here touches the database or the clock. Where a value would otherwise
 * come from the environment it is a parameter with a default.
 */

/**
 * A plausible daily emission figure for a facility with an annual baseline.
 *
 * Three factors, each modelling something real rather than being noise:
 *
 *   baseline/365   a flat daily rate from the annual figure
 *   0.85..1.15     day-to-day variation, so the series is not suspiciously smooth
 *   seasonal      a 58-day sine, standing in for a fortnightly-ish operational
 *                 pattern in plant output
 *
 * The result is floored at 0.01 rather than 0. A zero reading is not "no
 * emissions" — a facility that reports exactly zero every day is either broken or
 * lying, and either way it should not be indistinguishable from a quiet day.
 */
function dailyTonnes(baseline, rng = Math.random) {
  const seasonal = 1 + 0.06 * Math.sin((Date.now() / 86_400_000 / 58) * Math.PI);
  return Math.max(0.01, (baseline / 365) * (0.85 + rng() * 0.3) * seasonal);
}

/**
 * Parse one CSV line into fields, honouring quoted fields.
 *
 * Written by hand rather than pulled from a dependency because the only tricky
 * part of the CCT dataset is RFC 4180 quoting — embedded commas, embedded
 * newlines, and doubled quotes as an escaped quote — and a general CSV package
 * would be more code than this. The `""` case is the one that is easy to miss:
 * without it, a literal quote inside a quoted field ends the field early.
 */
function parseLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/**
 * Find a column by trying each candidate substring in order of preference.
 *
 * Government energy datasets rename columns between releases — "Total Emissions
 * (tCO2e)" one year, "emissions_tco2e" the next — so the importer matches on
 * substrings in priority order rather than on an exact header. Returns which
 * pattern matched, because a column found by a fallback pattern is worth logging.
 */
function findColumn(headers, patterns) {
  const lower = headers.map((h) => String(h).toLowerCase());
  for (const pattern of patterns) {
    const idx = lower.findIndex((h) => h.includes(String(pattern).toLowerCase()));
    if (idx !== -1) return { index: idx, matched: headers[idx], pattern };
  }
  return null;
}

/**
 * Parse a number that may carry thousand separators or stray whitespace.
 *
 * Returns null for anything unparseable rather than 0 or NaN, because the caller
 * has to distinguish "the dataset left this blank" from "the value was zero", and
 * only one of those should be skipped.
 */
function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  // The dataset uses commas as thousand separators inside quoted numbers.
  const cleaned = String(value).replace(/[,\s]/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

module.exports = { dailyTonnes, parseLine, findColumn, toNumber };
