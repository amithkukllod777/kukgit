import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CLOCK_TOLERANCE_SECONDS,
  forgetFirebaseCertificates,
  phoneFromFirebaseToken,
  verifyFirebaseIdToken,
} from '../src/firebase-identity.mjs';

/**
 * Checking that a Firebase ID token really came from Firebase.
 *
 * The browser does the SMS and hands over a token saying "this person controls
 * this number". The browser is not a source of truth — it is the thing being
 * verified — so every test here is a way of lying to this function and watching
 * it refuse.
 *
 * A real signing key is generated for each run and a fake Google is served from
 * memory, so the signature path is genuinely exercised rather than stubbed. A
 * verifier tested against a stub that always says yes is a verifier that does
 * nothing.
 */

const PROJECT = 'kukchat-b6402';

function authority() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  // A self-signed certificate is what Google publishes, so that is what the
  // fake publishes too — the code reads the public key out of an x509 PEM and
  // a bare public key would not exercise that.
  const certificate = selfSignedCertificate(publicKey, privateKey);
  const kid = 'test-key-1';

  const fetchImpl = async () => new Response(JSON.stringify({ [kid]: certificate }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
  fetchImpl.calls = 0;
  const counting = async (...args) => { counting.calls += 1; return fetchImpl(...args); };
  counting.calls = 0;

  const sign = (claims, { kid: overrideKid = kid, alg = 'RS256', signWith = privateKey } = {}) => {
    const header = Buffer.from(JSON.stringify({ alg, kid: overrideKid, typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    if (alg === 'none') return `${header}.${body}.`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), signWith).toString('base64url');
    return `${header}.${body}.${signature}`;
  };

  const seconds = Math.floor(Date.now() / 1000);
  const idToken = (overrides = {}, options = {}) => sign({
    aud: PROJECT,
    iss: `https://securetoken.google.com/${PROJECT}`,
    sub: 'firebase-uid-1',
    iat: seconds - 5,
    exp: seconds + 3600,
    auth_time: seconds - 5,
    phone_number: '+919999900000',
    firebase: { sign_in_provider: 'phone' },
    ...overrides,
  }, options);

  return { fetchImpl: counting, sign, idToken, privateKey, kid, seconds };
}

/** A minimal self-signed x509 certificate, the shape Google publishes. */
function selfSignedCertificate(publicKey, privateKey) {
  // Node has no certificate builder — `X509Certificate` only reads — so this
  // shells out to openssl. It keeps the test honest about what the code
  // actually parses: a PEM certificate, not a bare public key.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-fbcert-'));
  try {
    const keyPath = path.join(dir, 'key.pem');
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    return execFileSync('openssl', [
      'req', '-new', '-x509', '-key', keyPath, '-days', '1',
      '-subj', '/CN=securetoken.google.com',
    ], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test.beforeEach(() => forgetFirebaseCertificates());

/* ------------------------------------------------------- what it accepts */

test('a properly signed token for this project is accepted', async () => {
  const google = authority();
  const verified = await verifyFirebaseIdToken(google.idToken(), { projectId: PROJECT, fetchImpl: google.fetchImpl });

  assert.equal(verified.subject, 'firebase-uid-1');
  assert.equal(verified.phoneNumber, '+919999900000');
  assert.equal(verified.signInProvider, 'phone');
});

test('the certificates are fetched once and cached for as long as Google says', async () => {
  const google = authority();
  await verifyFirebaseIdToken(google.idToken(), { projectId: PROJECT, fetchImpl: google.fetchImpl });
  await verifyFirebaseIdToken(google.idToken(), { projectId: PROJECT, fetchImpl: google.fetchImpl });

  // A network call inside every sign-in is a login path that fails whenever
  // Google is slow. Caching forever breaks silently at rotation instead.
  assert.equal(google.fetchImpl.calls, 1);
});

/* ------------------------------------------------------ what it refuses */

test('a token signed by somebody else is refused', async () => {
  const google = authority();
  const impostor = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const forged = google.sign({
    aud: PROJECT,
    iss: `https://securetoken.google.com/${PROJECT}`,
    sub: 'firebase-uid-1',
    iat: google.seconds - 5,
    exp: google.seconds + 3600,
  }, { signWith: impostor.privateKey });

  await assert.rejects(
    () => verifyFirebaseIdToken(forged, { projectId: PROJECT, fetchImpl: google.fetchImpl }),
    { code: 'FIREBASE_TOKEN_INVALID' },
  );
});

test('a token asking to be checked with alg none is refused before anything else', async () => {
  const google = authority();
  const unsigned = google.sign({
    aud: PROJECT,
    iss: `https://securetoken.google.com/${PROJECT}`,
    sub: 'firebase-uid-1',
    iat: google.seconds,
    exp: google.seconds + 3600,
  }, { alg: 'none' });

  // The oldest forgery there is: the token names the algorithm and a verifier
  // that trusts it verifies nothing.
  await assert.rejects(
    () => verifyFirebaseIdToken(unsigned, { projectId: PROJECT, fetchImpl: google.fetchImpl }),
    { code: 'FIREBASE_TOKEN_INVALID' },
  );
});

test('an unknown key id is refused rather than tried against the other keys', async () => {
  const google = authority();
  const wrongKid = google.idToken({}, { kid: 'a-key-google-does-not-publish' });
  await assert.rejects(
    () => verifyFirebaseIdToken(wrongKid, { projectId: PROJECT, fetchImpl: google.fetchImpl }),
    { code: 'FIREBASE_TOKEN_INVALID' },
  );
});

test('a genuine token for a different Firebase project is refused', async () => {
  const google = authority();
  // This is the check people leave out. The token is real, Google signed it,
  // and it was minted for somebody else's app — anybody can create a Firebase
  // project and sign a user in.
  const otherProject = google.idToken({ aud: 'somebody-elses-project' });
  await assert.rejects(
    () => verifyFirebaseIdToken(otherProject, { projectId: PROJECT, fetchImpl: google.fetchImpl }),
    { code: 'FIREBASE_TOKEN_INVALID' },
  );

  const wrongIssuer = google.idToken({ iss: 'https://securetoken.google.com/somebody-elses-project' });
  await assert.rejects(
    () => verifyFirebaseIdToken(wrongIssuer, { projectId: PROJECT, fetchImpl: google.fetchImpl }),
    { code: 'FIREBASE_TOKEN_INVALID' },
  );
});

test('an expired token is refused, and says so distinctly', async () => {
  const google = authority();
  const stale = google.idToken({ exp: google.seconds - 3600 });
  await assert.rejects(
    () => verifyFirebaseIdToken(stale, { projectId: PROJECT, fetchImpl: google.fetchImpl }),
    // A different code from "invalid", because "your sign-in expired, try
    // again" is a different thing to tell somebody than "that was not real".
    { code: 'FIREBASE_TOKEN_EXPIRED' },
  );
});

test('a small amount of clock drift is forgiven, a large amount is not', async () => {
  const google = authority();
  // Servers drift. Refusing a token issued two seconds "in the future" is a
  // failure nobody can reproduce and no log explains.
  const slightlyAhead = google.idToken({ iat: google.seconds + 10 });
  assert.ok(await verifyFirebaseIdToken(slightlyAhead, { projectId: PROJECT, fetchImpl: google.fetchImpl }));

  const wayAhead = google.idToken({ iat: google.seconds + CLOCK_TOLERANCE_SECONDS + 120 });
  await assert.rejects(
    () => verifyFirebaseIdToken(wayAhead, { projectId: PROJECT, fetchImpl: google.fetchImpl }),
    { code: 'FIREBASE_TOKEN_INVALID' },
  );
});

test('a token with no subject signs nobody in', async () => {
  const google = authority();
  for (const sub of ['', undefined]) {
    await assert.rejects(
      () => verifyFirebaseIdToken(google.idToken({ sub }), { projectId: PROJECT, fetchImpl: google.fetchImpl }),
      { code: 'FIREBASE_TOKEN_INVALID' },
    );
  }
});

test('rubbish is refused without crashing', async () => {
  const google = authority();
  for (const value of ['', 'not-a-token', 'a.b', 'a.b.c.d', '....', null, undefined]) {
    await assert.rejects(
      () => verifyFirebaseIdToken(value, { projectId: PROJECT, fetchImpl: google.fetchImpl }),
      { code: 'FIREBASE_TOKEN_INVALID' },
      `${value} was not refused`,
    );
  }
});

test('an unconfigured project refuses rather than accepting anything', async () => {
  const google = authority();
  await assert.rejects(
    () => verifyFirebaseIdToken(google.idToken(), { projectId: '', fetchImpl: google.fetchImpl }),
    { code: 'FIREBASE_NOT_CONFIGURED' },
  );
});

test('Google being unreachable is a 503, not an accepted token', async () => {
  const dead = async () => { throw new Error('ECONNREFUSED'); };
  const google = authority();
  await assert.rejects(
    () => verifyFirebaseIdToken(google.idToken(), { projectId: PROJECT, fetchImpl: dead }),
    { code: 'FIREBASE_CERTS_UNREACHABLE' },
  );
});

/* --------------------------------------------------------- phone proof */

test('only a phone sign-in proves a phone number', async () => {
  const google = authority();
  const viaGoogle = await verifyFirebaseIdToken(
    google.idToken({ firebase: { sign_in_provider: 'google.com' }, phone_number: '+919999900000' }),
    { projectId: PROJECT, fetchImpl: google.fetchImpl },
  );

  // A Google or GitHub sign-in through the same Firebase project is a perfectly
  // valid token that says nothing about a phone. Treating it as proof would let
  // somebody mark any number as theirs.
  assert.throws(() => phoneFromFirebaseToken(viaGoogle), { code: 'FIREBASE_NOT_PHONE_SIGN_IN' });

  const viaPhone = await verifyFirebaseIdToken(google.idToken(), { projectId: PROJECT, fetchImpl: google.fetchImpl });
  assert.deepEqual(phoneFromFirebaseToken(viaPhone), { subject: 'firebase-uid-1', phoneNumber: '+919999900000' });
});

test('the number has to be in one shape, so it cannot be recorded twice', async () => {
  const google = authority();
  for (const phone_number of ['9999900000', '+91 99999 00000', '+0123', 'not a number']) {
    const verified = await verifyFirebaseIdToken(google.idToken({ phone_number }), { projectId: PROJECT, fetchImpl: google.fetchImpl });
    assert.throws(() => phoneFromFirebaseToken(verified), { code: 'FIREBASE_PHONE_INVALID' }, phone_number);
  }
});

test('an email in the token is reported with its verified flag, not without', async () => {
  const google = authority();
  const verified = await verifyFirebaseIdToken(
    google.idToken({ email: 'Amit@Kuklabs.com', email_verified: true, firebase: { sign_in_provider: 'google.com' } }),
    { projectId: PROJECT, fetchImpl: google.fetchImpl },
  );
  assert.equal(verified.email, 'amit@kuklabs.com');
  assert.equal(verified.emailVerified, true);

  const unproved = await verifyFirebaseIdToken(
    google.idToken({ email: 'amit@kuklabs.com', email_verified: false, firebase: { sign_in_provider: 'password' } }),
    { projectId: PROJECT, fetchImpl: google.fetchImpl },
  );
  // Same rule as GitHub and Google: read, never assumed.
  assert.equal(unproved.emailVerified, false);
});

/*
 * The three below exist because of mutation testing: each of these guards was
 * removed in turn and the suite still passed, which means nothing was actually
 * checking them. A guard no test can kill is a guard that can be deleted by
 * accident.
 */

test('the algorithm in the header is what gets used, so a token that names another one is refused', async () => {
  const google = authority();
  // Signed with the real key, correctly, over the real bytes — but the header
  // says HS256. Nothing downstream notices: the code picks RSA-SHA256 itself,
  // so the signature verifies and the token sails through unless `alg` is read
  // and refused up front. This is the shape of the classic JWT confusion bug.
  const mislabelled = google.idToken({}, { alg: 'HS256' });
  await assert.rejects(
    verifyFirebaseIdToken(mislabelled, { projectId: PROJECT, fetchImpl: google.fetchImpl }),
    { code: 'FIREBASE_TOKEN_INVALID' },
  );

  const unlabelled = google.idToken({}, { alg: null });
  await assert.rejects(
    verifyFirebaseIdToken(unlabelled, { projectId: PROJECT, fetchImpl: google.fetchImpl }),
    { code: 'FIREBASE_TOKEN_INVALID' },
  );
});

test('a token claiming it was signed in long after now is refused', async () => {
  const google = authority();
  // `iat` and `exp` are both sane; only `auth_time` is impossible. Firebase
  // reports it so a caller can require a *recent* sign-in, which is worth
  // nothing if the token gets to pick a time that has not happened.
  const future = google.idToken({ auth_time: google.seconds + CLOCK_TOLERANCE_SECONDS + 60 });
  await assert.rejects(
    verifyFirebaseIdToken(future, { projectId: PROJECT, fetchImpl: google.fetchImpl }),
    { code: 'FIREBASE_TOKEN_INVALID' },
  );
});

test('something that is not three segments is refused, not crashed on', async () => {
  const google = authority();
  const [header, body] = google.idToken().split('.');
  for (const malformed of [`${header}.${body}`, header, '', 'a.b.c.d']) {
    await assert.rejects(
      verifyFirebaseIdToken(malformed, { projectId: PROJECT, fetchImpl: google.fetchImpl }),
      // The distinction matters: a missing segment must be a 401 the sign-in
      // screen can show, not a TypeError that reaches the user as a 500.
      (error) => error.code === 'FIREBASE_TOKEN_INVALID' && error.status === 401,
      JSON.stringify(malformed),
    );
  }
});
