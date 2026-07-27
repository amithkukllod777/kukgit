import test from 'node:test';
import assert from 'node:assert/strict';
import { hardenAuthKitLoginCard } from '../public/authkit-form-hardening.js';
import { loadConfig } from '../src/config.mjs';

function formFixture() {
  const children = [{ id: 'heading' }, { id: 'inner-form' }];
  let replacement = null;
  const card = {
    tagName: 'FORM',
    className: 'login-card',
    dataset: { authkit: 'true' },
    get firstChild() { return children[0] ?? null; },
    replaceWith(value) { replacement = value; },
  };
  const root = {
    querySelector(selector) {
      assert.equal(selector, '.login-card[data-authkit="true"]');
      return card;
    },
    createElement(name) {
      assert.equal(name, 'section');
      return {
        tagName: 'SECTION',
        className: '',
        dataset: {},
        attributes: {},
        children: [],
        setAttribute(key, value) { this.attributes[key] = value; },
        append(child) {
          const index = children.indexOf(child);
          if (index >= 0) children.splice(index, 1);
          this.children.push(child);
        },
      };
    },
  };
  return { root, card, replacement: () => replacement };
}

test('replaces the legacy outer AuthKit form while preserving rendered child controls', () => {
  const fixture = formFixture();
  const panel = hardenAuthKitLoginCard(fixture.root);
  assert.equal(panel, fixture.replacement());
  assert.equal(panel.tagName, 'SECTION');
  assert.equal(panel.className, 'login-card');
  assert.equal(panel.dataset.authkit, 'true');
  assert.equal(panel.attributes['aria-label'], 'One Kuklabs Account');
  assert.deepEqual(panel.children.map((child) => child.id), ['heading', 'inner-form']);
});

test('leaves an already hardened AuthKit panel unchanged', () => {
  const panel = { tagName: 'SECTION', dataset: { authkit: 'true' } };
  const root = { querySelector: () => panel };
  assert.equal(hardenAuthKitLoginCard(root), panel);
});

test('requires secure cookies for production AuthKit sessions', () => {
  const common = {
    nodeEnv: 'production',
    authMode: 'authkit',
    authkitBaseUrl: 'https://auth.kuklabs.com',
    authkitEncryptionKey: 'x'.repeat(40),
  };
  assert.throws(() => loadConfig({ ...common, cookieSecure: false }), /KUKGIT_COOKIE_SECURE/);
  const config = loadConfig({ ...common, cookieSecure: true });
  assert.equal(config.cookieSecure, true);
});

test('bounds AuthKit timeout and bridge refresh lifetime', () => {
  const common = {
    nodeEnv: 'test',
    authMode: 'authkit',
    authkitBaseUrl: 'https://auth.example.test',
    authkitEncryptionKey: 'x'.repeat(40),
  };
  assert.throws(() => loadConfig({ ...common, authkitTimeoutMs: 499 }), /between 500 and 30000/);
  assert.throws(() => loadConfig({ ...common, authkitTimeoutMs: 30001 }), /between 500 and 30000/);
  assert.throws(() => loadConfig({ ...common, authkitTimeoutMs: 8000.5 }), /between 500 and 30000/);
  assert.throws(() => loadConfig({ ...common, authkitRefreshTtlDays: 0 }), /between 1 and 365/);
  assert.throws(() => loadConfig({ ...common, authkitRefreshTtlDays: 366 }), /between 1 and 365/);
  assert.throws(() => loadConfig({ ...common, authkitRefreshTtlDays: 60.5 }), /between 1 and 365/);
  const config = loadConfig({ ...common, authkitTimeoutMs: 8000, authkitRefreshTtlDays: 60 });
  assert.equal(config.authkitTimeoutMs, 8000);
  assert.equal(config.authkitRefreshTtlDays, 60);
});
