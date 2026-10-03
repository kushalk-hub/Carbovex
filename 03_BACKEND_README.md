# CarbonX backend specification

**Status:** MongoDB migration reference  
**Backend:** `backend/`  
**Database:** MongoDB replica set, accessed through Mongoose  
**HTTP:** Express API with Socket.IO realtime events

This document describes the backend as it is implemented. The frontend
integration contract remains in `04_FRONTEND_README.md`. The PostgreSQL source
is retained in `legacy-postgres/` for migration recovery and comparison.

## 1. Runtime architecture

`src/server.js` connects to MongoDB before listening. Startup fails if MongoDB is
unavailable or does not support multi-document transactions. The server then
creates the Express application, starts Socket.IO/change streams, and starts
scheduled jobs. Shutdown stops jobs and realtime listeners, closes HTTP, then
disconnects Mongoose.

The main code layers are:

| Path | Responsibility |
| --- | --- |
| `src/config/env.js` | Load and validate environment settings once |
| `src/db/connect.js` | Shared connection, transactions, transaction capability check, request actor context |
| `src/models/` | 33 collection schemas, validation rules, indexes, append-only model guards |
| `src/middleware/` | Authentication, company scoping, validation, rate limits, error responses |
| `src/modules/` | Express route modules |
| `src/services/` | Business rules, atomic writes, audit calls, and aggregation pipelines |
| `src/realtime/` | Socket.IO and change-stream events, with local emit fallback |
| `src/jobs/` | Daily price refresh, credit expiry, and optional sensor simulation |
| `scripts/setup.js` | Collections, indexes, and least-privilege MongoDB role |
| `scripts/seed.js` | Idempotent reference and optional demo data |

MongoDB IDs are ObjectIds. In JSON, IDs are 24-character hexadecimal strings;
the API field names remain camelCase.

## 2. Collection catalog

The application defines 33 Mongoose collections. `cctsstaging` is an additional
raw import collection created by the optional CSV importer; it is not one of the
33 application models and is not consumed automatically by the seed process.

### Reference data

| Collection | Purpose |
| --- | --- |
| `countries` | Country reference records |
| `states` | State/province references linked to countries |
| `cities` | City reference data and coordinates |
| `sectors` | Company and facility industry sectors |
| `verifiers` | Accredited report verifiers |
| `facilitytypes` | Facility classification |
| `fueltypes` | Fuel reference values |
| `registries` | Carbon-credit registry references |
| `projecttypes` | Offset project classifications |
| `emissionsources` | Emission source classifications |
| `complianceperiods` | Compliance years, date windows, and deadlines |

### Tenancy and facilities

| Collection | Purpose |
| --- | --- |
| `companies` | Participating regulated companies and profile data |
| `users` | Login identity, role, active state, and company/verifier association |
| `facilities` | Company facilities, location, capacity, and baseline emissions |
| `facilityfuels` | Fuel use associated with a facility |
| `sensors` | Sensor identity, status, facility association, and SHA-256 key hash |

### Emissions and compliance

| Collection | Purpose |
| --- | --- |
| `periodtotals` | Incremental company-period emission totals for fast compliance reads |
| `emissionreadings` | Immutable sensor and manual readings, keyed by `dedupeKey` |
| `emissioncaps` | Company cap for a compliance period |
| `alerts` | Threshold and compliance notifications |

### Reporting

| Collection | Purpose |
| --- | --- |
| `emissionreports` | Company-submitted compliance reports |
| `verifications` | Verifier decisions and remarks for reports |

### Credits and wallet

| Collection | Purpose |
| --- | --- |
| `offsetprojects` | Projects that produce credit batches |
| `creditbatches` | Issued quantity, vintage, expiry, and status for each batch |
| `creditaccounts` | Current credit and cash wallet balances |
| `creditledger` | Immutable credit movements; source of truth for holdings |
| `creditretirements` | Credits surrendered for compliance or voluntary use |
| `penalties` | Company-period shortfall fines |

### Market and audit

| Collection | Purpose |
| --- | --- |
| `marketorders` | Buy/sell orders and their fill state |
| `trades` | Immutable executions between two orders |
| `payments` | Cash movement record associated with a trade |
| `pricehistory` | Daily OHLCV series, including explicit no-trade days |
| `auditlog` | Immutable application audit events |

Important unique/index constraints include company-period caps, one wallet per
company, unique reading `dedupeKey`, unique payment per trade, one verification
per report, unique orderable natural keys, and indexes for market priority,
date-range reads, holdings, and change-stream filters. `scripts/setup.js` creates
all model collections and indexes from the model definitions.

## 3. Transaction and consistency rules

MongoDB must run as a replica set or sharded cluster. A standalone server cannot
provide transactions, and the API refuses to start against one. `db.withTransaction`
uses a driver session and retries transient transaction conflicts through the
MongoDB driver's transaction helper.

Operations that change multiple related documents run within a transaction:

| Operation | Atomic work |
| --- | --- |
| Sensor/manual ingestion | Insert unique readings, update period totals, create threshold alerts, and write audit records |
| Credit issue | Insert batch and ISSUE ledger entry, update wallet, and audit writes |
| Credit retirement/expiry | Insert retirement/EXPIRE ledger entries, update wallet, update batch state where needed, and audit writes |
| Trade match/settlement | Claim order quantities, insert trade/payment, allocate credit ledger movements, adjust both wallets, and write audit records |
| Compliance processing | Apply retirement, penalties, report status, and corresponding audit events as one operation where called through the service transaction |

The most important invariants are maintained by the services because MongoDB
does not provide PostgreSQL triggers:

- `creditaccounts.creditBalance` tracks the sum of the company's
  `creditledger.quantity` movements.
- `periodtotals.tonnes` is incremented with each reading in the same transaction.
- An order fill uses a conditional update so competing matches cannot fill more
  than the remaining quantity. Conditional state changes use MongoDB update
  pipelines where an expression is required; classic `$set` stores expression
  objects as literal values.
- The FIFO vintage rule allocates or retires the oldest eligible vintage first.
  This preserves settlement behavior from the PostgreSQL implementation.
- Duplicate ingestion keys are filtered before transactional inserts. A
  duplicate-key error aborts a transaction, so it is not used as the normal
  deduplication branch; the race is retried once.

Application-level invariants require every writer to use the service layer.
Direct privileged writes can bypass wallet balancing, period totals, validation,
and audit calls. `credits.verifyBalance()` and the integration suite help detect
drift; they do not make bypassed writes safe.

## 4. Append-only data and database roles

These six collections are append-only:

- `creditledger`
- `emissionreadings`
- `auditlog`
- `trades`
- `payments`
- `verifications`

Mongoose guards reject model-level update/delete operations. The stronger
boundary is the `carbonx_app` MongoDB role: it receives collection-level `find`
and `insert` privileges for these collections, without `update` or `remove`.
Other collections receive the actions they require. The four realtime
collections (`trades`, `emissionreadings`, `alerts`, and `marketorders`) also
receive collection-scoped `changeStream` alongside `find`, as MongoDB requires
both actions to open a collection change stream. The setup intentionally
does not grant broad database-level `readWrite` privileges: MongoDB grants are
additive, so a narrow grant cannot cancel a broader write grant.

`npm run db:verify-append-only` connects as the app user and attempts update,
delete, and replace operations against all six collections. It also confirms a
mutable collection such as `marketorders` remains writable. Both sides matter:
a role that blocks all writes is not a valid passing configuration.

## 5. Audit and actor attribution

Services call `services/audit.js` when they write auditable records. The current
actor is stored in `AsyncLocalStorage` by `db.asUser(id, fn)`, so overlapping
requests do not overwrite one another's actor context. A module-scoped actor
variable is unsafe because async requests interleave at `await` boundaries.

**Known regression:** PostgreSQL populated audit rows with triggers regardless
of which code path performed the write. MongoDB has no equivalent trigger here;
audit logging is application-enforced. A future write path that bypasses or
forgets the audit service can therefore produce an unaudited change. This is the
largest behavioral weakening in this migration and must be considered in any
new write path review.

Audit reads remain tenant-scoped where applicable. Company scoping applies to
every authenticated route, including report audit reads. Auditors do not receive
wallet data. Verifier resolution is server-side: an acting account without its
own accreditation uses the configured internal verifier, never a client-supplied
verifier ID.

## 6. Ingestion and idempotency

`POST /api/readings` accepts sensor and manual batches. The dedupe key is
explicit and unique:

| Reading type | `dedupeKey` |
| --- | --- |
| Sensor | `s:<sensorId>:<ISO>` |
| Manual | `m:<facilityId>:<ISO>:<sourceId|none>` |

Sensor API keys are stored as SHA-256 hashes. The high-entropy machine key is
looked up on each request, so a fast hash is appropriate; user passwords use a
slow password hash. The request must validate before query construction. This is
the protection against query operator injection; `sanitizeFilter` remains
disabled because Mongoose's wrapping breaks legitimate range and expression
filters.

Rate limiting uses `req.ip`. `TRUST_PROXY_HOPS` must equal the number of trusted
proxies in front of the app. Use `0` when directly exposed; a wrong nonzero hop
count can cause every caller to appear as `0.0.0.0` or trust a forged forwarded
address.

## 7. Realtime behavior

The realtime layer uses MongoDB change streams when available and emits changes
to Socket.IO clients. Service writes also use local emits as a fallback, so API
mutations still notify clients when change streams are unavailable. Change
streams require a replica set. A write performed outside the API is not visible
to the fallback and requires change streams to be observed.

## 8. Jobs and data utilities

- `dailyPrice.js` recomputes yesterday's daily price candle from trades. It
  writes an explicit zero-volume row with null prices for a day without trades.
- `expireCredits.js` snapshots affected companies and calls the transactional
  credits service. Expiration writes negative EXPIRE ledger entries; it never
  edits or removes ledger history.
- `sensorSimulator.js` selects online sensors and posts through the public
  ingestion endpoint. It is opt-in at server boot (`SIMULATE=true`) or available
  through `npm run simulate`.
- `scripts/importCcts.js` loads a CSV into the `cctsstaging` raw collection and
  reports mapped columns and data quality. This is a staging import only; it
  does not create companies or facilities automatically.
- `scripts/seed.js` upserts reference data. Add `--demo` to create local sample
  companies, users, facilities, sensors, readings, credits, and related records.

MongoDB collections are not PostgreSQL partitions. The former partition
maintenance job and `/api/admin/partitions/ensure` route have no MongoDB
equivalent and are removed. Monthly facility readings are aggregated from the
underlying collection when requested rather than refreshed from a materialized
view.

## 9. Setup and operations

Requirements: Node.js 20 or newer and MongoDB configured as a replica set.

```powershell
cd backend
npm install
Copy-Item .env.example .env
# Configure MONGO_URI, MONGO_ADMIN_URI, DB_NAME, and JWT_SECRET in .env.
npm run mongo:test-rs
npm run db:setup
npm run db:seed -- --demo
npm start
```

The local replica-set helper uses port `27018` and a temporary data directory.
The pre-existing standalone service on `27017`, if any, is not suitable for the
transaction-dependent API. The app connects using `MONGO_URI`; setup uses
`MONGO_ADMIN_URI` to create collections/indexes and the restricted role. Keep
the admin URI out of application deployment settings where it is not needed.

Useful commands from `backend/`:

| Command | Purpose |
| --- | --- |
| `npm start` | Start the API |
| `npm run dev` | Restart the API on source changes |
| `npm run db:setup` | Ensure collections, indexes, and app role |
| `npm run db:setup -- --reset` | **Destructive:** drop all app database data, then recreate collections/indexes and the app role |
| `npm run db:seed` | Upsert reference data |
| `npm run db:seed -- --demo` | Also seed demonstration accounts and business data |
| `npm run db:verify-append-only` | Verify append-only role behavior |
| `npm run db:import-ccts -- <csv>` | Load CCTS source rows into `cctsstaging` |
| `npm run routes` | Print registered route table |
| `npm run lint:check` | Parse JavaScript files for syntax errors |
| `npm test` | Run unit and MongoDB integration suites |
| `npm run smoke` | Exercise a running API and its database role |

Configuration is centralized in `src/config/env.js`. The main settings are
`MONGO_URI`, `MONGO_ADMIN_URI`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`,
`DB_REPLICA_SET`, `JWT_SECRET`, `PORT`, `CORS_ORIGIN`, `TRUST_PROXY_HOPS`,
`SENSOR_KEY`, and the `DEMO_*` values. `.env.example` lists the supported
variables. Production must not use the development JWT secret or sample demo
admin password.

## 10. Tests and verification

Unit tests run without MongoDB. Integration tests require a transaction-capable
replica set and always use a dedicated database named `${DB_NAME}_test` (or
`TEST_DB_NAME` when set). They connect to that database using `MONGO_ADMIN_URI`
because cleanup must remove append-only records and drop the test database. The
integration suite therefore checks application logic and model guards under an
admin connection; app-role permissions are checked independently with
`npm run db:verify-append-only`. The regular database selected by `MONGO_URI` is
not reset by the integration suite.

The suite covers model constraints, service behavior, transaction invariants,
idempotent ingestion, FIFO credit movement, matching races, audit calls, and
append-only model protections. Database role enforcement is independently
checked with `npm run db:verify-append-only`.

## 11. Routes and frontend contract notes

There are 42 API routes. The frontend wire format remains camelCase JSON with
ObjectId strings. `POST /api/admin/partitions/ensure` is removed because MongoDB
has no PostgreSQL partition maintenance. `GET /api/reports/:id/audit` provides
the report audit view while preserving the documented route count. The detailed
request/response contract belongs in `04_FRONTEND_README.md`.

## 12. Migration constraints to preserve

- Allocate/retire the oldest eligible credit vintage first (FIFO).
- Keep SHA-256 sensor key hashing for high-entropy machine keys.
- Scope every authenticated company route to its company, including audit.
- Do not expose wallet data to auditors.
- Resolve a verifier on the server and use the configured internal verifier
  when the acting account has no accreditation of its own.
- Set `TRUST_PROXY_HOPS` to the exact trusted proxy count.
- Do not enable `mongoose.sanitizeFilter`; validated request data and the
  application's fixed query construction are the defense, while the setting
  breaks range queries, balance guards, and `$expr` filters.
- Never update/delete rows in the six append-only collections. Correct data by
  writing a compensating record where the domain supports one.
- Keep `legacy-postgres/` until the MongoDB migration is signed off.
