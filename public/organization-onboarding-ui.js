const ONBOARDING_API = '/api/onboarding';
let onboardingStatusPromise = null;
let onboardingScheduled = false;
let onboardingRenderKey = '';
let slugCheckTimer = null;

function onboardingEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

async function onboardingRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

function onboardingNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${onboardingEscape(title)}</b><span>${onboardingEscape(message)}</span></div>`;
  root.append(toast);
  setTimeout(() => toast.remove(), 4600);
}

function injectOnboardingStyles() {
  if (document.querySelector('#kg-organization-onboarding-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-organization-onboarding-styles';
  style.textContent = `
    .kg-onboarding { max-width:1040px; margin:0 auto; }
    .kg-onboarding-hero { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(300px,.9fr); gap:24px; align-items:start; }
    .kg-onboarding-copy { padding:22px 8px 12px 0; }
    .kg-onboarding-copy .eyebrow { color:var(--accent); font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
    .kg-onboarding-copy h1 { font-size:34px; line-height:1.15; margin:12px 0; }
    .kg-onboarding-copy p { color:var(--muted); font-size:14px; line-height:1.7; max-width:620px; }
    .kg-onboarding-points { display:grid; gap:10px; margin-top:22px; }
    .kg-onboarding-point { display:flex; gap:11px; align-items:flex-start; padding:12px; border:1px solid var(--border); border-radius:13px; background:rgba(255,255,255,.018); }
    .kg-onboarding-point > span { width:26px; height:26px; display:grid; place-items:center; border-radius:9px; background:rgba(21,152,255,.13); color:var(--accent); flex:0 0 auto; }
    .kg-onboarding-point b { display:block; margin-bottom:3px; }
    .kg-onboarding-point small { color:var(--muted); line-height:1.5; }
    .kg-onboarding-card { position:sticky; top:82px; }
    .kg-onboarding-card .card-body { padding:20px; }
    .kg-slug-wrap { display:flex; align-items:stretch; }
    .kg-slug-prefix { display:flex; align-items:center; padding:0 11px; border:1px solid var(--border); border-right:0; border-radius:10px 0 0 10px; color:var(--muted); background:rgba(255,255,255,.025); font-size:12px; }
    .kg-slug-wrap .input { border-radius:0 10px 10px 0; }
    .kg-slug-status { min-height:18px; margin-top:5px; font-size:11px; color:var(--muted); }
    .kg-slug-status.good { color:#3ddc97; }
    .kg-slug-status.bad { color:#ff6b7a; }
    .kg-onboarding-limit { display:flex; justify-content:space-between; gap:12px; margin:14px 0; padding:11px 12px; border-radius:11px; border:1px solid var(--border); color:var(--muted); font-size:11px; }
    .kg-onboarding-footer { margin-top:14px; text-align:center; color:var(--muted); font-size:10px; line-height:1.55; }
    .kg-create-organization { white-space:nowrap; }
    @media (max-width:900px) { .kg-onboarding-hero { grid-template-columns:1fr; } .kg-onboarding-card { position:static; } .kg-onboarding-copy { padding-right:0; } }
  `;
  document.head.append(style);
}

function routeState() {
  const raw = location.hash.slice(1) || '/';
  const [path, query = ''] = raw.split('?');
  return { path, query: new URLSearchParams(query) };
}

function invitationRoute() {
  const raw = location.hash || '';
  return raw.startsWith('#/accept-invite') || raw.startsWith('#/accept-repo-invite') || raw.includes('repoInviteToken=');
}

function getOnboardingStatus(force = false) {
  if (force) onboardingStatusPromise = null;
  onboardingStatusPromise ||= onboardingRequest(`${ONBOARDING_API}/status`);
  return onboardingStatusPromise;
}

function organizationFormMarkup(status) {
  const sizes = [
    ['solo', 'Just me'], ['2-10', '2–10 people'], ['11-50', '11–50 people'],
    ['51-200', '51–200 people'], ['201-1000', '201–1,000 people'], ['1000+', '1,000+ people'],
  ];
  return `<form id="kg-organization-onboarding-form">
    <div class="field"><label>Organization name</label><input class="input" name="name" autocomplete="organization" placeholder="Example Technologies" minlength="2" maxlength="100" required /></div>
    <div class="field"><label>Workspace URL</label><div class="kg-slug-wrap"><span class="kg-slug-prefix">kukgit/</span><input class="input" name="slug" value="${onboardingEscape(status.suggestedSlug)}" pattern="[a-z0-9][a-z0-9-]{1,62}" maxlength="63" required /></div><div class="kg-slug-status" id="kg-slug-status">Lowercase letters, numbers and hyphens.</div></div>
    <div class="field"><label>What will this workspace contain?</label><textarea class="textarea" name="description" maxlength="500" placeholder="Product code, infrastructure and team collaboration"></textarea></div>
    <div class="form-grid"><div class="field"><label>Company size</label><select class="select" name="companySize">${sizes.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div><div class="field"><label>Website <span class="muted">optional</span></label><input class="input" name="website" type="url" placeholder="https://example.com" /></div></div>
    <div class="kg-onboarding-limit"><span>Free-plan ownership</span><b>${status.ownerCount} of ${status.ownerLimit} workspaces</b></div>
    <button class="btn btn-primary btn-block" type="submit" ${status.canCreate ? '' : 'disabled'}>${status.canCreate ? 'Create organization workspace →' : 'Workspace ownership limit reached'}</button>
    <div class="kg-onboarding-footer">You become Owner and a default Developers team is created automatically. Organization creation is recorded in the audit log.</div>
  </form>`;
}

function onboardingMarkup(status) {
  return `<div class="kg-onboarding">
    <div class="kg-onboarding-hero">
      <div class="kg-onboarding-copy">
        <div class="eyebrow">KukGit workspace onboarding</div>
        <h1>Set up your organization and start building.</h1>
        <p>Create the workspace that owns your repositories, teams, access policies and audit history. Your One Kuklabs Account remains your identity across the ecosystem.</p>
        <div class="kg-onboarding-points">
          <div class="kg-onboarding-point"><span>1</span><div><b>Private organization workspace</b><small>You become Owner with full organization administration.</small></div></div>
          <div class="kg-onboarding-point"><span>2</span><div><b>Developers team included</b><small>A default team is ready for members and repository grants.</small></div></div>
          <div class="kg-onboarding-point"><span>3</span><div><b>Secure by default</b><small>Verified identity, reserved-name protection and auditable creation.</small></div></div>
        </div>
      </div>
      <section class="card kg-onboarding-card"><div class="card-header"><div><h2>Create organization</h2><p>Choose a permanent workspace slug.</p></div><span class="badge public">Free</span></div><div class="card-body">${organizationFormMarkup(status)}</div></section>
    </div>
  </div>`;
}

async function checkSlug(input) {
  const status = document.querySelector('#kg-slug-status');
  const value = input.value.trim().toLowerCase();
  input.value = value.replace(/[^a-z0-9-]/g, '').replace(/^-+/, '').replace(/-{2,}/g, '-').slice(0, 63);
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.value)) {
    status.className = 'kg-slug-status bad';
    status.textContent = 'Use at least 2 lowercase letters, numbers or hyphens.';
    return false;
  }
  status.className = 'kg-slug-status';
  status.textContent = 'Checking availability…';
  try {
    const result = await onboardingRequest(`${ONBOARDING_API}/organizations/slug/${encodeURIComponent(input.value)}`);
    status.className = `kg-slug-status ${result.available ? 'good' : 'bad'}`;
    status.textContent = result.available ? 'Workspace URL is available.' : result.reason === 'reserved' ? 'This workspace URL is reserved.' : 'This workspace URL is already taken.';
    return result.available;
  } catch (error) {
    status.className = 'kg-slug-status bad';
    status.textContent = error.message;
    return false;
  }
}

function bindOnboarding(status) {
  const form = document.querySelector('#kg-organization-onboarding-form');
  const slugInput = form?.elements.slug;
  slugInput?.addEventListener('input', () => {
    clearTimeout(slugCheckTimer);
    slugCheckTimer = setTimeout(() => checkSlug(slugInput), 350);
  });
  if (slugInput) checkSlug(slugInput);

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Creating workspace…';
    try {
      if (!await checkSlug(slugInput)) throw new Error('Choose an available workspace URL.');
      const payload = await onboardingRequest(`${ONBOARDING_API}/organizations`, {
        method: 'POST',
        body: Object.fromEntries(new FormData(form)),
      });
      onboardingNotify('Organization created', `${payload.organization.name} is ready.`);
      location.hash = '#/organizations';
      location.reload();
    } catch (error) {
      onboardingNotify('Unable to create organization', error.message, 'error');
      button.disabled = !status.canCreate;
      button.textContent = 'Create organization workspace →';
    }
  });
}

function renderOnboarding(status) {
  const content = document.querySelector('.content');
  if (!content) return;
  const key = `${location.hash}:${status.ownerCount}:${status.organizations.length}`;
  if (onboardingRenderKey === key && document.querySelector('#kg-organization-onboarding-form')) return;
  onboardingRenderKey = key;
  content.innerHTML = onboardingMarkup(status);
  bindOnboarding(status);
}

function addCreateButton(status) {
  if (!status.canCreate || document.querySelector('#kg-create-organization-button')) return;
  const actions = document.querySelector('.content .page-actions');
  if (!actions) return;
  const button = document.createElement('button');
  button.id = 'kg-create-organization-button';
  button.className = 'btn btn-primary kg-create-organization';
  button.textContent = '＋ Create organization';
  button.addEventListener('click', () => { location.hash = '#/organizations?onboarding=1'; });
  actions.prepend(button);
}

async function accessibleRepositoryCount() {
  try {
    const payload = await onboardingRequest('/api/repos');
    return Array.isArray(payload.repositories) ? payload.repositories.length : 0;
  } catch { return 0; }
}

async function mountOrganizationOnboarding(force = false) {
  onboardingScheduled = false;
  if (document.querySelector('.login-page') || !document.querySelector('.app-shell')) return;
  injectOnboardingStyles();
  try {
    const status = await getOnboardingStatus(force);
    const route = routeState();
    if (!status.organizations.length && !invitationRoute() && route.path !== '/organizations') {
      const repositories = await accessibleRepositoryCount();
      if (!repositories) {
        location.hash = '#/organizations?onboarding=1';
        return;
      }
    }
    if (route.path === '/organizations' && (route.query.get('onboarding') === '1' || !status.organizations.length)) {
      renderOnboarding(status);
      return;
    }
    if (route.path === '/organizations') addCreateButton(status);
  } catch (error) {
    if (![401, 403].includes(error.status)) console.error('KukGit organization onboarding', error);
  }
}

function scheduleOrganizationOnboarding() {
  if (onboardingScheduled) return;
  onboardingScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(() => mountOrganizationOnboarding()));
}

window.addEventListener('hashchange', scheduleOrganizationOnboarding);
new MutationObserver(scheduleOrganizationOnboarding).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleOrganizationOnboarding();
