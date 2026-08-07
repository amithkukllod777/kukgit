import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

/**
 * What a production instance is allowed to run its sign-in on.
 *
 * Local accounts used to be refused outright here. That reversed on 2026-08-07
 * — see CLAUDE.md — because AuthKit turned out to be a router mounted on the
 * KukBook ERP rather than a service of its own, so an ERP deploy is a KukGit
 * sign-in outage; and because asking a customer outside Kuklabs to open an
 * account on Kuklabs' accounting system is not a thing that sells.
 *
 * The refusal is gone. What these tests hold is the set of conditions that made
 * it a reasonable refusal in the first place, now required directly: an
 * instance that holds passwords must be reachable only over https and must set
 * its session cookie `Secure`.
 *
 * The tests are written the way the refusal was: the failure they guard against
 * is a production box that starts anyway.
 */

const PRODUCTION = {
  nodeEnv: 'production',
  baseUrl: 'https://git.kuklabs.com',
  authMode: 'local',
  cookieSecure: true,
  adminPassword: 'a-long-and-private-founder-password',
};

test('a production instance may hold its own passwords', () => {
  const config = loadConfig(PRODUCTION);
  assert.equal(config.authMode, 'local');
  // KukGit owns its accounts. Kuklabs Account is a sign-in path somebody may
  // offer, not one they must.
  assert.equal(config.authkitBaseUrl, '');
});

test('holding passwords over plain http is refused', () => {
  // Every verification and reset link is built from the base URL. Over http
  // they are one-time credentials sent in the clear — and the browser will not
  // return a Secure cookie to that origin anyway, so the instance does not work
  // so much as fail confusingly.
  assert.throws(
    () => loadConfig({ ...PRODUCTION, baseUrl: 'http://git.kuklabs.com' }),
    /KUKGIT_BASE_URL must be https/,
  );
});

test('holding passwords with a cookie that is not Secure is refused', () => {
  // The same requirement AuthKit mode has always had. A session cookie without
  // `Secure` leaves on the first plain-http request anything makes: a link in
  // an email, a bookmark, a redirect somebody set up years ago.
  assert.throws(
    () => loadConfig({ ...PRODUCTION, cookieSecure: false }),
    /KUKGIT_COOKIE_SECURE must be true/,
  );
});

test('neither condition is imposed on a development instance', () => {
  // Nobody runs a laptop on https with a Secure cookie, and a check that makes
  // local development impossible is a check people route around in production
  // too.
  const config = loadConfig({ nodeEnv: 'development', authMode: 'local', baseUrl: 'http://localhost:8787' });
  assert.equal(config.authMode, 'local');
  assert.equal(config.cookieSecure, false);
});

test('AuthKit is still the default in production, and still checked', () => {
  const config = loadConfig({
    nodeEnv: 'production',
    baseUrl: 'https://git.kuklabs.com',
    authkitBaseUrl: 'https://auth.kuklabs.com',
    authkitEncryptionKey: 'production-authkit-encryption-key-with-more-than-32-characters',
  });
  // Unchanged: an instance that says nothing gets the delegated identity it
  // has always got. The reversal made local accounts possible, not automatic.
  assert.equal(config.authMode, 'authkit');
  assert.equal(Object.hasOwn(config, 'allowLocalAuthInProduction'), false);

  assert.throws(() => loadConfig({
    nodeEnv: 'production',
    baseUrl: 'https://git.kuklabs.com',
    authMode: 'authkit',
    authkitBaseUrl: '',
    authkitEncryptionKey: 'production-authkit-encryption-key-with-more-than-32-characters',
  }), /KUKGIT_AUTHKIT_BASE_URL/);
});

test('a mode that is not a mode is still refused', () => {
  assert.throws(
    () => loadConfig({ nodeEnv: 'production', baseUrl: 'https://git.kuklabs.com', authMode: 'whatever' }),
    /KUKGIT_AUTH_MODE must be local or authkit/,
  );
});
