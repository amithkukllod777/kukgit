const WEBHOOKS_API = '/api/webhooks';
let webhookRenderKey = '';
let webhookScheduled = false;

function hookEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function hookNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${hookEscape(title)}</b><span>${hookEscape(message)}</span></div>`;
  root.append(element);
  setTimeout(() => element.remove(), 4600);
}

async function hookRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `Request failed (${response.status})`);
  return payload;
}

function hookRoute() {
  const [path] = location.hash.slice(1).split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== 'repo' || !segments[1] || !segments[2] || segments[3] !== 'settings') return null;
  return { org: segments[1], repo: segments[2] };
}

function hookDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

async function copyHookText(value) {
  try { await navigator.clipboard.writeText(value); }
  catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
}

function hookStyles() {
  if (document.querySelector('#kg-webhook-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-webhook-styles';
  style.textContent = `
    .kg-webhooks { margin-top:18px; }
    .kg-hook-grid { display:grid; grid-template-columns:minmax(320px,.75fr) minmax(0,1.25fr); gap:18px; }
    .kg-hook-form { display:grid; gap:13px; }
    .kg-hook-events { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
    .kg-hook-event { display:flex; gap:8px; align-items:center; padding:9px 10px; border:1px solid var(--border); border-radius:10px; background:rgba(255,255,255,.018); }
    .kg-hook-card { border:1px solid var(--border); border-radius:14px; padding:14px; margin-top:12px; background:rgba(255,255,255,.018); }
    .kg-hook-head { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .kg-hook-url { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; overflow-wrap:anywhere; }
    .kg-hook-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
    .kg-hook-secret { border:1px solid rgba(247,201,72,.38); background:rgba(247,201,72,.08); border-radius:14px; padding:14px; margin-bottom:14px; }
    .kg-hook-secret code { display:block; margin:9px 0; padding:11px; border-radius:9px; background:#06101c; color:#fff; overflow:auto; user-select:all; }
    .kg-hook-delivery { display:grid; grid-template-columns:minmax(150px,.7fr) minmax(140px,.6fr) minmax(200px,1fr) auto; gap:12px; align-items:start; padding:13px 0; border-top:1px solid var(--border); }
    .kg-hook-delivery:first-child { border-top:0; }
    .kg-hook-response { white-space:pre-wrap; max-height:100px; overflow:auto; font-size:11px; color:var(--muted); }
    .kg-hook-empty { text-align:center; color:var(--muted); padding:24px 10px; }
    @media (max-width:900px) { .kg-hook-grid { grid-template-columns:1fr; } .kg-hook-delivery { grid-template-columns:1fr; } .kg-hook-events { grid-template-columns:1fr; } }
  `;
  document.head.append(style);
}

function secretMarkup(secret, label = 'Copy your webhook secret now') {
  if (!secret) return '';
  return `<div class="kg-hook-secret"><b>${hookEscape(label)}</b><p class="muted">KukGit stores this encrypted and will not reveal the plaintext again.</p><code id="kg-hook-secret-value">${hookEscape(secret)}</code><button class="btn btn-primary" id="kg-hook-copy-secret">Copy secret</button></div>`;
}

function webhookCard(webhook) {
  return `<article class="kg-hook-card" data-webhook-id="${hookEscape(webhook.id)}">
    <div class="kg-hook-head"><div><div class="kg-hook-url">${hookEscape(webhook.url)}</div><div class="muted" style="font-size:11px;margin-top:5px">${webhook.events.map(hookEscape).join(' · ')} · Updated ${hookDate(webhook.updatedAt)}</div></div><span class="badge ${webhook.active ? 'public' : ''}">${webhook.active ? 'Active' : 'Disabled'}</span></div>
    <div class="kg-hook-actions"><button class="btn kg-hook-ping">Send ping</button><button class="btn kg-hook-toggle">${webhook.active ? 'Disable' : 'Enable'}</button><button class="btn kg-hook-rotate">Rotate secret</button><button class="btn btn-ghost kg-hook-delete">Delete</button></div>
  </article>`;
}

function deliveryBadge(status) {
  const cls = status === 'success' ? 'public' : status === 'failure' ? 'critical' : status === 'processing' ? 'high' : '';
  return `<span class="badge ${cls}">${hookEscape(status)}</span>`;
}

function deliveryRow(delivery, webhookMap) {
  const endpoint = webhookMap.get(delivery.webhookId)?.url || delivery.webhookId;
  const detail = delivery.lastError || delivery.responseBody || 'No response body recorded.';
  return `<div class="kg-hook-delivery" data-delivery-id="${hookEscape(delivery.id)}">
    <div><b>${hookEscape(delivery.event)}</b><div class="muted" style="font-size:11px">${hookEscape(delivery.id)}<br />${hookDate(delivery.createdAt)}</div></div>
    <div>${deliveryBadge(delivery.status)}<div class="muted" style="font-size:11px;margin-top:5px">Attempt ${delivery.attemptCount}${delivery.responseStatus ? ` · HTTP ${delivery.responseStatus}` : ''}</div></div>
    <div><div class="kg-hook-url">${hookEscape(endpoint)}</div><div class="kg-hook-response">${hookEscape(detail)}</div></div>
    <div><button class="btn btn-ghost kg-hook-redeliver">Redeliver</button></div>
  </div>`;
}

function panelMarkup(data, secret = null) {
  const webhookMap = new Map(data.webhooks.map((hook) => [hook.id, hook]));
  return `<section class="card kg-webhooks" id="kg-webhooks-panel">
    <div class="card-header"><div><h2>Repository webhooks</h2><p>Send signed repository events to CI, deployment and integration endpoints.</p></div><span class="badge public">${data.webhooks.length} configured</span></div>
    <div class="card-body">${secretMarkup(secret)}<div class="kg-hook-grid"><div>
      <form class="kg-hook-form" id="kg-hook-create"><div class="field"><label>Payload URL</label><input class="input" type="url" name="url" placeholder="https://example.com/kukgit/events" required /></div>
      <div class="field"><label>Optional signing secret</label><input class="input" name="secret" minlength="16" maxlength="256" placeholder="Leave blank to generate securely" /></div>
      <div class="field"><label>Events</label><div class="kg-hook-events">${data.availableEvents.filter((event) => event !== 'ping').map((event) => `<label class="kg-hook-event"><input type="checkbox" name="event" value="${hookEscape(event)}" ${['push','issues','pull_request','status'].includes(event) ? 'checked' : ''} />${hookEscape(event)}</label>`).join('')}</div></div>
      <button class="btn btn-primary" type="submit">Create webhook</button></form>
      <div class="login-demo" style="margin-top:14px"><b>Signed deliveries</b><br />Verify <code>X-KukGit-Signature-256</code> with HMAC-SHA256 before processing a payload. Production endpoints must use HTTPS and resolve to public networks.</div>
    </div><div><div id="kg-hook-list">${data.webhooks.length ? data.webhooks.map(webhookCard).join('') : '<div class="kg-hook-empty">No webhooks configured for this repository.</div>'}</div></div></div>
      <section class="card" style="margin-top:18px"><div class="card-header"><div><h3>Recent deliveries</h3><p>Inspect response status, retry failures and manually redeliver.</p></div><span class="badge">${data.deliveries.length} shown</span></div><div class="card-body" id="kg-hook-deliveries">${data.deliveries.length ? data.deliveries.map((delivery) => deliveryRow(delivery, webhookMap)).join('') : '<div class="kg-hook-empty">No webhook deliveries yet.</div>'}</div></section>
    </div>
  </section>`;
}

function showSecret(secret, label) {
  if (!secret) return;
  const panel = document.querySelector('#kg-webhooks-panel .card-body');
  panel?.insertAdjacentHTML('afterbegin', secretMarkup(secret, label));
  document.querySelector('#kg-hook-copy-secret')?.addEventListener('click', async () => {
    await copyHookText(secret);
    hookNotify('Secret copied', 'Store it in a secure password manager or secret vault.');
  });
}

function bindWebhookPanel(data, route) {
  document.querySelector('#kg-hook-copy-secret')?.addEventListener('click', async () => {
    const value = document.querySelector('#kg-hook-secret-value')?.textContent || '';
    await copyHookText(value);
    hookNotify('Secret copied', 'Store it in a secure password manager or secret vault.');
  });

  const form = document.querySelector('#kg-hook-create');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const events = [...form.querySelectorAll('[name="event"]:checked')].map((input) => input.value);
    if (!events.length) return hookNotify('Select an event', 'Choose at least one webhook event.', 'error');
    const dataForm = new FormData(form);
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const payload = await hookRequest(`${WEBHOOKS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`, {
        method: 'POST',
        body: { url: dataForm.get('url'), secret: dataForm.get('secret') || undefined, events },
      });
      hookNotify('Webhook created', 'The endpoint is ready for signed KukGit events.');
      await mountWebhooks(true);
      showSecret(payload.secret, 'Copy your new webhook secret now');
    } catch (error) {
      hookNotify('Webhook creation failed', error.message, 'error');
      button.disabled = false;
    }
  });

  document.querySelectorAll('[data-webhook-id]').forEach((card) => {
    const webhook = data.webhooks.find((item) => item.id === card.dataset.webhookId);
    card.querySelector('.kg-hook-ping')?.addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      try {
        const payload = await hookRequest(`${WEBHOOKS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/${encodeURIComponent(webhook.id)}/ping`, { method: 'POST' });
        hookNotify(payload.delivery.status === 'success' ? 'Ping delivered' : 'Ping queued for retry', payload.delivery.lastError || 'The endpoint accepted the signed ping.');
        await mountWebhooks(true);
      } catch (error) { hookNotify('Ping failed', error.message, 'error'); event.currentTarget.disabled = false; }
    });
    card.querySelector('.kg-hook-toggle')?.addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      try {
        await hookRequest(`${WEBHOOKS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/${encodeURIComponent(webhook.id)}`, { method: 'PATCH', body: { active: !webhook.active } });
        hookNotify(webhook.active ? 'Webhook disabled' : 'Webhook enabled', 'The subscription state was updated.');
        await mountWebhooks(true);
      } catch (error) { hookNotify('Update failed', error.message, 'error'); event.currentTarget.disabled = false; }
    });
    card.querySelector('.kg-hook-rotate')?.addEventListener('click', async (event) => {
      if (!window.confirm('Rotate this webhook secret? The previous secret will stop validating new deliveries immediately.')) return;
      event.currentTarget.disabled = true;
      try {
        const payload = await hookRequest(`${WEBHOOKS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/${encodeURIComponent(webhook.id)}`, { method: 'PATCH', body: { rotateSecret: true } });
        hookNotify('Secret rotated', 'Update the receiving service before the next delivery.');
        await mountWebhooks(true);
        showSecret(payload.secret, 'Copy the rotated webhook secret now');
      } catch (error) { hookNotify('Rotation failed', error.message, 'error'); event.currentTarget.disabled = false; }
    });
    card.querySelector('.kg-hook-delete')?.addEventListener('click', async (event) => {
      if (!window.confirm('Delete this webhook and its delivery history?')) return;
      event.currentTarget.disabled = true;
      try {
        await hookRequest(`${WEBHOOKS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/${encodeURIComponent(webhook.id)}`, { method: 'DELETE' });
        hookNotify('Webhook deleted', 'The endpoint will receive no further events.');
        await mountWebhooks(true);
      } catch (error) { hookNotify('Delete failed', error.message, 'error'); event.currentTarget.disabled = false; }
    });
  });

  document.querySelectorAll('.kg-hook-delivery').forEach((row) => row.querySelector('.kg-hook-redeliver')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      const payload = await hookRequest(`${WEBHOOKS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/deliveries/${encodeURIComponent(row.dataset.deliveryId)}/redeliver`, { method: 'POST' });
      hookNotify(payload.delivery.status === 'success' ? 'Delivery succeeded' : 'Delivery queued', payload.delivery.lastError || 'The endpoint accepted the payload.');
      await mountWebhooks(true);
    } catch (error) { hookNotify('Redelivery failed', error.message, 'error'); event.currentTarget.disabled = false; }
  }));
}

async function mountWebhooks(force = false) {
  const route = hookRoute();
  if (!route) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const key = `${route.org}/${route.repo}/${location.hash}`;
  if (!force && webhookRenderKey === key && document.querySelector('#kg-webhooks-panel')) return;
  webhookRenderKey = key;
  hookStyles();
  try {
    const data = await hookRequest(`${WEBHOOKS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`);
    document.querySelector('#kg-webhooks-panel')?.remove();
    content.insertAdjacentHTML('beforeend', panelMarkup(data));
    bindWebhookPanel(data, route);
  } catch (error) {
    if (!document.querySelector('#kg-webhooks-panel')) content.insertAdjacentHTML('beforeend', `<section class="card kg-webhooks" id="kg-webhooks-panel"><div class="card-body kg-hook-empty">${hookEscape(error.message)}</div></section>`);
  }
}

function scheduleWebhooks() {
  if (webhookScheduled) return;
  webhookScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    webhookScheduled = false;
    await mountWebhooks();
  }));
}

window.addEventListener('hashchange', scheduleWebhooks);
new MutationObserver(scheduleWebhooks).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleWebhooks();
