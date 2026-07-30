import net from 'node:net';
import tls from 'node:tls';
import { normalizeEmail, httpError } from './security.mjs';

const MAX_HEADER_LENGTH = 998;
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

function headerValue(value, name, max = MAX_HEADER_LENGTH) {
  const text = String(value ?? '').trim();
  if (!text) throw httpError(400, `${name} is required.`, 'EMAIL_HEADER_REQUIRED');
  if (/\r|\n/.test(text)) throw httpError(400, `${name} contains an invalid line break.`, 'EMAIL_HEADER_INJECTION');
  if (text.length > max) throw httpError(400, `${name} is too long.`, 'EMAIL_HEADER_TOO_LONG');
  return text;
}

function optionalHeader(value, name, max = MAX_HEADER_LENGTH) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return headerValue(text, name, max);
}

function formatAddress(email, displayName = '') {
  const normalized = normalizeEmail(email);
  const name = optionalHeader(displayName, 'Email display name', 120);
  if (!name) return normalized;
  const escaped = name.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${escaped}" <${normalized}>`;
}

function normalizeBody(value, name) {
  const body = String(value ?? '').replace(/\r?\n/g, '\r\n');
  if (!body.trim()) throw httpError(400, `${name} is required.`, 'EMAIL_BODY_REQUIRED');
  if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) throw httpError(413, `${name} is too large.`, 'EMAIL_BODY_TOO_LARGE');
  return body;
}

function encodeSubject(value) {
  const subject = headerValue(value, 'Email subject', 500);
  return /^[\x20-\x7E]+$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function messageId(domain = 'localhost') {
  const safeDomain = /^[A-Za-z0-9.-]+$/.test(domain) ? domain : 'localhost';
  return `<${cryptoRandom()}@${safeDomain}>`;
}

function cryptoRandom() {
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.${process.pid}`;
}

function dotStuff(body) {
  return body.split('\r\n').map((line) => line.startsWith('.') ? `.${line}` : line).join('\r\n');
}

export function buildEmailMessage(config, message) {
  const to = normalizeEmail(message.to);
  const from = formatAddress(config.emailFrom, config.emailFromName);
  const replyTo = config.emailReplyTo ? normalizeEmail(config.emailReplyTo) : '';
  const subject = encodeSubject(message.subject);
  const text = normalizeBody(message.text, 'Email text body');
  const html = message.html ? normalizeBody(message.html, 'Email HTML body') : '';
  const host = (() => {
    try { return new URL(config.baseUrl).hostname; } catch { return 'localhost'; }
  })();
  const headers = [
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId(host)}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    'X-Auto-Response-Suppress: All',
    'X-KukGit-Notification: transactional',
  ];
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);

  let body;
  if (html) {
    const boundary = `kukgit-${cryptoRandom().replaceAll('.', '-')}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text,
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      html,
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: 8bit');
    body = text;
  }
  const raw = `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
  if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) throw httpError(413, 'Email message is too large.', 'EMAIL_MESSAGE_TOO_LARGE');
  return { to, from: normalizeEmail(config.emailFrom), raw };
}

class SmtpConnection {
  constructor(socket, timeoutMs = 30000) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.waiters = [];
    this.closed = false;
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP connection timed out.')));
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => {
      this.closed = true;
      this.fail(new Error('SMTP connection closed.'));
    });
  }

  replaceSocket(socket) {
    this.socket.removeAllListeners();
    this.socket = socket;
    this.buffer = '';
    this.closed = false;
    socket.setEncoding('utf8');
    socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error('SMTP connection timed out.')));
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => {
      this.closed = true;
      this.fail(new Error('SMTP connection closed.'));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    this.flush();
  }

  flush() {
    while (this.waiters.length) {
      const response = this.takeResponse();
      if (!response) return;
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(response);
    }
  }

  takeResponse() {
    const lines = this.buffer.split('\r\n');
    if (lines.length < 2) return null;
    let consumed = 0;
    let code = null;
    const responseLines = [];
    for (const line of lines) {
      if (line === '' && consumed === lines.length - 1) break;
      const match = line.match(/^(\d{3})([ -])(.*)$/);
      if (!match) return null;
      if (code === null) code = Number(match[1]);
      if (Number(match[1]) !== code) return null;
      responseLines.push(line);
      consumed += line.length + 2;
      if (match[2] === ' ') {
        this.buffer = this.buffer.slice(consumed);
        return { code, lines: responseLines, text: responseLines.map((item) => item.slice(4)).join('\n') };
      }
    }
    return null;
  }

  fail(error) {
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  response() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SMTP response timed out.')), this.timeoutMs);
      this.waiters.push({ resolve, reject, timer });
      this.flush();
    });
  }

  async command(command, expectedCodes) {
    if (this.closed) throw new Error('SMTP connection is closed.');
    if (command !== null) this.socket.write(`${command}\r\n`);
    const response = await this.response();
    const expected = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
    if (!expected.includes(response.code)) {
      const error = new Error(`SMTP command failed with ${response.code}: ${response.text}`);
      error.smtpCode = response.code;
      throw error;
    }
    return response;
  }

  async writeData(raw) {
    this.socket.write(`${dotStuff(raw)}\r\n.\r\n`);
    const response = await this.response();
    if (response.code !== 250) {
      const error = new Error(`SMTP message rejected with ${response.code}: ${response.text}`);
      error.smtpCode = response.code;
      throw error;
    }
    return response;
  }

  close() {
    try { this.socket.end(); } catch {}
  }
}

function connectSocket(config) {
  const options = { host: config.smtpHost, port: config.smtpPort };
  return new Promise((resolve, reject) => {
    const socket = config.smtpSecure
      ? tls.connect({ ...options, servername: config.smtpHost, rejectUnauthorized: config.smtpRejectUnauthorized }, () => resolve(socket))
      : net.connect(options, () => resolve(socket));
    socket.once('error', reject);
  });
}

async function upgradeStartTls(connection, config) {
  await connection.command('STARTTLS', 220);
  const socket = await new Promise((resolve, reject) => {
    const upgraded = tls.connect({
      socket: connection.socket,
      servername: config.smtpHost,
      rejectUnauthorized: config.smtpRejectUnauthorized,
    }, () => resolve(upgraded));
    upgraded.once('error', reject);
  });
  connection.replaceSocket(socket);
}

export function smtpConfigured(config) {
  return Boolean(String(config.smtpHost || '').trim() && String(config.emailFrom || '').trim());
}

// Tags an SMTP failure with the protocol stage that produced it.
//
// Bounce classification depends on this: a 5xx at RCPT TO means the recipient is
// bad, while the same code at MAIL FROM, AUTH or DATA means our sender, our
// credentials or the message is the problem. Suppressing a recipient for a
// sender-side fault would silently blackhole a valid address.
async function atStage(stage, run) {
  try {
    return await run();
  } catch (error) {
    if (error && !error.smtpStage) error.smtpStage = stage;
    throw error;
  }
}

export async function sendSmtpMessage(config, message) {
  if (!smtpConfigured(config)) throw httpError(503, 'SMTP delivery is not configured.', 'SMTP_NOT_CONFIGURED');
  if (!Number.isInteger(config.smtpPort) || config.smtpPort < 1 || config.smtpPort > 65535) {
    throw httpError(500, 'SMTP port configuration is invalid.', 'SMTP_CONFIGURATION_INVALID');
  }
  const built = buildEmailMessage(config, message);
  const socket = await connectSocket(config);
  socket.removeAllListeners('error');
  const connection = new SmtpConnection(socket);
  try {
    await connection.command(null, 220);
    const hostname = (() => {
      try { return new URL(config.baseUrl).hostname || 'localhost'; } catch { return 'localhost'; }
    })();
    let ehlo = await connection.command(`EHLO ${hostname}`, 250);
    const capabilities = ehlo.lines.map((line) => line.slice(4).trim().toUpperCase());
    if (!config.smtpSecure && config.smtpStartTls) {
      if (!capabilities.some((line) => line.startsWith('STARTTLS'))) {
        throw httpError(502, 'SMTP server does not advertise STARTTLS.', 'SMTP_STARTTLS_UNAVAILABLE');
      }
      await upgradeStartTls(connection, config);
      ehlo = await connection.command(`EHLO ${hostname}`, 250);
    }
    if (config.smtpUser || config.smtpPassword) {
      if (!config.smtpUser || !config.smtpPassword) throw httpError(500, 'SMTP username and password must both be configured.', 'SMTP_CONFIGURATION_INVALID');
      const credential = Buffer.from(`\0${config.smtpUser}\0${config.smtpPassword}`, 'utf8').toString('base64');
      await atStage('auth', () => connection.command(`AUTH PLAIN ${credential}`, 235));
    }
    await atStage('sender', () => connection.command(`MAIL FROM:<${built.from}>`, 250));
    await atStage('recipient', () => connection.command(`RCPT TO:<${built.to}>`, [250, 251]));
    await atStage('data', () => connection.command('DATA', 354));
    const response = await atStage('data', () => connection.writeData(built.raw));
    try { await connection.command('QUIT', 221); } catch {}
    return { accepted: true, responseCode: response.code, response: response.text.slice(0, 1000) };
  } finally {
    connection.close();
  }
}
