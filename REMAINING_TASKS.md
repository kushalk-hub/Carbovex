# CarbonX Migration — Remaining Work

Handoff for continuing the PostgreSQL → MongoDB migration.

Write date: 2026-10-02
Backend root: `C:\Users\kusha\OneDrive\Documents\Carbovex\carbon-exchange\backend`
Reference implementation: `carbon-exchange\legacy-postgres\`

---

## 1. Read this first

**The single most important fact about this codebase:** several of the decisions below
look like bugs and are not. They were each arrived at by hitting the failure. Do not
"clean them up" without reading the comment attached to them.

- `mongoose.set('sanitizeFilter', false)` in `src/db/connect.js` is deliberate. Enabling
  it wraps object filter values in `$eq`, which breaks every date-range query, every
  `$gte` balance guard, and `$expr`. Real defence against injected operators is the Zod
  validation in `middleware/validate.js`, which runs before any query is built.
- `AsyncLocalStorage` in `src/db/connect.js` replaces a module-scoped `actor` variable.
  A module-scoped variable is wrong under concurrency: two overlapping requests
  interleave at every `await` and attribute each other's writes. There is a test for
  this.
- `scripts/setup.js` grants privileges per collection and never grants
  database-wide `find`/`insert`/`update`/`remove`. MongoDB privileges are **additive** —
  a second, narrower role cannot subtract from a broad one. An earlier version granted
  `readWrite` at database level and *appeared* to work while the append-only guarantee
  was completely absent. This is verified, not assumed (see §4).

---

## 2. Current state

### Working and verified

| Area | Status |
| --- | --- |
| 33 Mongoose models + constraints | done, 14 tests |
| 7 service modules | done, 14 unit + 18 integration tests |
| 12 route modules, 42 routes | done, all modules load, all 42 enumerate |
| Express wiring, health endpoint | done |
| Change-stream realtime | done (local-emit fallback in place) |
| Replica-set launcher with keyfile auth | done, running on 27018 |
| `db:setup` — 33 collections, indexes, least-privilege role | done, verified |
| `db:verify-append-only` — all 6 collections | done, **all checks pass** |
| `.env.example` | written |
| `03_BACKEND_README.md` rewrite | **not started** |
| `04_FRONTEND_README.md` update | **not started** |

The last full test run was 64 passing / 0 failing / 0 skipped, but that was **before**
the auth-enabled replica set existed. See §5, item 1 — that run needs repeating and has
not been done since.

### Local MongoDB state (assume nothing here; verify it)

- `27017` — the pre-existing Windows service. **Standalone, no replica set, leave it
  alone.** It cannot run this application at all.
- `27018` — throwaway replica set `rs0` started by `npm run mongo:test-rs`. Data dir is
  `%TEMP%\carbonx-rs0`. Started with `--keyFile`, so authorization is enforced.
- Admin user exists: `carbonx_root` / `carbonx_root`
- App user exists: `carbonx_app` / `carbonx_app`, granted by `db:setup`
- `backend\.env` is written and is git-ignored (verified with `git check-ignore`).

If you wipe `%TEMP%\carbonx-rs0`, you must recreate `carbonx_root` yourself before
`db:setup` can run — see §4.

---

## 3. Immediate blocker: the app cannot start

`src/server.js` still requires the deleted `src/db/pool.js`. It is the process entry
point, so `npm start` and `npm run dev` are both broken right now.

```js
const db = require('./db/pool');   // src/server.js:16  — file no longer exists
```

`src/db/connect.js` is the replacement. Three changes are needed in `server.js`:

1. **Line 16** — swap the import:
   ```js
   const db = require('./db/connect');
   ```
2. **Lines 28-34** — `db.ping()` does not exist. Use `db.connect()` then
   `db.supportsTransactions()`:
   ```js
   try {
     await db.connect();
     if (!(await db.supportsTransactions())) {
       console.error('[db] This server cannot run multi-document transactions.');
       console.error('[db] Run `npm run mongo:test-rs` for a local replica set.');
       process.exit(1);
     }
     console.log(`[db] ready: ${env.db.appDatabase}`);
   } catch (err) {
     console.error(`[db] ${err.message}`);
     process.exit(1);
   }
   ```
   Note `env.db.host`, `env.db.port` and `env.db.database` referenced on lines 29 and 31
   **no longer exist**. The replacements are `env.db.appDatabase` and `env.db.uri`.
   There is no `env.db.host` / `env.db.port` / `env.db.database` in the new config.
3. **Line 82** — `db.close()` exists and is fine as-is. Update the log text
   ("database pool closed" → "database connection closed").

Also check `env.corsOrigin` still resolves — `server.js:46` joins it.

---

## 4. Task: recreate the admin user after a data-dir wipe

If the replica set data directory is ever deleted, `db:setup` cannot bootstrap itself:
with `--keyFile` and an empty database the server is in the *localhost exception* state,
and once any user exists that exception ends. The sequence that works:

```powershell
# 1. Stop the replica set, wipe it, restart it
npm run mongo:test-rs

# 2. Create the admin user, unauthenticated, while the exception still applies
mongosh "mongodb://localhost:27018/admin?directConnection=true" --eval `
  "db.createUser({user:'carbonx_root', pwd:'carbonx_root', roles:[{role:'root',db:'admin'}]})"

# 3. Now the admin user can create the app user
npm run db:setup -- --reset

# 4. Prove the guarantee actually holds
npm run db:verify-append-only
```

Step 4 is not optional ceremony. It is the check that caught the additive-privileges bug
described in §1. It connects as `carbonx_app` and attempts `update`, `delete`, `replace`
on all six insert-only collections, and confirms a non-append-only collection
(`marketorders`) is still writable — that second half matters, because otherwise a
misconfigured "deny everything" user would also pass.

---

## 5. Remaining work, in order

### 1. Re-run the full test suite against the authenticated replica set

This has not been done since authorization was enabled. The integration tests were
written against an *unauthenticated* server and will very likely need a second admin
connection for teardown, because the app role deliberately cannot do the cleanup:

- `carbonx_app` has no `remove` on `creditledger`, `emissionreadings`, `auditlog`,
  `trades`, `payments`, `verifications`.
- `carbonx_app` has no `dropDatabase`.

So in `tests/integration.test.js`, the `before`/`after` hooks that clear collections or
drop the database need an **admin** connection (`env.db.adminUri`), while the code under
test keeps using the app user. Two `mongoose` connections in one test file is
uncomfortable; the alternative is to run the integration suite against a dedicated
database with an admin user and treat the app-user path as covered by
`db:verify-append-only`. Either is defensible — pick one and comment why.

```powershell
npm test
```

### 2. Port the remaining PostgreSQL files

Seven files still reference the old `db/pool` API. Sizes and call-site counts:

| File | Lines | `db.*` call sites | Notes |
| --- | --- | --- | --- |
| `src/server.js` | 114 | 0 | §3. Blocking. |
| `src/jobs/dailyPrice.js` | 78 | 3 | writes `pricehistory` |
| `src/jobs/expireCredits.js` | 53 | 1 | touches `creditledger` — append-only, so **insert only** |
| `src/jobs/sensorSimulator.js` | 177 | 0 | dev-only, fabricate readings; pure helpers already extracted to `src/jobs/helpers.js` |
| `scripts/importCcts.js` | 214 | 2 | bulk upsert, CCTS-745 CSV |
| `tests/smoke.js` | 323 | 2 | HTTP smoke test |
| `scripts/seed.js` | — | — | already rewritten for Mongoose; **syntax-checked only, never run** |

Pattern for all of them: replace `db.query(sql, params)` with either a Mongoose model
call or a `mongoose.connection.db.collection(name)` pipeline. Anything that must be
atomic goes through `db.withTransaction(fn)`.

Watch for these when porting — each is a bug that already happened once elsewhere:

- `creditledger` writes are insert-only. An `update` will be rejected by the database, not
  by the model guard, and the error surfaces as `Unauthorized`, which reads like an auth
  bug if you are not expecting it.
- Never write a `$cond` inside a classic `$set`. `claimFill()` did, and the server stored
  the expression object literally, silently removing orders from the order book. Use a
  pipeline update.
- Never rely on a duplicate-key error to dedupe inside a transaction. The duplicate
  aborts the whole transaction. Pre-filter on the `dedupeKey`, and retry once on
  `DuplicateKey` for the race.

### 3. Delete the obsolete PostgreSQL migration script

`scripts/migrate.js` is superseded by `scripts/setup.js`. Remove it, and remove
`db:migrate` from `package.json` if it is still referenced.

### 4. Rewrite the documentation

Two files, and the distinction matters:

- `03_BACKEND_README.md` (116 KB) — **full rewrite** as the MongoDB backend
  specification. It is currently a PostgreSQL document. Cover: the 33 collections and
  why each exists, the transaction boundaries and which operations are atomic, the
  append-only grant design, the FIFO vintage-allocation rule, the realtime change-stream
  model, and setup/run/seed/verify commands.
- `04_FRONTEND_README.md` (55 KB) — **targeted update only**. The frontend contract is
  unchanged, with these exceptions:
  - `POST /api/admin/partitions/ensure` is **gone**. Partition maintenance was
    PostgreSQL-specific; MongoDB has no equivalent.
  - `GET /api/reports/:id/audit` is **new**, replacing the above so the route count stays
    at 42.
  - `dedupeKey` is now explicit on ingestion: `s:<sensorId>:<ISO>` for sensor readings,
    `m:<facilityId>:<ISO>:<sourceId|none>` for manual ones.
  - IDs are 24-hex ObjectId strings in JSON; the wire format is unchanged camelCase.

**Do not modify** `01_DATABASE_AND_BACKEND (1).md` or `02_FRONTEND_3D.md`.

---

## 6. Verification commands

```powershell
npm run lint:check     # syntax check every file
npm run routes         # enumerate all 42 routes
npm test               # unit + integration
npm run db:setup       # rebuild collections, indexes, role
npm run db:verify-append-only
```

---

## 7. Constraints to preserve

- **FIFO vintage allocation** — retire the oldest vintage first. Matches the legacy
  PostgreSQL behaviour; changing it changes settlement outcomes.
- **SHA-256 sensor API-key hashing.** Keys are high-entropy, and the ingest path does a
  lookup on every request, so a per-request hash is affordable. The user's explicit
  decision was to keep this.
- **Company scoping** on every authenticated route, including audit reads.
- **Server-side verifier resolution** — an acting account without its own accreditation
  falls back to the configured internal verifier. Never trust a client-supplied verifier.
- **Auditors are excluded from wallet data.**
- **`TRUST_PROXY_HOPS`** decides whether `req.ip` is trustworthy, and therefore whether
  the rate limiter can be bypassed with a forged `X-Forwarded-For`. Count the proxies
  exactly; a non-zero value on a directly exposed app rate-limits everyone as `0.0.0.0`.
- **Known regression:** audit logging is now application-enforced. In PostgreSQL a
  trigger fired for every client regardless of code path; here it is a service call, so
  a future write that forgets it is silently unaudited. This is the largest behavioural
  weakening in the migration and should be stated plainly in the backend README.

---

## 8. Git state

Branch `main` has **no commits**, and `carbon-exchange/` is untracked. `legacy-postgres/`
is the only copy of the original SQL — it is the recovery source, so do not delete it
until the migration is signed off.
