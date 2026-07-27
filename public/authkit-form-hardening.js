export function hardenAuthKitLoginCard(root = globalThis.document) {
  const card = root?.querySelector?.('.login-card[data-authkit="true"]');
  if (!card || String(card.tagName || '').toUpperCase() !== 'FORM') return card ?? null;

  const panel = root.createElement('section');
  panel.className = card.className;
  panel.dataset.authkit = 'true';
  panel.setAttribute('aria-label', 'One Kuklabs Account');

  while (card.firstChild) panel.append(card.firstChild);
  card.replaceWith(panel);
  return panel;
}

if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  const harden = () => hardenAuthKitLoginCard(document);
  new MutationObserver(harden).observe(document.querySelector('#app'), { childList: true, subtree: true });
  harden();
}
