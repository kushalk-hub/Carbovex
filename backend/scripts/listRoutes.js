'use strict';

/**
 * Route lister — a development aid, run with `node scripts/listRoutes.js`.
 *
 * Prints every route the Express app registers. Useful for checking that a
 * module was actually mounted and that a guard was not left off by accident,
 * which is the failure mode that a mounted router with a router-level
 * middleware mistake produces.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const { createApp } = require('../src/app');

/**
 * Reconstruct a router's mount path from the regexp Express compiled.
 *
 * Express stores this as something like ^\/api\/auth(?:\/(?=$))?. Rather than
 * trying to regex-parse that reliably, strip the anchor, cut at the optional
 * tail, and unescape — which is all the information it actually contains.
 */
function mountPath(layer) {
  if (!layer.regexp) return '';
  // Express appends a strict-routing tail such as \/?(?=\/|$) or (?:\/(?=$))?
  // to the mount path. Cut at the first group, which is where that tail starts.
  let s = layer.regexp.source.replace(/^\^/, '').split('(')[0];
  // Unescape, then drop the literal "/?" of Express's strict-routing tail.
  s = s.replace(/\\(.)/g, '$1').replace(/\/\?$/, '');
  return s === '' ? '' : s;
}

function walk(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods)
        .map((m) => m.toUpperCase())
        .sort()
        .join('|');
      out.push({ methods, path: prefix + (layer.route.path === '/' ? '' : layer.route.path) || '/' });
    } else if (layer.name === 'router' && layer.handle?.stack) {
      const seg = mountPath(layer);
      walk(layer.handle.stack, prefix + seg, out);
    }
  }
}

const app = createApp();
const out = [];
walk(app._router.stack, '', out);

const unique = new Map();
for (const r of out) {
  const key = `${r.methods} ${r.path}`;
  if (!unique.has(key)) unique.set(key, r);
}

const rows = [...unique.values()].sort((a, b) => a.path.localeCompare(b.path) || a.methods.localeCompare(b.methods));
const width = Math.max(...rows.map((r) => r.methods.length));
for (const r of rows) {
  console.log(`${r.methods.padEnd(width + 2)}${r.path}`);
}
console.log(`\n${rows.length} routes`);

const missing = rows.filter((r) => !r.path.startsWith('/api') && !['/health', '/'].includes(r.path));
if (missing.length > 0) {
  console.log('\nWARNING: routes outside /api that are not health or root:');
  for (const m of missing) console.log(`  ${m.methods} ${m.path}`);
}
