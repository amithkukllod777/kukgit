import crypto from 'node:crypto';
import { httpError, normalizeEmail } from './security.mjs';

/**
 * Checking that a Firebase ID token really came from Firebase.
 *
 * The browser does the work — the SMS, the reCAPTCHA, the carrier — and hands
 * KukGit a token saying "this person controls +91…". Everything then rests on
 * one question: did Google sign this, or did the browser make it up?
 *
 * The browser is not a source of truth. It is the thing being verified. So this
 * checks the signature against Google's own public certificates and then checks
 * every claim that stops a *valid* token being used in the wrong place:
 *
 *   * `aud` must be this project — a token minted for somebody else's Firebase
 *     project is a real Google-signed token, and without this check it would
 *     sign its holder in here
 *   * `iss` must be `securetoken.google.com/<project>` for the same reason
 *   * `exp` and `iat` must make sense, with a small allowance for clock drift
 *   * `sub` must be present and non-empty, because that is the identity
 *   * `auth_time` must not be in the future
 *
 * No SDK. Firebase publishes the certificates as x509 PEMs and Node verifies
 * RS256 out of the box, so this is about eighty lines and no dependency —
 * which matters, because a dependency in the path of "who is this person" is a
 * dependency that can sign anybody in.
 *
 * **This does not decide who the person is on KukGit.** It says what Google
 * asserts. `user-identities.mjs` decides whose account that is, with the same
 * rule it applies to GitHub and Google — a phone number or address only joins
 * an existing account when both sides have proved it.
 */

const CERTIFICATE_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

/**
 * How much clock difference to forgive.
 *
 * Servers drift. Refusing a token that was issued two seconds "in the future"
 * produces a sign-in failure nobody can reproduce and no log explains.
 */
export const CLOCK_TOLERANCE_SECONDS = 60;

/**
 * The certificates, cached until Google says they expire.
 *
 * Google rotates these. Fetching on every sign-in would put a network call
 * inside the login path; caching forever would break silently at rotation, and
 * the failure would look like "nobody can sign in" hours after a deploy that
 * changed nothing. `Cache-Control: max-age` is Google telling us when to ask
 * again, so that is what is used.
 */
function createCertificateCache() {
  let cached = null;
  return {
    async get(fetchImpl, now = Date.now()) {
      if (cached && cached.expiresAt > now) return cached.keys;
      let response;
      try {
        response = await fetchImpl(CERTIFICATE_URL, { headers: { Accept: 'application/json' } });
      } catch {
        throw httpError(503, 'Could not reach Google to check the sign-in.', 'FIREBASE_CERTS_UNREACHABLE');
      }
      if (!response.ok) throw httpError(503, 'Could not reach Google to check the sign-in.', 'FIREBASE_CERTS_UNREACHABLE');
      const keys = await response.json().catch(() => null);
      if (!keys || typeof keys !== 'object') throw httpError(503, 'Google returned no signing certificates.', 'FIREBASE_CERTS_INVALID');

      const maxAge = /max-age=(\d+)/i.exec(response.headers.get('cache-control') ?? '');
      // An hour when Google does not say. Short enough that a rotation is
      // picked up the same day, long enough not to be a call per sign-in.
      const seconds = maxAge ? Math.max(60, Number(maxAge[1])) : 3600;
      cached = { keys, expiresAt: now + seconds * 1000 };
      return keys;
    },
    forget() { cached = null; },
  };
}

const certificates = createCertificateCache();

/** Test seam, and the way a host swaps the fetch out. */
export function forgetFirebaseCertificates() {
  certificates.forget();
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(String(segment), 'base64url').toString('utf8'));
}

function invalid(message = 'This sign-in could not be verified. Try again.') {
  return httpError(401, message, 'FIREBASE_TOKEN_INVALID');
}

/**
 * @param {string} idToken what the browser handed over
 * @param {string} projectId the Firebase project this instance belongs to
 */
export async function verifyFirebaseIdToken(idToken, {
  projectId,
  now = new Date(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const project = String(projectId ?? '').trim();
  if (!project) throw httpError(503, 'Firebase sign-in is not configured.', 'FIREBASE_NOT_CONFIGURED');

  const parts = String(idToken ?? '').split('.');
  if (parts.length !== 3) throw invalid();

  let header;
  let claims;
  try {
    header = decodeSegment(parts[0]);
    claims = decodeSegment(parts[1]);
  } catch {
    throw invalid();
  }

  // `alg` is checked before anything is verified. A token asking to be checked
  // with `none`, or with an HMAC whose key is a public certificate, is the
  // oldest way to forge one.
  if (header?.alg !== 'RS256' || !header?.kid) throw invalid();

  const keys = await certificates.get(fetchImpl, now.getTime());
  const certificate = keys[header.kid];
  // An unknown key id is not a reason to try the other keys. It means this was
  // not signed by anything Google is currently publishing.
  if (!certificate) throw invalid();

  let publicKey;
  try {
    publicKey = new crypto.X509Certificate(certificate).publicKey;
  } catch {
    throw httpError(503, 'Google returned a certificate that could not be read.', 'FIREBASE_CERTS_INVALID');
  }

  const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
  const signature = Buffer.from(parts[2], 'base64url');
  if (!crypto.verify('RSA-SHA256', signed, publicKey, signature)) throw invalid();

  // Signature good. Now the claims that stop a genuine token being used here
  // when it was not meant for here.
  const seconds = Math.floor(now.getTime() / 1000);
  if (claims.aud !== project) throw invalid();
  if (claims.iss !== `https://securetoken.google.com/${project}`) throw invalid();
  if (!Number.isFinite(claims.exp) || claims.exp + CLOCK_TOLERANCE_SECONDS <= seconds) {
    throw httpError(401, 'This sign-in has expired. Try again.', 'FIREBASE_TOKEN_EXPIRED');
  }
  if (!Number.isFinite(claims.iat) || claims.iat - CLOCK_TOLERANCE_SECONDS > seconds) throw invalid();
  if (Number.isFinite(claims.auth_time) && claims.auth_time - CLOCK_TOLERANCE_SECONDS > seconds) throw invalid();
  const subject = String(claims.sub ?? '');
  if (!subject || subject.length > 191) throw invalid();

  return {
    subject,
    // Firebase reports these separately from the identity, and both are only
    // present when that method was actually used.
    phoneNumber: claims.phone_number ? String(claims.phone_number) : null,
    email: claims.email ? normalizeEmail(claims.email) : null,
    // Read, never assumed — the same rule as GitHub and Google. It is what
    // stands between linking to an existing account and handing one away.
    emailVerified: claims.email_verified === true,
    displayName: claims.name ? String(claims.name) : null,
    signInProvider: String(claims.firebase?.sign_in_provider ?? ''),
    issuedAt: Number(claims.iat),
    expiresAt: Number(claims.exp),
  };
}

/**
 * The subset of a verified token that proves a phone number.
 *
 * Refuses anything that is not actually a phone sign-in. A token from a Google
 * or GitHub sign-in through the same Firebase project is perfectly valid and
 * says nothing about a phone, and treating it as proof would let somebody mark
 * any number as theirs.
 */
export function phoneFromFirebaseToken(verified) {
  if (verified?.signInProvider !== 'phone' || !verified.phoneNumber) {
    throw httpError(400, 'That sign-in did not prove a phone number.', 'FIREBASE_NOT_PHONE_SIGN_IN');
  }
  // E.164, which is what Firebase issues. Stored in one shape so the same
  // number cannot be recorded twice in two formats.
  const number = verified.phoneNumber.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(number)) {
    throw httpError(400, 'That phone number is not in a form we can record.', 'FIREBASE_PHONE_INVALID');
  }
  return { subject: verified.subject, phoneNumber: number };
}
