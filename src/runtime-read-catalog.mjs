const READ_CATALOG = Object.freeze([
  {
    id: 'auth.user_core_by_email',
    mode: 'one',
    parameters: ['email'],
    sqliteSql: `
      SELECT id, email, display_name AS displayName, password_hash AS passwordHash
      FROM users WHERE email = ?
    `,
    sampleSql: `SELECT email FROM users ORDER BY id LIMIT ?`,
    sampleParameters: ['email'],
  },
  {
    id: 'auth.session_user_by_hash',
    mode: 'one',
    parameters: ['tokenHash'],
    sqliteSql: `
      SELECT u.id, u.email, u.display_name AS displayName, s.expires_at AS expiresAt
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `,
    sampleSql: `SELECT token_hash AS tokenHash FROM sessions ORDER BY created_at, token_hash LIMIT ?`,
    sampleParameters: ['tokenHash'],
  },
  {
    id: 'tokens.personal_access_token_by_hash',
    mode: 'one',
    parameters: ['tokenHash'],
    sqliteSql: `
      SELECT p.id, p.user_id AS userId, p.name, p.scopes_json AS scopesJson,
        p.expires_at AS expiresAt, p.revoked_at AS revokedAt,
        u.email, u.display_name AS displayName
      FROM personal_access_tokens p JOIN users u ON u.id = p.user_id
      WHERE p.token_hash = ?
    `,
    sampleSql: `SELECT token_hash AS tokenHash FROM personal_access_tokens ORDER BY created_at, id LIMIT ?`,
    sampleParameters: ['tokenHash'],
  },
  {
    id: 'tokens.list_by_user',
    mode: 'many',
    parameters: ['userId'],
    sqliteSql: `
      SELECT id, name, token_prefix AS tokenPrefix, scopes_json AS scopesJson,
        expires_at AS expiresAt, last_used_at AS lastUsedAt,
        revoked_at AS revokedAt, created_at AS createdAt
      FROM personal_access_tokens
      WHERE user_id = ?
      ORDER BY created_at DESC, id
    `,
    sampleSql: `SELECT DISTINCT user_id AS userId FROM personal_access_tokens ORDER BY user_id LIMIT ?`,
    sampleParameters: ['userId'],
  },
  {
    id: 'organizations.access_by_slug_and_user',
    mode: 'one',
    parameters: ['orgSlug', 'userId'],
    sqliteSql: `
      SELECT o.id, o.slug, o.name, o.plan, om.role
      FROM organizations o JOIN org_members om ON om.organization_id = o.id
      WHERE o.slug = ? AND om.user_id = ?
    `,
    sampleSql: `
      SELECT o.slug AS orgSlug, om.user_id AS userId
      FROM org_members om JOIN organizations o ON o.id = om.organization_id
      ORDER BY o.slug, om.user_id LIMIT ?
    `,
    sampleParameters: ['orgSlug', 'userId'],
  },
  {
    id: 'repositories.by_slug',
    mode: 'one',
    parameters: ['orgSlug', 'repoSlug'],
    sqliteSql: `
      SELECT r.id, r.organization_id AS organizationId, r.slug, r.name, r.description,
        r.visibility, r.default_branch AS defaultBranch, r.archived_at AS archivedAt,
        r.deleted_at AS deletedAt, r.created_by AS createdBy,
        r.created_at AS createdAt, r.updated_at AS updatedAt,
        o.slug AS orgSlug, o.name AS orgName
      FROM repositories r JOIN organizations o ON o.id = r.organization_id
      WHERE o.slug = ? AND r.slug = ? AND r.deleted_at IS NULL
    `,
    sampleSql: `
      SELECT o.slug AS orgSlug, r.slug AS repoSlug
      FROM repositories r JOIN organizations o ON o.id = r.organization_id
      WHERE r.deleted_at IS NULL
      ORDER BY o.slug, r.slug LIMIT ?
    `,
    sampleParameters: ['orgSlug', 'repoSlug'],
  },
  {
    id: 'repository_access.membership',
    mode: 'one',
    parameters: ['organizationId', 'userId'],
    sqliteSql: `
      SELECT role FROM org_members WHERE organization_id = ? AND user_id = ?
    `,
    sampleSql: `
      SELECT organization_id AS organizationId, user_id AS userId
      FROM org_members ORDER BY organization_id, user_id LIMIT ?
    `,
    sampleParameters: ['organizationId', 'userId'],
  },
  {
    id: 'repository_access.direct_permission',
    mode: 'one',
    parameters: ['repositoryId', 'userId'],
    sqliteSql: `
      SELECT permission FROM repository_collaborators WHERE repository_id = ? AND user_id = ?
    `,
    sampleSql: `
      SELECT repository_id AS repositoryId, user_id AS userId
      FROM repository_collaborators ORDER BY repository_id, user_id LIMIT ?
    `,
    sampleParameters: ['repositoryId', 'userId'],
  },
  {
    id: 'repository_access.team_sources',
    mode: 'many',
    parameters: ['userId', 'repositoryId'],
    sqliteSql: `
      SELECT t.id, t.slug, t.name, g.permission, tm.role AS teamRole
      FROM repository_team_grants g
      JOIN teams t ON t.id = g.team_id
      JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
      WHERE g.repository_id = ?
      ORDER BY t.name, t.id
    `,
    sampleSql: `
      SELECT tm.user_id AS userId, g.repository_id AS repositoryId
      FROM repository_team_grants g
      JOIN team_members tm ON tm.team_id = g.team_id
      ORDER BY tm.user_id, g.repository_id LIMIT ?
    `,
    sampleParameters: ['userId', 'repositoryId'],
  },
]);

function normalizedSql(value) {
  const sql = String(value || '').replace(/\s+/g, ' ').trim();
  if (!sql) throw new Error('Runtime read SQL is required.');
  return sql.endsWith(';') ? sql.slice(0, -1).trim() : sql;
}

export function compilePostgresqlParameters(sqlValue) {
  const sql = normalizedSql(sqlValue);
  if (/--|\/\*/.test(sql) || sql.includes(';')) throw new Error('Runtime read SQL comments and multiple statements are not allowed.');
  let output = '';
  let parameterCount = 0;
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      output += character;
      if (character === quote) {
        if (sql[index + 1] === quote) output += sql[++index];
        else quote = null;
      } else if (character === '\\' && quote === '\'' && index + 1 < sql.length) {
        output += sql[++index];
      }
      continue;
    }
    if (character === '\'' || character === '"') {
      quote = character;
      output += character;
      continue;
    }
    if (character === '?') {
      parameterCount += 1;
      output += `$${parameterCount}`;
      continue;
    }
    output += character;
  }
  if (quote) throw new Error('Runtime read SQL contains an unterminated quote.');
  return { sql: output, parameterCount };
}

function validateSpec(spec) {
  if (!spec?.id || !['one', 'many'].includes(spec.mode)) throw new Error('Runtime read catalog entry is invalid.');
  if (!Array.isArray(spec.parameters) || !Array.isArray(spec.sampleParameters)) throw new Error(`Runtime read parameters are invalid: ${spec.id}`);
  const compiled = compilePostgresqlParameters(spec.sqliteSql);
  if (compiled.parameterCount !== spec.parameters.length) throw new Error(`Runtime read placeholder count mismatch: ${spec.id}`);
  const sample = compilePostgresqlParameters(spec.sampleSql);
  if (sample.parameterCount !== 1) throw new Error(`Runtime read sample query must have one limit placeholder: ${spec.id}`);
  return {
    ...spec,
    sqliteSql: normalizedSql(spec.sqliteSql),
    postgresqlSql: compiled.sql,
    sampleSql: normalizedSql(spec.sampleSql),
  };
}

const VALIDATED_CATALOG = Object.freeze(READ_CATALOG.map(validateSpec));
const CATALOG_MAP = new Map(VALIDATED_CATALOG.map((spec) => [spec.id, spec]));

export function runtimeReadCatalog() {
  return VALIDATED_CATALOG.map((spec) => ({ ...spec, parameters: [...spec.parameters], sampleParameters: [...spec.sampleParameters] }));
}

export function runtimeReadSpec(id) {
  const spec = CATALOG_MAP.get(String(id));
  if (!spec) throw new Error(`Unknown runtime read catalog entry: ${id}`);
  return { ...spec, parameters: [...spec.parameters], sampleParameters: [...spec.sampleParameters] };
}

export function parametersFromSample(specValue, sample) {
  const spec = typeof specValue === 'string' ? runtimeReadSpec(specValue) : specValue;
  if (!sample || typeof sample !== 'object') throw new Error(`Runtime read sample is invalid: ${spec.id}`);
  return spec.sampleParameters.map((name) => {
    if (!(name in sample)) throw new Error(`Runtime read sample is missing ${name}: ${spec.id}`);
    return sample[name];
  });
}
