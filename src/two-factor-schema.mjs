/**
 * The tables behind the second factor, and nothing else.
 *
 * Split out of `two-factor.mjs` for one reason: `db.mjs` creates these as part
 * of the core schema, because sign-in reads them on every attempt and a
 * database missing them is one where the second factor silently stops being
 * asked for. A security check that fails open when a migration has not run is
 * worse than one that is absent.
 *
 * Importing the whole two-factor module from `db.mjs` to get the DDL pulled in
 * the secrets vault, which imports `db.mjs` back — a cycle that left half the
 * application loading before the database was open. This file imports nothing,
 * which is true of schema and keeps it that way.
 */

export function migrateTwoFactor(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_two_factor (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      -- Encrypted with the instance's secrets key. A database backup is a file
      -- that leaves the building; a TOTP secret in it is a second factor
      -- somebody else can compute.
      secret_ciphertext TEXT NOT NULL,
      -- Null until a code from that secret has been entered. A row exists
      -- during enrolment and does not mean 2FA is on.
      confirmed_at TEXT,
      -- The last step this account used, so a code cannot be replayed inside
      -- its own thirty seconds by anybody watching the wire.
      last_step INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS user_recovery_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      -- The hash, never the code. These are the credential that gets somebody
      -- back in; stored readable, they are ten passwords in a table.
      code_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON user_recovery_codes(user_id);
    -- The gap between "the password was right" and "the code was right".
    --
    -- It has to be a stored, short-lived, single-use thing rather than a flag
    -- on the session, because there is no session yet — issuing one and
    -- marking it half-signed-in means every route now has to remember to check
    -- that flag, and the one that forgets is the hole.
    CREATE TABLE IF NOT EXISTS two_factor_challenges (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_two_factor_challenges_expiry ON two_factor_challenges(expires_at);
  `);
}
