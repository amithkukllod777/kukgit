/**
 * The browser half of phone verification.
 *
 * Runs only on `/account/phone`, which is a separate document with a policy
 * that allows Google's hosts. See `src/phone-verify-page.mjs` for why that is
 * not the application's policy.
 *
 * What happens here:
 *
 *   1. ask the server for the project's public Firebase values
 *   2. load the Firebase SDK from Google
 *   3. reCAPTCHA, then the SMS, then the code — all Firebase's
 *   4. hand the resulting ID token to KukGit and go back
 *
 * **Step 4 is the only one that matters to KukGit's security, and it is not
 * decided here.** The token is checked against Google's published signing
 * certificates on the server before a number is recorded. Everything above it
 * is third-party code running in the browser, and it is treated that way: this
 * page cannot sign anybody in, cannot say whose account it is, and cannot make
 * a number verified by asserting that it is.
 */

const SDK_BASE = 'https://www.gstatic.com/firebasejs';

const errorBox = document.querySelector('#pv-error');
const doneBox = document.querySelector('#pv-done');
const numberForm = document.querySelector('#pv-number-form');
const codeForm = document.querySelector('#pv-code-form');

/**
 * Whether this is that page.
 *
 * The module belongs to one document and is loaded by one `<script>` tag, so in
 * principle this cannot be false. It is checked anyway because the alternative
 * to a check is a module that starts fetching and then throws on a null
 * element — and the thing it starts fetching is Google's SDK.
 */
const ON_THE_PAGE = Boolean(errorBox && doneBox && numberForm && codeForm);

function show(box, message) {
  box.textContent = message;
  box.hidden = false;
}

function clearError() {
  errorBox.hidden = true;
}

/**
 * Firebase's own error codes, turned into something a person can act on.
 *
 * A fixed table. `error.message` from the SDK is written for a developer and
 * sometimes contains the raw request, so it is not what gets shown.
 */
const MESSAGES = {
  'auth/invalid-phone-number': 'That does not look like a phone number. Include the country code, like +91.',
  'auth/missing-phone-number': 'Enter a phone number first.',
  'auth/quota-exceeded': 'Too many messages have been sent from this instance today. Try again tomorrow.',
  'auth/too-many-requests': 'Too many attempts from here. Wait a few minutes and try again.',
  'auth/invalid-verification-code': 'That code is not right. Check it and try again.',
  'auth/code-expired': 'That code has expired. Ask for a new one.',
  'auth/captcha-check-failed': 'The challenge did not pass. Reload the page and try again.',
  'auth/network-request-failed': 'Could not reach Google. Check your connection and try again.',
};

function readable(error) {
  const code = String(error?.code || '');
  if (MESSAGES[code]) return MESSAGES[code];
  // Deliberately generic. The SDK's own text is developer-facing and can echo
  // request contents back onto the page.
  return 'That did not work. Reload the page and try again.';
}

async function publicConfig() {
  const response = await fetch('/api/account/phone/config', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('This instance is not set up for phone verification.');
  return response.json();
}

async function recordWithKukGit(idToken) {
  const response = await fetch('/api/account/phone/verify', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    // In the body, not the URL: a token in a request URL is a token in an
    // access log.
    body: JSON.stringify({ idToken }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || 'KukGit could not record that number.');
  return payload;
}

async function start() {
  let settings;
  try {
    settings = await publicConfig();
  } catch (error) {
    show(errorBox, error.message);
    numberForm.hidden = true;
    return;
  }

  const version = String(settings.sdkVersion || '').replace(/[^0-9.]/g, '');
  const [{ initializeApp }, auth] = await Promise.all([
    import(`${SDK_BASE}/${version}/firebase-app.js`),
    import(`${SDK_BASE}/${version}/firebase-auth.js`),
  ]);

  const app = initializeApp({
    apiKey: settings.apiKey,
    authDomain: settings.authDomain,
    projectId: settings.projectId,
  });
  const firebaseAuth = auth.getAuth(app);
  // The message should arrive in the language the person is reading the page
  // in, not in whatever the project defaults to.
  firebaseAuth.useDeviceLanguage();

  // Visible rather than invisible. An invisible challenge that silently decides
  // somebody looks like a bot leaves them staring at a button that does
  // nothing, with no way to tell whether it is them or us.
  const verifier = new auth.RecaptchaVerifier(firebaseAuth, 'pv-recaptcha', { size: 'normal' });
  await verifier.render();

  let confirmation = null;

  numberForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    const button = document.querySelector('#pv-send');
    button.disabled = true;
    button.textContent = 'Sending…';
    try {
      const number = document.querySelector('#pv-number').value.replace(/[^\d+]/g, '');
      confirmation = await auth.signInWithPhoneNumber(firebaseAuth, number, verifier);
      numberForm.hidden = true;
      codeForm.hidden = false;
      document.querySelector('#pv-code').focus();
    } catch (error) {
      show(errorBox, readable(error));
      button.disabled = false;
      button.textContent = 'Send me a code';
      // A spent challenge cannot be reused, and leaving the old widget on
      // screen means the next attempt fails for a reason nobody can see.
      try { verifier.clear(); await verifier.render(); } catch { /* the reload message above covers it */ }
    }
  });

  codeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    const button = document.querySelector('#pv-confirm');
    button.disabled = true;
    button.textContent = 'Confirming…';
    try {
      const credential = await confirmation.confirm(document.querySelector('#pv-code').value.trim());
      const idToken = await credential.user.getIdToken();
      const result = await recordWithKukGit(idToken);
      // Signed out of Firebase straight away. KukGit's session is the one that
      // matters here; a Firebase session left behind is a second credential in
      // the browser that nothing uses and nothing expires.
      await auth.signOut(firebaseAuth).catch(() => {});
      codeForm.hidden = true;
      show(doneBox, `${result.phone} is now verified on your KukGit account.`);
      setTimeout(() => { location.href = '/#/settings'; }, 1500);
    } catch (error) {
      show(errorBox, error.code ? readable(error) : error.message);
      button.disabled = false;
      button.textContent = 'Confirm';
    }
  });
}

if (ON_THE_PAGE) {
  start().catch(() => show(errorBox, 'Phone verification could not start. Reload the page and try again.'));
}
