import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { KG_OPS_SECTIONS, kgOpsRoute } from '../public/operations-admin-ui.js';
import { KG_ADMIN_DELEGATED } from '../public/instance-admin-ui.js';

function at(t, hash) {
  const saved = globalThis.location;
  t.after(() => {
    if (saved === undefined) delete globalThis.location;
    else globalThis.location = saved;
  });
  globalThis.location = { hash };
  return kgOpsRoute();
}

test('every operations section is delegated by the panel that owns the shell', async () => {
  // Both modules render into `.content` off the same kind of observer. If the
  // panel does not know a section belongs to somebody else, it paints the
  // overview over it and which page you land on is a race. Adding a section
  // without delegating it is the way that comes back.
  for (const section of KG_OPS_SECTIONS) {
    assert.ok(KG_ADMIN_DELEGATED.has(section.id), `${section.id} is rendered here but not delegated`);
  }
});

test('email health is delegated too', async () => {
  // It had this problem already, and nothing named it. It shipped working
  // because its observer happened to fire second.
  assert.ok(KG_ADMIN_DELEGATED.has('email-health'));
});

test('the five sections are recognised', async (t) => {
  for (const section of KG_OPS_SECTIONS) {
    assert.equal(at(t, `#/instance-admin/${section.id}`)?.section, section.id);
  }
});

test('the panel’s own routes are left alone', async (t) => {
  for (const hash of ['#/instance-admin', '#/instance-admin/audit', '#/instance-admin/users/usr_1', '#/instance-admin/organizations/kuklabs']) {
    assert.equal(at(t, hash), null, `${hash} should not be claimed`);
  }
});

test('routes outside the panel are never claimed', async (t) => {
  for (const hash of ['#/settings', '#/repositories', '#/abuse', '', '#/']) {
    assert.equal(at(t, hash), null, `${hash} should not be claimed`);
  }
});

test('a query string does not hide the section', async (t) => {
  assert.equal(at(t, '#/instance-admin/blocked-content?all=true')?.section, 'blocked-content');
});

test('every section has somewhere to click and something to say', async () => {
  for (const section of KG_OPS_SECTIONS) {
    assert.ok(section.label.length > 2, `${section.id} has no label`);
    assert.ok(section.title.length > 4, `${section.id} has no title`);
    assert.ok(section.subtitle.length > 20, `${section.id} has no subtitle`);
  }
});

test('the page actually loads the module', async () => {
  // A module nothing imports is a feature nobody can reach, and the tests above
  // would all still pass.
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /src="\/operations-admin-ui\.js"/);
});
