'use strict';

/**
 * Load the CCTS-745 CSV into the MongoDB cctsstaging collection.
 *
 *   node scripts/importCcts.js data/ccts745.csv
 *
 * The official CCTS-745 release is a wide CSV with dozens of indicator columns
 * and no fixed column order, and the column names change between versions. So
 * this importer is deliberately forgiving: it matches header names by pattern
 * rather than by position, and it reports what it could not find instead of
 * silently importing zeros.
 *
 * Writing a strict positional parser here would produce a table full of NULL
 * baselines the first time the government published an updated release, and
 * that failure is invisible until a cap calculation looks wrong.
 */

const fs = require('fs');
const path = require('path');
const db = require('../src/db/connect');
const env = require('../src/config/env');
const mongoose = require('mongoose');
const STAGING_COLLECTION = 'cctsstaging';

/** Split one CSV line, honouring double-quoted fields and "" escapes. */
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
  return out.map((f) => f.trim());
}

/**
 * Find the column index for the first header matching any of `patterns`.
 * Case-insensitive substring match, so "Entity Name" finds "entity_name".
 */
function findColumn(headers, patterns) {
  const lower = headers.map((h) => h.toLowerCase());
  for (const pattern of patterns) {
    const idx = lower.findIndex((h) => h.includes(pattern));
    if (idx !== -1) return { index: idx, matched: headers[idx], pattern };
  }
  return null;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  // The dataset uses commas as thousand separators inside quoted numbers.
  const cleaned = String(value).replace(/[,\s]/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/importCcts.js <path-to-ccts745.csv>');
    process.exit(1);
  }
  const full = path.resolve(file);
  if (!fs.existsSync(full)) {
    console.error(`[import] file not found: ${full}`);
    process.exit(1);
  }

  console.log(`[import] reading ${full}`);
  const text = fs.readFileSync(full, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) {
    console.error('[import] the file has no data rows');
    process.exit(1);
  }

  const headers = parseLine(lines[0]);
  console.log(`[import] ${lines.length - 1} rows, ${headers.length} columns`);
  console.log(`[import] headers: ${headers.slice(0, 8).join(' | ')}${headers.length > 8 ? ' | ...' : ''}`);

  // Deliberately generous patterns, tried in priority order.
  const specs = {
    entity: findColumn(headers, ['entity name', 'entity_name', 'entity name(', 'entity', 'organisation', 'organization']),
    sector: findColumn(headers, ['sector', 'sector name']),
    facility: findColumn(headers, ['facility name', 'facility_name', 'facility']),
    state: findColumn(headers, ['state', 'state name']),
    city: findColumn(headers, ['city', 'city name']),
    lat: findColumn(headers, ['latitude', 'lat']),
    lng: findColumn(headers, ['longitude', 'long', 'lng']),
    baseline: findColumn(headers, ['baseline ghg emission', 'baseline_ghg', 'baseline ghg', 'baseline emission', 'baseline']),
  };

  const missing = Object.entries(specs)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  const found = Object.entries(specs)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}->"${v.matched}"`);

  console.log(`[import] mapped: ${found.join(', ')}`);
  if (missing.length > 0) {
    console.warn(`[import] WARNING: no column found for: ${missing.join(', ')}`);
    console.warn('[import] those fields will be NULL. Check the header row before trusting the import.');
  }

  await db.connect();
  const staging = mongoose.connection.db.collection(STAGING_COLLECTION);
  await staging.deleteMany({ sourceFile: path.basename(full) });

  const BATCH = 500;
  let inserted = 0;
  let batch = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const operations = batch.map((row) => ({
      updateOne: {
        filter: { sourceFile: path.basename(full), sourceRow: row.sourceRow },
        update: { $set: row },
        upsert: true,
      },
    }));
    await staging.bulkWrite(operations, { ordered: false });
    inserted += batch.length;
    batch = [];
    if (inserted % 5000 === 0) console.log(`[import] ${inserted} rows`);
  };

  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseLine(lines[i]);
    const get = (spec) => (spec ? (cells[spec.index] ?? '') : '');

    const entity = get(specs.entity);
    if (!entity) continue; // summary/total rows exist in the official file

    batch.push({
      sourceFile: path.basename(full),
      sourceRow: i,
      entity: entity.slice(0, 200),
      sector: get(specs.sector).slice(0, 80),
      facility: get(specs.facility).slice(0, 200),
      state: get(specs.state).slice(0, 80),
      city: get(specs.city).slice(0, 80),
      lat: toNumber(get(specs.lat)),
      lng: toNumber(get(specs.lng)),
      baseline: toNumber(get(specs.baseline)),
    });

    if (batch.length >= BATCH) await flush();
  }
  await flush();

  const filter = { sourceFile: path.basename(full) };
  const [entities, geocoded, withBaseline] = await Promise.all([
    staging.distinct('entity', filter),
    staging.countDocuments({ ...filter, lat: { $ne: null } }),
    staging.countDocuments({ ...filter, baseline: { $ne: null } }),
  ]);

  console.log(`[import] staged ${inserted} rows in ${STAGING_COLLECTION}`);
  console.log(`[import] ${entities.length} distinct entities, ${geocoded} geocoded, ${withBaseline} with a baseline`);
  if (geocoded === 0) {
    console.warn('[import] WARNING: no rows have coordinates. The 3D globe will be empty.');
    console.warn(`[import] The dataset may not include lat/lng — geocode from city instead.`);
    console.warn('[import] Geocode from city before using these rows for facilities.');
  }
  console.log(`[import] staging data is in ${env.db.appDatabase}.${STAGING_COLLECTION}`);
  console.log(`[import] project data directory: ${env.paths.data}`);
}

// Only run when invoked directly, so tests/unit.test.js can import the pure
// helpers above without this script trying to import a CSV and exit.
if (require.main === module) {
  main()
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('[import] failed:', err.message);
      await db.close().catch(() => {});
      process.exit(1);
    });
}

module.exports = { parseLine, findColumn, toNumber };
