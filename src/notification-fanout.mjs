export const FANOUT_DEFAULTS = {
  // Fast enough that a badge moves while the user is still looking at the page,
  // slow enough that an idle instance costs one indexed lookup every half
  // second. There is no push in SQLite, so this is the whole latency budget.
  intervalMs: 400,
  // Rows are a delivery hint, not a record. The inbox is what anybody reads
  // later, so a row that nobody polled within this window is simply stale.
  retentionMinutes: 10,
  // A burst is bounded so one instance recovering from a pause cannot deliver
  // ten thousand events into a socket in a single tick.
  maxPerTick: 500,
};

/**
 * Creates the fan-out log and the triggers that write to it.
 *
 * The triggers are **permanent**, not `TEMP`. A `TEMP` trigger only fires for
 * writes made on the connection that created it, which is exactly why a
 * notification written by one instance never reached a socket held by another.
 *
 * They are plain SQL with no custom function, so every connection that opens
 * this database — a backup, a script, the doctor — can still write a
 * notification. A trigger that called a function only the server registers would
 * turn `npm run seed` into a crash.
 */
export function migrateNotificationFanout(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_fanout (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      notification_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_notification_fanout_created ON notification_fanout(created_at);

    DROP TRIGGER IF EXISTS kg_notification_fanout_insert;
    DROP TRIGGER IF EXISTS kg_notification_fanout_read;
    CREATE TRIGGER kg_notification_fanout_insert
      AFTER INSERT ON notifications
      BEGIN
        INSERT INTO notification_fanout (user_id, reason, notification_id)
        VALUES (NEW.user_id, 'created', NEW.id);
      END;
    CREATE TRIGGER kg_notification_fanout_read
      AFTER UPDATE OF read_at ON notifications
      WHEN COALESCE(OLD.read_at, '') <> COALESCE(NEW.read_at, '')
      BEGIN
        INSERT INTO notification_fanout (user_id, reason, notification_id)
        VALUES (NEW.user_id, CASE WHEN NEW.read_at IS NULL THEN 'unread' ELSE 'read' END, NEW.id);
      END;
  `);
}

export function latestFanoutId(db) {
  return Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM notification_fanout').get().id);
}

export function readFanoutSince(db, cursor, limit = FANOUT_DEFAULTS.maxPerTick) {
  return db.prepare(`
    SELECT id, user_id AS userId, reason, notification_id AS notificationId
    FROM notification_fanout WHERE id > ? ORDER BY id LIMIT ?
  `).all(Number(cursor) || 0, limit);
}

/**
 * Deletes fan-out rows nobody will poll again.
 *
 * Bounded by age rather than by cursor, because no single instance knows what
 * the others have read. Ten minutes is far longer than any instance's poll
 * interval and far shorter than the row is worth keeping — the notification
 * itself lives in the inbox and is not affected by this at all.
 */
export function pruneFanout(db, { retentionMinutes = FANOUT_DEFAULTS.retentionMinutes } = {}) {
  return db.prepare("DELETE FROM notification_fanout WHERE created_at < datetime('now', ?)")
    .run(`-${Math.max(1, Math.round(retentionMinutes))} minutes`).changes;
}

/**
 * Polls the fan-out log and hands new rows to the socket layer.
 *
 * The cursor starts at the newest row and is held in memory only. An instance
 * that has just started must not replay yesterday's notifications into sockets
 * that connected a moment ago: a client fetches its inbox on connect, so
 * anything from before it was listening is already on screen. Persisting the
 * cursor would turn every restart into a burst of stale badges.
 *
 * A failing poll is logged and retried on the next tick, never thrown. The
 * socket is an accelerator; the inbox is the delivery guarantee, and a fan-out
 * outage must degrade to "the badge updates on reload" rather than to an error.
 */
export function createFanoutReader(db, {
  intervalMs = FANOUT_DEFAULTS.intervalMs,
  maxPerTick = FANOUT_DEFAULTS.maxPerTick,
  onEvents,
  autoStart = true,
  retentionMinutes = FANOUT_DEFAULTS.retentionMinutes,
  pruneEveryTicks = Math.max(1, Math.round((5 * 60_000) / (intervalMs || FANOUT_DEFAULTS.intervalMs))),
} = {}) {
  let cursor = latestFanoutId(db);
  let stopped = false;
  let lastError = null;
  let delivered = 0;

  let ticks = 0;
  const tick = () => {
    if (stopped) return { delivered: 0 };
    try {
      // Pruning needs no lease. Deleting by age is idempotent, so two instances
      // doing it in the same minute produce the same result as one — and a lease
      // here would mean a single instance's failure stops the table growing.
      ticks += 1;
      if (ticks % pruneEveryTicks === 0) pruneFanout(db, { retentionMinutes });
      const rows = readFanoutSince(db, cursor, maxPerTick);
      if (!rows.length) return { delivered: 0 };
      cursor = rows[rows.length - 1].id;
      delivered += rows.length;
      onEvents?.(rows);
      return { delivered: rows.length };
    } catch (error) {
      lastError = error.message;
      console.error('KukGit notification fan-out', error.message);
      return { delivered: 0, error: error.message };
    }
  };

  const timer = autoStart ? setInterval(tick, intervalMs) : null;
  timer?.unref?.();

  return {
    tick,
    cursor: () => cursor,
    stats: () => ({ cursor, delivered, lastError }),
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
