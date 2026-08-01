import { compilePostgresqlParameters } from './runtime-read-catalog.mjs';

const WRITE_CATALOG = Object.freeze([
  {
    id: 'audit_logs.insert',
    operation: 'insert',
    risk: 'append_only',
    parameters: [
      'id',
      'organizationId',
      'userId',
      'action',
      'targetType',
      'targetId',
      'metadataJson',
    ],
    sqliteSql: `
      INSERT INTO audit_logs
        (id, organization_id, user_id, action, target_type, target_id, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    expectedChanges: 1,
  },
]);

function normalizedSql(value) {
  const sql = String(value || '').replace(/\s+/g, ' ').trim();
  if (!sql) throw new Error('Runtime write SQL is required.');
  return sql.endsWith(';') ? sql.slice(0, -1).trim() : sql;
}

function validateSpec(spec) {
  if (!spec?.id || !['insert', 'update', 'delete'].includes(spec.operation)) {
    throw new Error('Runtime write catalog entry is invalid.');
  }
  if (!/^[a-z][a-z0-9_.-]{2,100}$/.test(spec.id)) {
    throw new Error(`Runtime write ID is invalid: ${spec.id}`);
  }
  if (!['append_only', 'mutable', 'destructive'].includes(spec.risk)) {
    throw new Error(`Runtime write risk is invalid: ${spec.id}`);
  }
  if (!Array.isArray(spec.parameters) || !spec.parameters.every((name) => /^[A-Za-z][A-Za-z0-9]*$/.test(name))) {
    throw new Error(`Runtime write parameters are invalid: ${spec.id}`);
  }
  const sqliteSql = normalizedSql(spec.sqliteSql);
  if (/--|\/\*/.test(sqliteSql) || sqliteSql.includes(';')) {
    throw new Error(`Runtime write SQL comments and multiple statements are not allowed: ${spec.id}`);
  }
  const keyword = sqliteSql.match(/^([A-Za-z]+)/)?.[1]?.toLowerCase();
  if (keyword !== spec.operation) {
    throw new Error(`Runtime write operation does not match SQL: ${spec.id}`);
  }
  const compiled = compilePostgresqlParameters(sqliteSql);
  if (compiled.parameterCount !== spec.parameters.length) {
    throw new Error(`Runtime write placeholder count mismatch: ${spec.id}`);
  }
  const expectedChanges = Number(spec.expectedChanges ?? 1);
  if (!Number.isInteger(expectedChanges) || expectedChanges < 0 || expectedChanges > 100000) {
    throw new Error(`Runtime write expectedChanges is invalid: ${spec.id}`);
  }
  return Object.freeze({
    ...spec,
    parameters: Object.freeze([...spec.parameters]),
    sqliteSql,
    postgresqlSql: compiled.sql,
    expectedChanges,
  });
}

const VALIDATED_CATALOG = Object.freeze(WRITE_CATALOG.map(validateSpec));
const CATALOG_MAP = new Map(VALIDATED_CATALOG.map((spec) => [spec.id, spec]));

export function runtimeWriteCatalog() {
  return VALIDATED_CATALOG.map((spec) => ({ ...spec, parameters: [...spec.parameters] }));
}

export function runtimeWriteSpec(id) {
  const spec = CATALOG_MAP.get(String(id));
  if (!spec) throw new Error(`Unknown runtime write catalog entry: ${id}`);
  return { ...spec, parameters: [...spec.parameters] };
}

export function validateRuntimeWriteParameters(specValue, parameters) {
  const spec = typeof specValue === 'string' ? runtimeWriteSpec(specValue) : specValue;
  if (!Array.isArray(parameters) || parameters.length !== spec.parameters.length) {
    throw new Error(`Runtime write parameter count mismatch: ${spec.id}`);
  }
  for (let index = 0; index < parameters.length; index += 1) {
    if (parameters[index] === undefined) {
      throw new Error(`Runtime write parameter ${spec.parameters[index]} is undefined: ${spec.id}`);
    }
  }
  return parameters;
}
