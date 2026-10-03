# CarbonX backend

The backend is an Express API backed by MongoDB and Mongoose. Its system
specification, including the collection catalog, transaction rules, security
model, and operational procedures, is in [03_BACKEND_README.md](../03_BACKEND_README.md).

## Quick start

Requirements: Node.js 20 or newer and a MongoDB replica set (transactions are
required for trading, credit movements, and emission ingestion).

```powershell
cd backend
npm install
Copy-Item .env.example .env 
npm run mongo:test-rs       
npm run db:setup             
npm run db:seed -- --demo    
npm start
```

Useful commands:

```powershell
npm run lint:check
npm run routes
npm test
npm run db:verify-append-only
npm run smoke               # run while the API is up
npm run db:import-ccts -- ..\data\ccts745.csv
```

The integration suite uses `MONGO_ADMIN_URI` against a separate `${DB_NAME}_test`
database (override with `TEST_DB_NAME`) because it resets data during cleanup.
Append-only permissions are verified independently by `db:verify-append-only`.
Keep admin credentials local; a regular server run connects only as the
restricted application user.
