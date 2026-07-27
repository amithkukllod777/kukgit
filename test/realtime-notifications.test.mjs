import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createSession, hashPassword } from '../src/auth.mjs';
import { createAuthKitBridgeSession, migrateAuthKitIdentity } from '../src/authkit-identity.mjs';
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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
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

async function rawUpgrade(origin, { cookie = '', requestOrigin = origin } = {}) {
  const url = new URL(origin);
  const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write([
    'GET /api/notifications/socket HTTP/1.1',
    `Host: ${url.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
    `Origin: ${requestOrigin}`,
    cookie ? `Cookie: ${cookie}` : '',
    '',
    '',
  ].filter(Boolean).join('\r\n'));

  let bytes = Buffer.alloc(0);
  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Upgrade response timed out.')), 3000);
    function onData(chunk) {
      bytes = Buffer.concat([bytes, chunk]);
      const end = bytes.indexOf('\r\n\r\n');
      if (end < 0) return;
      clearTimeout(timeout);
      socket.off('data', onData);
      resolve({ header: bytes.subarray(0, end).toString('utf8'), remainder: bytes.subarray(end + 4) });
    }
    socket.on('data', onData);
    socket.once('error', reject);
  });
  const status = Number(response.header.split(' ')[1]);
  if (status !== 101) {
    socket.destroy();
    return { status, close() {} };
  }

  const queues = { messages: [], closes: [] };
  const waiters = { messages: [], closes: [] };
  const state = { buffer: Buffer.alloc(0) };
  function deliver(name, value) {
    const waiter = waiters[name].shift();
    if (waiter) waiter(value);
    else queues[name].push(value);
  }
  function onFrame(opcode, payload) {
    if (opcode === 0x1) deliver('messages', JSON.parse(payload.toString('utf8')));
    else if (opcode === 0x8) deliver('closes', {
      code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
      reason: payload.subarray(2).toString('utf8'),
    });
    else if (opcode === 0x9 && !socket.destroyed) socket.write(clientFrame(0xA, payload));
  }
  socket.on('data', (chunk) => parseServerFrames(state, chunk, onFrame));
  if (response.remainder.length) parseServerFrames(state, response.remainder, onFrame);

  function next(name, timeoutMs) {
    if (queues[name].length) return Promise.resolve(queues[name].shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters[name].indexOf(done);
        if (index >= 0) waiters[name].splice(index, 1);
        reject(new Error('WebSocket event timed out.'));
      }, timeoutMs);
      function done(value) {
        clearTimeout(timer);
        resolve(value);
      }
      waiters[name].push(done);
    });
  }
  return {
    status,
    socket,
    nextMessage: (timeoutMs = 3000) => next('messages', timeoutMs),
    nextClose: (timeoutMs = 4000) => next('closes', timeoutMs),
    sendJson: (payload) => socket.write(clientFrame(0x1, JSON.stringify(payload))),
    close() {
      if (!socket.destroyed) socket.write(clientFrame(0x8, Buffer.from([0x03, 0xE8])));
      socket.destroy();
    },
  };
}

async function localContext(t, { maxPerUser = 3 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-realtime-test-'));
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
  const { userId: ownerId } = seedCore(db, config);
  migrateNotifications(db);
  const secondId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(secondId, 'second@example.com', hashPassword('secure-second-password'), 'Second User');
  const ownerSession = createSession(db, ownerId);
  const secondSession = createSession(db, secondId);
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const hub = createRealtimeNotificationServer({ server, config, db, options: { heartbeatMs: 1000, revalidateMs: 1000, maxPerUser } });
  const origin = await listen(server);
  config.baseUrl = origin;
  t.after(async () => {
    hub.stop();
    await closeServer(server);
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { config, db, server, hub, origin, ownerId, secondId, ownerSession, secondSession };
}

const cookieFor = (session) => `kukgit_session=${session.token}`;

test('rejects unauthenticated and cross-origin WebSocket upgrades', async (t) => {
  const context = await localContext(t);
  assert.equal((await rawUpgrade(context.origin)).status, 401);
  assert.equal((await rawUpgrade(context.origin, { cookie: cookieFor(context.ownerSession), requestOrigin: 'https://attacker.example' })).status, 403);
  assert.equal(context.hub.stats().activeConnections, 0);
  assert.equal(context.hub.stats().rejected, 2);
});

test('isolates users and synchronizes read state across tabs', async (t) => {
  const context = await localContext(t);
  const ownerA = await rawUpgrade(context.origin, { cookie: cookieFor(context.ownerSession) });
  const ownerB = await rawUpgrade(context.origin, { cookie: cookieFor(context.ownerSession) });
  const second = await rawUpgrade(context.origin, { cookie: cookieFor(context.secondSession) });
  t.after(() => { ownerA.close(); ownerB.close(); second.close(); });
  await Promise.all([ownerA.nextMessage(), ownerB.nextMessage(), second.nextMessage()]);

  const notification = createNotification(context.db, context.config, {
    userId: context.ownerId,
    category: 'security',
    title: 'Owner-only alert',
    body: 'A security event occurred.',
  }).notification;
  assert.equal((await ownerA.nextMessage()).unreadCount, 1);
  assert.equal((await ownerB.nextMessage()).unreadCount, 1);
  await assert.rejects(second.nextMessage(250), /timed out/);

  setNotificationRead(context.db, context.ownerId, notification.id, true);
  assert.equal((await ownerA.nextMessage()).unreadCount, 0);
  assert.equal((await ownerB.nextMessage()).unreadCount, 0);
  setNotificationRead(context.db, context.ownerId, notification.id, false);
  await Promise.all([ownerA.nextMessage(), ownerB.nextMessage()]);
  markAllNotificationsRead(context.db, context.ownerId);
  assert.equal((await ownerA.nextMessage()).unreadCount, 0);
  assert.equal((await ownerB.nextMessage()).unreadCount, 0);
});

test('enforces per-user connection limits and cleans up sockets', async (t) => {
  const context = await localContext(t, { maxPerUser: 1 });
  const first = await rawUpgrade(context.origin, { cookie: cookieFor(context.ownerSession) });
  t.after(() => first.close());
  await first.nextMessage();
  assert.equal((await rawUpgrade(context.origin, { cookie: cookieFor(context.ownerSession) })).status, 429);
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(context.hub.stats().activeConnections, 0);
});

test('closes an AuthKit socket after central device-session revocation', async (t) => {
  const state = { current: true };
  const centralUser = {
    kuklabs_user_id: 'central-realtime-user', id: 'central-realtime-user',
    full_name: 'Realtime User', email: 'realtime@example.com', email_verified: true,
  };
  const authkit = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://authkit.test');
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (url.pathname === '/v1/auth/products/kukgit/access') return sendJson(res, 200, { access: true, status: 'active' });
    if (url.pathname === '/v1/auth/me') return bearer === 'access-realtime' ? sendJson(res, 200, { user: centralUser }) : sendJson(res, 401, { message: 'expired' });
    if (url.pathname === '/v1/auth/sessions') return sendJson(res, 200, { sessions: state.current ? [{ id: 'sid-realtime', current: true }] : [] });
    return sendJson(res, 404, { message: 'not found' });
  });
  const authkitOrigin = await listen(authkit);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-realtime-authkit-'));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'), repositoriesDir: path.join(dataDir, 'repos'), tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test', authMode: 'authkit', authkitBaseUrl: authkitOrigin,
    authkitEncryptionKey: 'realtime-authkit-encryption-key-with-32-characters', baseUrl: 'http://127.0.0.1:8787',
  });
  const db = openDatabase(config);
  migrateAuthKitIdentity(db);
  migrateNotifications(db);
  const session = await createAuthKitBridgeSession(db, config, {
    access_token: 'access-realtime', refresh_token: 'refresh-realtime', expires_in: 3600, user: centralUser,
  });
  db.prepare("UPDATE sessions SET authkit_sid = 'sid-realtime'").run();
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const hub = createRealtimeNotificationServer({ server, config, db, options: { heartbeatMs: 1000, revalidateMs: 1000 } });
  const origin = await listen(server);
  config.baseUrl = origin;
  t.after(async () => {
    hub.stop();
    await closeServer(server);
    await closeServer(authkit);
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const client = await rawUpgrade(origin, { cookie: `kukgit_session=${session.browserToken}` });
  t.after(() => client.close());
  await client.nextMessage();
  state.current = false;
  assert.equal((await client.nextClose(4500)).code, 1008);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});
