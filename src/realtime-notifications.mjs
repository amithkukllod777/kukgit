import crypto from 'node:crypto';
import { currentUser } from './auth.mjs';
import {
  decryptAuthKitSecret,
  encryptAuthKitSecret,
  linkAuthKitUser,
  requestAuthKit,
} from './authkit-identity.mjs';
import { hashToken, httpError, parseCookies } from './security.mjs';
import { createFanoutReader, FANOUT_DEFAULTS, migrateNotificationFanout } from './notification-fanout.mjs';

const SOCKET_PATH = '/api/notifications/socket';
const MAX_SERVER_BUFFER_BYTES = 1024 * 1024;

function statusText(status) {
  return ({ 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 503: 'Service Unavailable' })[status] || 'Error';
}

function rejectUpgrade(socket, status, message) {
  const body = `${message}\n`;
  socket.end([
    `HTTP/1.1 ${status} ${statusText(status)}`,
    'Connection: close',
    'Cache-Control: no-store',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'));
}

function sameOrigin(req, config) {
  const origin = String(req.headers.origin || '');
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(config.baseUrl).origin; }
  catch { return false; }
}

function validWebSocketKey(value) {
  try { return typeof value === 'string' && Buffer.from(value, 'base64').length === 16; }
  catch { return false; }
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > 65535) throw new Error('WebSocket payload exceeds server frame limit.');
  if (body.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  const header = Buffer.alloc(4);
  header[0] = 0x80 | opcode;
  header[1] = 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function encodeClose(code, reason = '') {
  const text = Buffer.from(String(reason).slice(0, 120));
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return encodeFrame(0x8, payload);
}

function authKitSession(db, req) {
  const token = parseCookies(req.headers.cookie).kukgit_session;
  if (!token) return null;
  const tokenHash = hashToken(token);
  return db.prepare(`
    SELECT s.token_hash AS tokenHash, s.user_id AS userId, s.expires_at AS expiresAt,
      s.authkit_access_ciphertext AS accessCiphertext,
      s.authkit_refresh_ciphertext AS refreshCiphertext,
      s.authkit_refresh_expires_at AS refreshExpiresAt,
      s.authkit_sid AS authkitSid,
      u.id, u.email, u.display_name AS displayName, u.avatar_url AS avatarUrl,
      u.kuklabs_user_id AS kuklabsUserId, u.auth_source AS authSource,
      u.email_verified AS emailVerified, u.phone
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.auth_mode = 'authkit'
  `).get(tokenHash);
}

function revokeAuthKitBridge(db, session) {
  if (session?.tokenHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.tokenHash);
}

function authKitBundle(payload) {
  const accessToken = String(payload?.access_token || '');
  const refreshToken = String(payload?.refresh_token || '');
  const expiresIn = Number(payload?.expires_in || 0);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw httpError(502, 'AuthKit returned an invalid token bundle.', 'AUTHKIT_TOKEN_BUNDLE_INVALID');
  }
  return { accessToken, refreshToken, accessExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
}

async function refreshAuthKitSocketSession(db, config, session) {
  const refreshToken = decryptAuthKitSecret(config, session.refreshCiphertext, session.tokenHash);
  const { response, payload } = await requestAuthKit(config, '/v1/auth/token/refresh', {
    method: 'POST',
    body: { refresh_token: refreshToken },
  });
  if (!response.ok) {
    revokeAuthKitBridge(db, session);
    throw httpError(401, payload?.message || 'Kuklabs Account session expired.', 'AUTHKIT_SESSION_EXPIRED');
  }
  const tokens = authKitBundle(payload);
  const linked = linkAuthKitUser(db, payload.user);
  if (linked.id !== session.userId || linked.kuklabsUserId !== session.kuklabsUserId) {
    revokeAuthKitBridge(db, session);
    throw httpError(409, 'AuthKit session identity changed unexpectedly.', 'AUTHKIT_SESSION_IDENTITY_CHANGED');
  }
  const refreshExpiresAt = new Date(Date.now() + config.authkitRefreshTtlDays * 86400000).toISOString();
  db.prepare(`
    UPDATE sessions SET authkit_access_ciphertext = ?, authkit_refresh_ciphertext = ?,
      authkit_access_expires_at = ?, authkit_refresh_expires_at = ?, expires_at = ?,
      last_validated_at = CURRENT_TIMESTAMP
    WHERE token_hash = ?
  `).run(
    encryptAuthKitSecret(config, tokens.accessToken, session.tokenHash),
    encryptAuthKitSecret(config, tokens.refreshToken, session.tokenHash),
    tokens.accessExpiresAt,
    refreshExpiresAt,
    refreshExpiresAt,
    session.tokenHash,
  );
  return tokens.accessToken;
}

async function validateAuthKitSocketUser(db, config, req) {
  const session = authKitSession(db, req);
  if (!session) return null;
  if (new Date(session.refreshExpiresAt || session.expiresAt).getTime() <= Date.now()) {
    revokeAuthKitBridge(db, session);
    return null;
  }

  let accessToken = decryptAuthKitSecret(config, session.accessCiphertext, session.tokenHash);
  let me = await requestAuthKit(config, '/v1/auth/me', { accessToken });
  if (me.response.status === 401) {
    accessToken = await refreshAuthKitSocketSession(db, config, session);
    me = await requestAuthKit(config, '/v1/auth/me', { accessToken });
  }
  if (me.response.status === 401) {
    revokeAuthKitBridge(db, session);
    return null;
  }
  if (!me.response.ok) throw httpError(503, 'Kuklabs Account validation failed.', 'AUTHKIT_VALIDATION_FAILED');

  const linked = linkAuthKitUser(db, me.payload?.user ?? me.payload);
  if (linked.id !== session.userId || linked.kuklabsUserId !== session.kuklabsUserId) {
    revokeAuthKitBridge(db, session);
    throw httpError(409, 'Kuklabs Account does not match this KukGit session.', 'AUTHKIT_SESSION_IDENTITY_MISMATCH');
  }

  const product = await requestAuthKit(config, `/v1/auth/products/${encodeURIComponent(config.authkitProductId)}/access`, { accessToken });
  if (product.response.status === 401) {
    revokeAuthKitBridge(db, session);
    return null;
  }
  if (!product.response.ok || product.payload?.access === false || ['blocked', 'inactive', 'suspended'].includes(product.payload?.status)) {
    throw httpError(403, 'Your Kuklabs Account does not have access to KukGit.', 'KUKGIT_PRODUCT_ACCESS_DENIED');
  }

  const centralSessions = await requestAuthKit(config, '/v1/auth/sessions', { accessToken });
  if (centralSessions.response.status === 401) {
    revokeAuthKitBridge(db, session);
    return null;
  }
  if (!centralSessions.response.ok) throw httpError(503, 'Kuklabs Account session validation failed.', 'AUTHKIT_SESSION_CHECK_FAILED');
  const current = Array.isArray(centralSessions.payload?.sessions)
    ? centralSessions.payload.sessions.find((item) => item?.current === true)
    : null;
  if (!current || (session.authkitSid && current.id !== session.authkitSid)) {
    revokeAuthKitBridge(db, session);
    return null;
  }
  db.prepare('UPDATE sessions SET last_validated_at = CURRENT_TIMESTAMP WHERE token_hash = ?').run(session.tokenHash);
  return linked;
}

async function authenticateSocket(db, config, request) {
  if (config.authMode === 'authkit') return validateAuthKitSocketUser(db, config, request);
  return currentUser(db, request);
}

function unreadCount(db, userId) {
  try {
    return Number(db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).count);
  } catch {
    return 0;
  }
}

function createFrameParser(client, { maxMessageBytes, onText, onPong, onClose }) {
  return function parse(chunk) {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    if (client.buffer.length > MAX_SERVER_BUFFER_BYTES) return onClose(1009, 'Buffered data limit exceeded.');
    while (client.buffer.length >= 2) {
      const first = client.buffer[0];
      const second = client.buffer[1];
      const fin = Boolean(first & 0x80);
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (!fin || rsv || !masked) return onClose(1002, 'Unsupported WebSocket frame.');
      if (length === 126) {
        if (client.buffer.length < 4) return;
        length = client.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        return onClose(1009, 'WebSocket frame is too large.');
      }
      if (length > maxMessageBytes) return onClose(1009, 'WebSocket message is too large.');
      if (client.buffer.length < offset + 4 + length) return;
      const mask = client.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
      client.buffer = client.buffer.subarray(offset + length);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

      if (opcode === 0x8) return onClose(1000, 'Client closed.');
      if (opcode === 0x9) {
        if (!client.closed) client.socket.write(encodeFrame(0xA, payload));
        continue;
      }
      if (opcode === 0xA) {
        onPong();
        continue;
      }
      if (opcode !== 0x1) return onClose(1003, 'Only text control messages are supported.');
      let message;
      try { message = JSON.parse(payload.toString('utf8')); }
      catch { return onClose(1007, 'Invalid JSON message.'); }
      onText(message);
    }
  };
}

export function createRealtimeNotificationServer({ server, config, db, options = {} }) {
  const clientsByUser = new Map();
  const allClients = new Set();
  const pendingUsers = new Map();
  let pendingFlush = false;
  let sequence = 0;
  let stopped = false;
  const stats = {
    startedAt: new Date().toISOString(),
    accepted: 0,
    rejected: 0,
    eventsPublished: 0,
    connectionsClosed: 0,
  };
  const heartbeatMs = Math.max(1000, Number(options.heartbeatMs ?? config.realtimeHeartbeatMs ?? 25000));
  const revalidateMs = Math.max(1000, Number(options.revalidateMs ?? config.realtimeAuthRevalidateMs ?? 60000));
  const maxPerUser = Math.max(1, Math.min(Number(options.maxPerUser ?? config.realtimeMaxConnectionsPerUser ?? 10), 50));
  const maxTotal = Math.max(10, Math.min(Number(options.maxTotal ?? config.realtimeMaxConnections ?? 5000), 50000));
  const maxMessageBytes = Math.max(256, Math.min(Number(options.maxMessageBytes ?? config.realtimeMaxMessageBytes ?? 4096), 65535));

  function send(client, payload) {
    if (client.closed || client.socket.destroyed) return false;
    const text = JSON.stringify(payload);
    if (Buffer.byteLength(text) > 65535 || client.socket.writableLength > MAX_SERVER_BUFFER_BYTES) {
      close(client, 1009, 'Connection buffer limit exceeded.');
      return false;
    }
    client.socket.write(encodeFrame(0x1, text));
    return true;
  }

  function remove(client) {
    if (client.closed) return;
    client.closed = true;
    allClients.delete(client);
    const set = clientsByUser.get(client.userId);
    set?.delete(client);
    if (set && !set.size) clientsByUser.delete(client.userId);
    stats.connectionsClosed += 1;
  }

  function close(client, code = 1000, reason = '') {
    if (client.closed) return;
    try { client.socket.write(encodeClose(code, reason)); } catch {}
    remove(client);
    client.socket.end();
    setTimeout(() => client.socket.destroy(), 250).unref();
  }

  function snapshot(client, reason = 'connected') {
    send(client, {
      type: 'notifications.snapshot',
      sequence,
      reason,
      unreadCount: unreadCount(db, client.userId),
      serverTime: new Date().toISOString(),
    });
  }

  function flushPending() {
    pendingFlush = false;
    for (const [userId, change] of pendingUsers) {
      pendingUsers.delete(userId);
      sequence += 1;
      const event = {
        type: 'notifications.changed',
        sequence,
        reason: change.reasons.size === 1 ? [...change.reasons][0] : 'changed',
        notificationId: change.ids.size === 1 ? [...change.ids][0] : null,
        unreadCount: unreadCount(db, userId),
        serverTime: new Date().toISOString(),
      };
      for (const client of clientsByUser.get(userId) || []) send(client, event);
      stats.eventsPublished += 1;
    }
  }

  function queueDatabaseEvent(userId, reason, notificationId) {
    if (!userId) return 0;
    const current = pendingUsers.get(String(userId)) || { reasons: new Set(), ids: new Set() };
    current.reasons.add(String(reason || 'changed'));
    if (notificationId) current.ids.add(String(notificationId));
    pendingUsers.set(String(userId), current);
    if (!pendingFlush) {
      pendingFlush = true;
      queueMicrotask(flushPending);
    }
    return 0;
  }

  // Delivery goes through a durable fan-out log rather than an in-process
  // trigger. A `TEMP` trigger only fires for writes made on the connection that
  // created it, so a notification written by one instance never reached a socket
  // held by another — the inbox stayed correct, but the badge did not move until
  // the page was reloaded.
  //
  // Every instance now polls the same log, including the one that wrote the row.
  // One delivery path rather than two means there is nothing to keep in sync and
  // no way for local behaviour to diverge from what everyone else sees.
  migrateNotificationFanout(db);

  const fanout = createFanoutReader(db, {
    intervalMs: options.fanoutIntervalMs ?? FANOUT_DEFAULTS.intervalMs,
    onEvents: (rows) => {
      for (const row of rows) queueDatabaseEvent(row.userId, row.reason, row.notificationId);
    },
  });

  async function revalidate(client) {
    if (client.closed || client.authCheck) return;
    client.authCheck = true;
    try {
      const user = await authenticateSocket(db, config, client.authRequest);
      if (!user || user.id !== client.userId) return close(client, 1008, 'Session is no longer valid.');
      client.nextAuthCheck = Date.now() + revalidateMs;
    } catch (error) {
      const status = Number(error?.status) || 503;
      close(client, status === 401 || status === 403 ? 1008 : 1011, 'Session validation failed.');
    } finally {
      client.authCheck = false;
    }
  }

  const heartbeat = setInterval(() => {
    for (const client of allClients) {
      if (client.closed) continue;
      if (client.awaitingPong) {
        close(client, 1001, 'Heartbeat timeout.');
        continue;
      }
      client.awaitingPong = true;
      try { client.socket.write(encodeFrame(0x9)); }
      catch { close(client, 1001, 'Connection lost.'); }
      if (Date.now() >= client.nextAuthCheck) void revalidate(client);
    }
  }, heartbeatMs);
  heartbeat.unref();

  async function onUpgrade(req, socket, head) {
    if (stopped) return rejectUpgrade(socket, 503, 'Real-time notifications are shutting down.');
    let url;
    try { url = new URL(req.url, config.baseUrl); }
    catch { return rejectUpgrade(socket, 400, 'Invalid WebSocket request.'); }
    if (url.pathname !== SOCKET_PATH) return socket.destroy();
    if (!sameOrigin(req, config)) {
      stats.rejected += 1;
      return rejectUpgrade(socket, 403, 'WebSocket origin is not allowed.');
    }
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' ||
        !String(req.headers.connection || '').toLowerCase().split(',').map((value) => value.trim()).includes('upgrade') ||
        String(req.headers['sec-websocket-version'] || '') !== '13' ||
        !validWebSocketKey(req.headers['sec-websocket-key'])) {
      stats.rejected += 1;
      return rejectUpgrade(socket, 400, 'Invalid WebSocket upgrade request.');
    }

    const authRequest = {
      method: 'GET',
      headers: {
        cookie: String(req.headers.cookie || ''),
        origin: String(req.headers.origin || ''),
      },
    };
    let user;
    try { user = await authenticateSocket(db, config, authRequest); }
    catch (error) {
      stats.rejected += 1;
      return rejectUpgrade(socket, Number(error?.status) === 403 ? 403 : 503, 'WebSocket authentication failed.');
    }
    if (!user) {
      stats.rejected += 1;
      return rejectUpgrade(socket, 401, 'Sign in to receive notifications.');
    }
    const existing = clientsByUser.get(user.id);
    if ((existing?.size || 0) >= maxPerUser || allClients.size >= maxTotal) {
      stats.rejected += 1;
      return rejectUpgrade(socket, 429, 'WebSocket connection limit reached.');
    }

    const accept = crypto.createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
    socket.setNoDelay(true);

    const client = {
      socket,
      userId: user.id,
      authRequest,
      buffer: Buffer.alloc(0),
      closed: false,
      awaitingPong: false,
      authCheck: false,
      nextAuthCheck: Date.now() + revalidateMs,
    };
    allClients.add(client);
    const set = existing || new Set();
    set.add(client);
    clientsByUser.set(user.id, set);
    stats.accepted += 1;

    const parser = createFrameParser(client, {
      maxMessageBytes,
      onPong: () => { client.awaitingPong = false; },
      onClose: (code, reason) => close(client, code, reason),
      onText: (message) => {
        if (message?.type === 'resync') snapshot(client, 'resync');
        else if (message?.type === 'ping') send(client, { type: 'pong', serverTime: new Date().toISOString() });
        else close(client, 1003, 'Unsupported control message.');
      },
    });
    socket.on('data', parser);
    socket.on('error', () => remove(client));
    socket.on('close', () => remove(client));
    socket.on('end', () => remove(client));
    if (head?.length) parser(head);
    snapshot(client);
  }

  server.on('upgrade', onUpgrade);

  return {
    path: SOCKET_PATH,
    stats() {
      return {
        ...stats,
        activeConnections: allClients.size,
        connectedUsers: clientsByUser.size,
        // Which fan-out row this instance has reached. Two instances whose
        // cursors are far apart is the visible symptom of one of them being
        // stuck, and it is otherwise invisible.
        fanout: fanout.stats(),
      };
    },
    closeUser(userId, code = 1008, reason = 'Session revoked.') {
      for (const client of [...(clientsByUser.get(userId) || [])]) close(client, code, reason);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      fanout.stop();
      clearInterval(heartbeat);
      server.off('upgrade', onUpgrade);
      for (const client of [...allClients]) close(client, 1001, 'Server shutting down.');
      try {
        db.exec(`
          DROP TRIGGER IF EXISTS temp.kg_realtime_notification_insert;
          DROP TRIGGER IF EXISTS temp.kg_realtime_notification_read;
        `);
      } catch {}
    },
  };
}
