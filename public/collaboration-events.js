async function copyInvitationLink(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
}

function showCopiedToast() {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const toast = document.createElement('div');
  toast.className = 'toast success';
  toast.innerHTML = '<div>✓</div><div><b>Invitation copied</b><span>The secure invitation link is in your clipboard.</span></div>';
  root.append(toast);
  setTimeout(() => toast.remove(), 4600);
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('#kg-copy-invitation');
  if (!button) return;
  const value = document.querySelector('#kg-invitation-url')?.textContent?.trim();
  if (!value) return;
  event.preventDefault();
  await copyInvitationLink(value);
  showCopiedToast();
});
