import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

test('production local authentication is rejected even when legacy override inputs are supplied', () => {
  assert.throws(() => loadConfig({
    nodeEnv: 'production',
    baseUrl: 'https://git.kuklabs.com',
    authMode: 'local',
    allowLocalAuthInProduction: true,
  }), /Local KukGit password authentication is disabled in production/);
});

test('production defaults to AuthKit rather than local authentication', () => {
  const config = loadConfig({
    nodeEnv: 'production',
    baseUrl: 'https://git.kuklabs.com',
    authkitBaseUrl: 'https://auth.kuklabs.com',
    authkitEncryptionKey: 'production-authkit-encryption-key-with-more-than-32-characters',
  });
  assert.equal(config.authMode, 'authkit');
  assert.equal(Object.hasOwn(config, 'allowLocalAuthInProduction'), false);
});
