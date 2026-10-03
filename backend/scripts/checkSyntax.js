'use strict';

/**
 * Parse every JavaScript file in the project.
 *
 *   npm run lint:check
 *
 * This is not a style linter — it is a syntax gate that needs no dependencies
 * and no configuration, so it works on a fresh clone before `npm install` has
 * ever been run. It is the one check that can be run on any machine, which
 * makes it the one check worth always running.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'coverage', 'data']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function main() {
  const files = walk(ROOT);
  const failures = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    try {
      // Compiling without running catches a syntax error and nothing else,
      // which is exactly what a syntax gate should do.
      new vm.Script(source, { filename: file });
    } catch (err) {
      failures.push({ file: path.relative(ROOT, file), message: err.message });
    }
  }

  for (const f of failures) {
    console.error(`FAIL ${f.file}\n     ${f.message}`);
  }
  console.log(
    failures.length === 0
      ? `ok: ${files.length} JavaScript files parsed cleanly`
      : `${failures.length} of ${files.length} files failed to parse`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
