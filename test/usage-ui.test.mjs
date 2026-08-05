import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bytes, cancellationNote, checkoutRow, meter, money, usagePanel } from '../public/usage-ui.js';

const GIB = 1024 ** 3;

function usage(overrides = {}) {
  return {
    period: { id: '2026-08' },
    plan: { id: 'team', label: 'Team', recognised: true, stored: 'team' },
    storage: {
      gitBytes: 2 * GIB, lfsBytes: GIB, artifactBytes: 0, cacheBytes: 0,
      lfsLinkedBytes: 3 * GIB, lfsSavedBytes: 2 * GIB, totalBytes: 3 * GIB,
      repositories: { active: 4, archived: 0, trashed: 1, total: 5 },
    },
    ci: { minutes: 120, jobs: 9, running: 0 },
    people: { seats: 6, externalCollaborators: 0 },
    limits: {
      storageBytes: { used: 3 * GIB, limit: 100 * GIB, over: false },
      repositories: { used: 5, limit: 500, over: false },
      seats: { used: 6, limit: 50, over: false },
      ciMinutesPerMonth: { used: 120, limit: 10_000, over: false },
      externalCollaborators: { used: 0, limit: 50, over: false },
    },
    exceeded: [],
    ...overrides,
  };
}

test('an unlimited plan gets no bar', async () => {
  const rendered = meter('Repositories', 900, null);
  // A bar implies a ceiling. Drawing one where there is none invites the
  // question of how close it is.
  assert.doesNotMatch(rendered, /kg-usage-bar/);
  assert.match(rendered, /no limit/);
});

test('a bar warns before it is full, and says when it is past', async () => {
  assert.match(meter('Storage', 10, 100), /kg-usage-bar fine/);
  // 80% is where somebody still has time to do something about it.
  assert.match(meter('Storage', 80, 100), /kg-usage-bar near/);
  assert.match(meter('Storage', 101, 100), /kg-usage-bar over/);
  // Never past the end of the track, however far over they are.
  assert.match(meter('Storage', 400, 100), /width:100%/);
});

test('a zero limit is full rather than dividing by zero', async () => {
  assert.match(meter('Seats', 0, 0), /width:100%/);
});

test('bytes read the way a person would say them', async () => {
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(1536), '1.5 KB');
  assert.equal(bytes(5 * GIB), '5.0 GB');
  assert.equal(bytes(2 * 1024 ** 4), '2.00 TB');
});

test('money is rendered from minor units, never from a float', async () => {
  // ₹1,499.00 arrives as 149900 and must not be divided anywhere else.
  assert.match(money(149900, 'INR'), /1,499/);
  assert.match(money(4900, 'USD'), /49/);
  // An unknown currency still shows the amount rather than throwing.
  assert.match(money(1000, 'ZZZ'), /10/);
});

test('the panel shows the breakdown, the saving and running jobs', async () => {
  const html = usagePanel(usage({ ci: { minutes: 120, jobs: 9, running: 2 } }), null);
  assert.match(html, /Git 2\.0 GB/);
  // The saving is the reason both LFS numbers exist.
  assert.match(html, /Deduplication is saving 2\.0 GB/);
  // A running job is already counted, and saying so is what stops "the number
  // is wrong" when it is not.
  assert.match(html, /2 CI jobs still running, already counted/);
});

test('being over says nothing was deleted', async () => {
  const html = usagePanel(usage({ exceeded: ['storageBytes', 'seats'] }), null);
  assert.match(html, /Over the plan on storageBytes, seats/);
  // The rule enforcement actually follows. Somebody over their limit needs to
  // know their code is still there before they need to know anything else.
  assert.match(html, /Nothing has been deleted and everything can still be read/);
});

test('an unrecognised plan is named rather than hidden', async () => {
  const html = usagePanel(usage({ plan: { id: 'free', recognised: false, stored: 'enterprise-gold' } }), null);
  assert.match(html, /recorded as "enterprise-gold"/);
  assert.match(html, /treated as free/);
});

test('billing is optional, and shown when it is there', async () => {
  assert.doesNotMatch(usagePanel(usage(), null), /Last invoice/);
  const html = usagePanel(usage(), {
    subscription: { status: 'active', provider: 'razorpay' },
    invoices: [{ amountMinor: 149900, currency: 'INR', period: '2026-07', status: 'paid' }],
  });
  assert.match(html, /Subscription active via razorpay/);
  assert.match(html, /Last invoice.*1,499.*2026-07.*paid/);
});

test('everything rendered is escaped', async () => {
  const html = usagePanel(usage({
    plan: { id: 'free', recognised: false, stored: '<img src=x onerror=alert(1)>' },
  }), null);
  // The plan string comes from the database, which an operator types into.
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('nothing to buy shows no buttons', async () => {
  // A member who cannot change the plan gets an empty list from the API. A
  // button that exists to be refused is worse than no button.
  assert.equal(checkoutRow(usage(), { checkout: [] }, 'kuklabs'), '');
  assert.equal(checkoutRow(usage(), null, 'kuklabs'), '');
  assert.doesNotMatch(usagePanel(usage(), null, 'kuklabs'), /kg-usage-buy/);
});

test('the plan somebody is already on is not sold to them again', async () => {
  const billing = {
    checkout: [
      { provider: 'razorpay', plan: 'team', label: 'Team' },
      { provider: 'razorpay', plan: 'business', label: 'Business' },
    ],
  };
  const html = checkoutRow(usage(), billing, 'kuklabs');
  // The fixture is on Team. "Upgrade to Team" is how a customer pays twice.
  assert.doesNotMatch(html, /data-kg-buy-plan="team"/);
  assert.match(html, /data-kg-buy-plan="business"/);
  assert.match(html, /data-kg-buy-provider="razorpay"/);
  assert.match(html, /data-kg-buy-org="kuklabs"/);
});

test('both providers are offered when both are configured', async () => {
  const billing = {
    checkout: [
      { provider: 'razorpay', plan: 'business', label: 'Business' },
      { provider: 'stripe', plan: 'business', label: 'Business' },
    ],
  };
  const html = checkoutRow(usage(), billing, 'kuklabs');
  // Two providers for one plan is a real state — India and everywhere else —
  // and the customer picks, not us.
  assert.match(html, /razorpay/);
  assert.match(html, /stripe/);
});

test('cancel and resume are offered only when the server says so', async () => {
  const base = { checkout: [], subscription: { status: 'active', provider: 'razorpay' } };
  assert.doesNotMatch(checkoutRow(usage(), base, 'kuklabs'), /kg-usage-cancel|kg-usage-resume/);

  const cancellable = checkoutRow(usage(), { ...base, actions: { canCancel: true, canResume: false } }, 'kuklabs');
  assert.match(cancellable, /kg-usage-cancel/);
  // Razorpay has no un-cancel. Working that out in the browser would mean
  // holding a copy of what each provider supports, and being quietly wrong.
  assert.doesNotMatch(cancellable, /kg-usage-resume/);

  const resumable = checkoutRow(usage(), { ...base, actions: { canCancel: false, canResume: true } }, 'kuklabs');
  assert.match(resumable, /kg-usage-resume/);
  assert.doesNotMatch(resumable, /kg-usage-cancel/);
});

test('a pending cancellation says when, and that nothing is lost', async () => {
  assert.equal(cancellationNote({ subscription: { status: 'active' } }), '');
  const note = cancellationNote({ subscription: { cancelsAt: '2026-09-01T00:00:00.000Z' } });
  assert.match(note, /ends on 1 Sept? 2026/);
  // The first thing somebody cancelling wants to know is whether their code is
  // going anywhere. It is not.
  assert.match(note, /nothing is deleted after/);
});

test('the page actually loads the module and marks the cards', async () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /src="\/usage-ui\.js"/);
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  // A module nothing imports, or a card nothing marks, is a panel nobody sees —
  // and every test above would still pass.
  assert.match(app, /data-kg-org-card="\$\{escapeHtml\(org\.slug\)\}"/);
});
