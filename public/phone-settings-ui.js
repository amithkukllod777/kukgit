/**
 * The phone number panel on account settings.
 *
 * Small on purpose. The verification itself happens on `/account/phone`, which
 * is a separate document with its own Content-Security-Policy — see
 * `src/phone-verify-page.mjs`. This panel says what is on the account and links
 * there; it never loads Firebase, so the application's strict policy is not
 * touched by anything here.
 *
 * The panel is absent, not empty, on an instance with no Firebase project. A
 * greyed-out "verify your number" that can never work is worse than no panel:
 * it reads as broken rather than as not offered.
 */

function pnEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function pnNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${pnEscape(title)}</b><span>${pnEscape(message)}</span></div>`;
  root.append(element);
  setTimeout(() => element.remove(), 4600);
}

function onSettings() {
  const [pathPart] = location.hash.slice(1).split('?');
  return pathPart.split('/').filter(Boolean)[0] === 'settings';
}

/**
 * Whether this instance offers phone verification.
 *
 * Asked of the same endpoint the verification page uses, so there is one answer
 * rather than two that can disagree. A 404 means not offered; a 401 means the
 * session went away, and neither is worth an error on screen.
 */
let offering = null;

async function offered() {
  // Asked once per page load, not once per render. Whether an instance has a
  // Firebase project is decided at deploy time, and the observer here fires on
  // every write anywhere in the application — on an instance that does not have
  // one, re-asking meant a request for every redraw of any screen. Found by the
  // request-storm sweep.
  if (offering !== null) return offering;
  try {
    const response = await fetch('/api/account/phone/config', { credentials: 'same-origin' });
    offering = response.ok;
  } catch { offering = false; }
  return offering;
}

async function linkedPhone() {
  try {
    const response = await fetch('/api/auth/identities', { credentials: 'same-origin' });
    if (!response.ok) return null;
    const payload = await response.json();
    const phone = (payload.identities || []).find((identity) => identity.provider === 'phone');
    return phone ? { number: phone.providerLogin || null, since: phone.linkedAt || null } : null;
  } catch { return null; }
}

export function phonePanelHtml(current) {
  const body = current
    ? `<div class="field"><label>Verified number</label><input class="input" value="${pnEscape(current.number || 'On file')}" readonly /></div>
       <div style="display:flex;gap:10px;flex-wrap:wrap">
         <a class="btn" href="/account/phone">Change it</a>
         <button class="btn" type="button" id="kg-phone-remove">Remove it</button>
       </div>`
    : `<p class="muted" style="margin:0 0 12px">A verified number is used to get back into your account, and nothing else. We do not send marketing to it.</p>
       <a class="btn btn-primary" href="/account/phone">Verify a number</a>`;
  return `<section class="card" id="kg-phone-panel"><div class="card-header"><div><h3>Phone number</h3></div></div><div class="card-body">${body}</div></section>`;
}

/**
 * That a mount is already under way.
 *
 * Not the same as "the panel is on the page": between asking the server and
 * inserting anything there are two awaits, and a navigation during them starts
 * a second mount that also sees no panel. Both would then insert one.
 *
 * No test kills this line. Reproducing it needs a real network delay between
 * the two rounds, and the test harness answers instantly — so what the tests
 * hold is that one round makes one panel, and this is here for the case they
 * cannot stage.
 */
let mounted = false;

async function mountPhonePanel() {
  if (!onSettings()) { mounted = false; return; }
  if (mounted || document.querySelector('#kg-phone-panel')) return;
  const content = document.querySelector('.app-shell .content') ?? document.querySelector('#app .content') ?? document.querySelector('#app');
  if (!content) return;
  mounted = true;

  if (!await offered()) { mounted = false; return; }
  // Re-checked after the awaits: the person may have navigated away, and a
  // panel appended to a page that has moved on is a stray card.
  if (!onSettings() || document.querySelector('#kg-phone-panel')) { mounted = false; return; }

  const current = await linkedPhone();
  if (!onSettings() || document.querySelector('#kg-phone-panel')) { mounted = false; return; }
  content.insertAdjacentHTML('beforeend', phonePanelHtml(current));

  document.querySelector('#kg-phone-remove')?.addEventListener('click', async () => {
    const button = document.querySelector('#kg-phone-remove');
    button.disabled = true;
    try {
      const response = await fetch('/api/account/phone/remove', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || 'Could not remove that number.');
      document.querySelector('#kg-phone-panel')?.remove();
      mounted = false;
      pnNotify('Number removed', 'Your account no longer has a phone number on it.');
    } catch (error) {
      // The common refusal is that it is the only way into the account, and
      // that message explains what to do first.
      pnNotify('Not removed', error.message, 'error');
      button.disabled = false;
    }
  });
}

let scheduled = false;
function schedulePhonePanel() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    scheduled = false;
    await mountPhonePanel();
  }));
}

if (typeof document !== 'undefined' && document.querySelector('#app')) {
  window.addEventListener('hashchange', schedulePhonePanel);
  new MutationObserver(schedulePhonePanel).observe(document.querySelector('#app'), { childList: true, subtree: true });
  schedulePhonePanel();
}
