import crypto from 'node:crypto';
import net from 'node:net';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const BRANCH_RE = /^(?!\/|.*(?:\.\.|\/\.|\.lock(?:\/|$)|@\{|\\))[A-Za-z0-9._\/-]{1,180}(?<![\/.])$/;

export function assertSlug(value, label = 'slug') {
  if (!SLUG_RE.test(String(value ?? ''))) {
    throw httpError(400, `Invalid ${label}. Use lowercase letters, numbers and hyphens.`);
  }
  return value;
}

export function assertBranch(value) {
  if (!BRANCH_RE.test(String(value ?? ''))) throw httpError(400, 'Invalid branch name.');
  return value;
}

export function safeRepoRelativePath(value) {
  const raw = String(value ?? '').replaceAll('\\', '/');
  if (!raw || raw.startsWith('/') || raw.includes('\0')) throw httpError(400, 'Invalid file path.');
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw httpError(400, 'Invalid file path.');
  return parts.join('/');
}

export function httpError(status, message, code = 'REQUEST_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf('=');
      return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
    }),
  );
}

export function serializeCookie(name, value, { maxAge, secure = false } = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function normalizeEmail(email) {
  const value = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw httpError(400, 'Enter a valid email address.');
  return value;
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || parts[0] === 0;
}

export function validateRemoteUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.length > 2048) throw httpError(400, 'Enter a valid repository URL.');
  if (value.startsWith('git@')) {
    if (!/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_.\/-]+(?:\.git)?$/.test(value)) throw httpError(400, 'Invalid SSH repository URL.');
    return value;
  }
  let url;
  try { url = new URL(value); } catch { throw httpError(400, 'Invalid repository URL.'); }
  if (!['https:', 'ssh:'].includes(url.protocol)) throw httpError(400, 'Only HTTPS and SSH repository URLs are allowed.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) throw httpError(400, 'Local repository URLs are not allowed.');
  const ipType = net.isIP(host);
  if (ipType === 4 && isPrivateIPv4(host)) throw httpError(400, 'Private network repository URLs are not allowed.');
  if (ipType === 6 && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))) {
    throw httpError(400, 'Private network repository URLs are not allowed.');
  }
  if (url.username || url.password) throw httpError(400, 'Credentials must not be embedded in repository URLs.');
  return value;
}

export function originAllowed(req, baseUrl) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(baseUrl).origin; } catch { return false; }
}
