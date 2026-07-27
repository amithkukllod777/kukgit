import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createSession, hashPassword } from '../src/auth.mjs';
import {
  createAuthKitBridgeSession,
  migrateAuthKitIdentity,
} from '../src/authkit-identity.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import {
  createNotification,
  markAllNotificationsRead,
  migrateNotifications,
  setNotificationRead,
} from '../src/notifications.mjs';
import { createRealtimeNotificationServer } from '../src/realtime-notifications.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function clientFrame(opcode, value = '') {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const mask = crypto.randomBytes(4);
  const header = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length]) : (() => {
    const result = Buffer.alloc(4);
    result[0] = 0x80 | opcode;
    result[1] = 0x80 | 126;
    result.writeUInt16BE(payload.length, 2);
    return result;
  })();
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function parseServerFrames(state, chunk, onFrame) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const opcode = state.buffer[0] & 0x0f;
    let length = state.buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (state.buffer.length < 4) return;
      length = state.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) throw new Error('Unexpected large server frame.');
    if (state.buffer.length < offset + length) return;
    const payload = state.buffer.subarray(offset, offset + length);
    state.buffer = state.buffer.subarray(offset + length);
    onFrame(opcode, payload);
  }
}

async function rawUpgrade(origin, { cookie = '', requestOrigin = origin, pathname = '/api/notifications/socket' } = {}) {
  const url = new URL(origin);
  const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const key = crypto.randomBytes(16).toString('base64');
  socket.write([
    `GET ${pathname} HTTP/1.1`,
    `Host: ${url.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${key}`,
    `Origin: ${requestOrigin}`,
    cookie ? `Cookie: ${cookie}` : '',
    '',
    '',
  ].filter(Boolean).join('\r\n'));

  let headerBuffer = Buffer.alloc(0);
  const header = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Upgrade response timed out.')), 3000);
    function onData(chunk) {
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      const end = headerBuffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      clearTimeout(timeout);
      socket.off('data', onData);
      resolve({ text: headerBuffer.subarray(0, end).toString('utf8'), remainder: headerBuffer.subarray(end + 4) });
    }
    socket.on('data', onData);
    socket.once('error', reject);
  });
  const status = Number(header.text.split(' ')[1]);
  if (status !== 101) {
    socket.destroy();
    return { status, header: header.text };
  }

  const messages = [];
  const waiters = [];
  const closes = [];
  const closeWaiters = [];
  const state = { buffer: Buffer.alloc(0) };
  function deliver(queue, waiting, value) {
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(value);
    else queue.push(value);
  }
  function onFrame(opcode, payload) {
    if (opcode === 0x1) {
      deliver(messages, waiters, JSON.parse(payload.toString('utf8')));
    } else if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      deliver(closes, closeWaiters, { code, reason: payload.subarray(2).toString('utf8') });
    } else if (opcode === 0x9) {
      socket.write(clientFrame(0xA, payload));
    }
  }
  socket.on('data', (chunk) => parseServerFrames(state, chunk, onFrame));
  if (header.remainder.length) parseServerFrames(state, header.remainder, onFrame);

  function wait(queue, waiting, timeoutMs) {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const entry = { resolve: (value) => { clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Error('WebSocket event timed out.'));
      }, timeoutMs);
      waiting.push(entry);
    });
  }
  return {
    status,
    socket,
    nextMessage: (timeoutMs = 3000) => wait(messages, waiters, timeoutMs),
    nextClose: (timeoutMs = 4000) => wait(closes, closeWaiters, timeoutMs),
    sendJson: (payload) => socket.write(clientFrame(0x1, JSON.stringify(payload))),
    close: () => {
      if (!socket.destroyed) socket.write(clientFrame(0x8, Buffer.from([0x03, 0xE8])));
      socket.destroy();
    },
  };
}

function localSetup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-realtime-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    authMode: 'local',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    baseUrl: 'http://127.0.0.1:8787',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  const { userId: ownerId } = seedCore(db, config);
  migrateNotifications(db);
  const secondId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(secondId, 'second@example.com', hashPassword('secure-second-password'), 'Second User');
  const ownerSession = createSession(db, ownerId);
  const secondSession = createSession(db, secondId);
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const hub = createRealtimeNotificationServer({
    server,
    config,
    db,
    options: { heartbeatMs: 1000, revalidateMs: 1000, maxPerUser: 3 },
  });
  t.after(() => hub.stop());
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { config, db, server, hub, ownerId, secondId, ownerSession, secondSession };
}

async function connectLocal(origin, session, requestOrigin = origin) {
  return rawUpgrade(origin, { cookie: `kukgit_session=${session.token}`, requestOrigin });
}

test('rejects unauthenticated and cross-origin WebSocket upgrades', async (t) => {
  const context = localSetup(t);
  const origin = await listen(context.server);
  context.config.baseUrl = origin;

  const unauthenticated = await rawUpgrade(origin);
  assert.equal(unauthenticated.status, 401);
  const crossOrigin = await connectLocal(origin, context.ownerSession, 'https://attacker.example');
  assert.equal(crossOrigin.status, 403);
  assert.equal(context.hub.stats().activeConnections, 0);
  assert.equal(context.hub.stats().rejected, 2);
});

test('delivers notification changes only to the intended user', async (t) => {
  const context = localSetup(t);
  const origin = await listen(context.server);
  context.config.baseUrl = origin;
  const owner = await connectLocal(origin, context.ownerSession);
  const second = await connectLocal(origin, context.secondSession);
  t.after(() => { owner.close(); second.close(); });
  assert.equal((await owner.nextMessage()).type, 'notifications.snapshot');
  assert.equal((await second.nextMessage()).type, 'notifications.snapshot');

  createNotification(context.db, context.config, {
    userId: context.ownerId,
    category: 'security',
    title: 'Owner-only alert',
    body: 'A security event occurred.',
  });
  const changed = await owner.nextMessage();
  assert.equal(changed.type, 'notifications.changed');
  assert.equal(changed.unreadCount, 1);
  await assert.rejects(second.nextMessage(250), /timed out/);
  assert.equal(context.hub.stats().connectedUsers, 2);
});

test('synchronizes read and mark-all-read state across tabs', async (t) => {
  const context = localSetup(t);
  const origin = await listen(context.server);
  context.config.baseUrl = origin;
  const first = await connectLocal(origin, context.ownerSession);
  const second = await connectLocal(origin, context.ownerSession);
  t.after(() => { first.close(); second.close(); });
  await first.nextMessage();
  await second.nextMessage();

  const created = createNotification(context.db, context.config, {
    userId: context.ownerId,
    category: 'organization',
    title: 'Workspace update',
    body: 'A workspace changed.',
  }).notification;
  assert.equal((await first.nextMessage()).unreadCount, 1);
  assert.equal((await second.nextMessage()).unreadCount, 1);

  setNotificationRead(context.db, context.ownerId, created.id, true);
  assert.equal((await first.nextMessage()).unreadCount, 0);
  assert.equal((await second.nextMessage()).unreadCount, 0);

  setNotificationRead(context.db, context.ownerId, created.id, false);
  await first.nextMessage();
  await second.nextMessage();
  markAllNotificationsRead(context.db, context.ownerId);
  assert.equal((await first.nextMessage()).unreadCount, 0);
  assert.equal((await second.nextMessage()).unreadCount, 0);
});

test('enforces per-user connection limits and cleans up closed sockets', async (t) => {
  const context = localSetup(t);
  context.hub.stop();
  const limited = createRealtimeNotificationServer({
    server: context.server,
    config: context.config,
    db: context.db,
    options: { heartbeatMs: 1000, revalidateMs: 1000, maxPerUser: 1 },
  });
  t.after(() => limited.stop());
  const origin = await listen(context.server);
  context.config.baseUrl = origin;
  const first = await connectLocal(origin, context.ownerSession);
  t.after(() => first.close());
  await first.nextMessage();
  const blocked = await connectLocal(origin, context.ownerSession);
  assert.equal(blocked.status, 429);
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(limited.stats().activeConnections, 0);
});

test('closes an AuthKit socket after central device-session revocation', async (t) => {
  const state = { current: true };
  const centralUser = {
    kuklabs_user_id: 'central-realtime-user', id: 'central-realtime-user',
    full_name: 'Realtime User', email: 'realtime@example.com', email_verified: true,
  };
  const authkit = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://authkit.test');
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (url.pathname === '/v1/auth/products/kukgit/access') return sendJson(res, 200, { access: true, status: 'active' });
    if (url.pathname === '/v1/auth/me') return bearer === 'access-realtime' ? sendJson(res, 200, { user: centralUser }) : sendJson(res, 401, { message: 'expired' });
    if (url.pathname === '/v1/auth/sessions') return sendJson(res, 200, { sessions: state.current ? [{ id: 'sid-realtime', current: true }] : [] });
    return sendJson(res, 404, { message: 'not found' });
  });
  const authkitOrigin = await listen(authkit);
  t.after(() => new Promise((resolve) => authkit.close(resolve)));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-realtime-authkit-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'), repositoriesDir: path.join(dataDir, 'repos'), tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test', authMode: 'authkit', authkitBaseUrl: authkitOrigin,
    authkitEncryptionKey: 'realtime-authkit-encryption-key-with-32-characters',
    baseUrl: 'http://127.0.0.1:8787',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateAuthKitIdentity(db);
  migrateNotifications(db);
  const session = await createAuthKitBridgeSession(db, config, {
    access_token: 'access-realtime', refresh_token: 'refresh-realtime', expires_in: 3600,
    user: centralUser, sid: 'sid-realtime',
  });
  db.prepare("UPDATE sessions SET authkit_sid = 'sid-realtime'").run();
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const hub = createRealtimeNotificationServer({ server, config, db, options: { heartbeatMs: 1000, revalidateMs: 1000 } });
  t.after(() => hub.stop());
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = await listen(server);
  config.baseUrl = origin;
  const client = await rawUpgrade(origin, { cookie: `kukgit_session=${session.browserToken}` });
  t.after(() => client.close());
  await client.nextMessage();
  state.current = false;
  const closed = await client.nextClose(4500);
  assert.equal(closed.code, 1008);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});
