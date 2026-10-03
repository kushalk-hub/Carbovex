# Archived: the PostgreSQL implementation

**This directory is not used. Do not run it. It is kept only for reference.**

The project was originally specified and built against PostgreSQL
(`01_DATABASE_AND_BACKEND (1).md`, at the repository root, is a PostgreSQL
design document). Those eight files are a complete, reviewed PostgreSQL
implementation: schema and indexes, views, stored functions, triggers, roles and
RLS, reference seed, and demo seed.

The target database was later changed to **MongoDB**, so the live implementation
now lives in:

- `backend/src/models/` — Mongoose schemas, one per collection
- `backend/src/services/` — the logic that used to live in SQL functions,
  triggers and views
- `backend/src/db/connect.js` — connection and transaction helpers

## Why this was archived rather than deleted

The repository has no commits and `carbon-exchange/` was untracked, so deleting
these files would have been unrecoverable. The trade-off logic in
`04_functions.sql` and the integrity rules in `05_triggers.sql` are also worth
reading as a reference when checking that the MongoDB services behave the same
way — see "what moved where" below.

## What moved where

| PostgreSQL | MongoDB equivalent |
|---|---|
| `01_schema.sql` tables | `backend/src/models/*.js`, one file per collection |
| `CHECK` constraints | Mongoose schema validators (`enum`, `min`, custom `validate`) |
| `UNIQUE` constraints | Unique indexes declared in the schema; created by `scripts/setup.js` |
| `02_indexes.sql` | Index declarations on the Mongoose schemas |
| `03_views.sql` views | Aggregation pipelines in `backend/src/services/aggregations.js` |
| `03_views.sql` materialised view | `refreshMonthlyEmission()` in `services/pricing.js`, same nightly refresh |
| `04_functions.sql` trading | `services/trading.js` — order matching and execution |
| `04_functions.sql` retirement | `services/credits.js` — `retireCredits` |
| `04_functions.sql` compliance | `services/compliance.js` — `runPeriod` |
| `04_functions.sql` expiry | `services/credits.js` — `expireCredits` |
| `04_functions.sql` price history | `services/pricing.js` — `refreshPriceHistory` |
| `04_functions.sql` partition upkeep | Index-backed range query on `readingTs`; see the note below |
| `05_triggers.sql` balance maintenance | Service-layer updates inside the owning transaction |
| `05_triggers.sql` append-only guards | `models/creditLedger.js` write guards + a database role without update rights |
| `05_triggers.sql` audit trigger | `services/audit.js`, called explicitly by the services that mutate |
| `05_triggers.sql` alert trigger | `services/readings.js` — `maybeAlert` after each total update |
| `06_roles.sql` RLS | `middleware/auth.js` authorisation, which the API already used |
| `LISTEN`/`NOTIFY` realtime | Change streams where available, explicit emits otherwise |

## The one place this is a genuine downgrade

PostgreSQL enforced the credit and cash invariants in the database, so they held
no matter what wrote to it — including `psql`, a migration, or a second service.
MongoDB cannot do that: invariants live in application code, so anything that
writes to the database outside the API can break the ledger.

Three things are done to keep the property as close as possible, and all three
are documented in the rewritten backend spec:

1. The trading and retirement paths run in **multi-document transactions**, so a
   partial write still rolls back.
2. `creditLedger` and `emissionReading` reject updates and deletes in the model
   layer, so the API cannot mutate history.
3. `scripts/setup.js` creates a database user `carbonx_app` that is granted
   `find` and `insert` on the append-only collections but **not** `update` or
   `remove`. If the API's connection string uses that user, the append-only
   guarantee stops depending on application code alone.

Anything beyond that — a shell connected to the same database, a second service,
a migration script — is a real risk that the PostgreSQL version did not have.
