import { loadDatabaseSelection, validatePostgresqlReadiness } from '../src/database-selection.mjs';

try {
  const selection = loadDatabaseSelection();
  if (selection.driver === 'sqlite') {
    console.log(`✓ Metadata database: SQLite runtime (${selection.driver})`);
    process.exit(0);
  }
  const readiness = validatePostgresqlReadiness(selection);
  const status = readiness.ready ? 'readiness marker valid' : `not ready: ${readiness.reason}`;
  console.error(`✗ Metadata database: PostgreSQL selected (${status}), but the PostgreSQL runtime driver/import stage is not delivered. Keep KUKGIT_DATABASE_DRIVER=sqlite.`);
  process.exit(1);
} catch (error) {
  console.error(`✗ Metadata database: ${error.message}`);
  process.exit(1);
}
