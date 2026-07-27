import path from 'node:path';
import { runPostgresqlOfflineImport } from '../src/postgresql-offline-import.mjs';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(name) {
  const value = argument(name);
  if (!value) {
    const error = new Error(`Missing required argument: ${name}`);
    error.code = 'POSTGRESQL_IMPORT_ARGUMENT_REQUIRED';
    throw error;
  }
  return value;
}

function safeCode(error) {
  const code = String(error?.code || '');
  return /^[A-Z0-9_]{3,100}$/.test(code) ? code : 'POSTGRESQL_OFFLINE_IMPORT_FAILED';
}

try {
  const result = await runPostgresqlOfflineImport({
    exportPath: required('--input'),
    confirmation: required('--confirm'),
    operator: required('--operator'),
    outputDirectory: path.resolve(argument('--output-directory', './data/database-migration/postgresql-live-import')),
    batchSize: Number(argument('--batch-size', '250')),
    maxParameters: Number(argument('--max-parameters', '60000')),
    scanBatchSize: Number(argument('--scan-batch-size', '1000')),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: 'failed',
    error: {
      code: safeCode(error),
      message: String(error?.message || 'PostgreSQL offline import failed.').slice(0, 500),
      ...(error?.sqlState ? { sqlState: error.sqlState } : {}),
      ...(error?.rollbackFailed ? { rollbackFailed: true, rollbackCode: error.rollbackCode } : {}),
      ...(error?.closeWarning ? { closeWarning: error.closeWarning } : {}),
    },
  }, null, 2)}\n`);
  process.exitCode = 1;
}
