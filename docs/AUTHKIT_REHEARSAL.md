# The AuthKit rollout drill

```bash
npm run authkit:rehearse
npm run authkit:rehearse -- --operator "Amit" --evidence evidence/authkit-2026-08-07.json
```

[ONE_KUKLABS_ACCOUNT.md](ONE_KUKLABS_ACCOUNT.md) has always ended with a
checklist that says to *"verify OTP, password, Google, refresh, session and
product-access flows in staging"*, and the recovery rehearsal has three manual
sign-offs that say the same thing in different words. None of them could be
done, because there was nothing to verify against and no script to do the
verifying.

This is both. It stands up a real KukGit instance in AuthKit mode against a
stand-in Kuklabs AuthKit and drives every one of those flows over real HTTP with
a real cookie jar.

Nothing on the machine is touched: the instance is a throwaway directory that is
deleted when the drill finishes.

## What it proves, and what it does not

The unit tests around identity call the handlers directly. That proves the
handlers. This proves the **round trip** — that a browser talking to KukGit
talking to AuthKit ends up with the right cookie, the right refusal, and no
token it should never have seen.

It does **not** prove that the real AuthKit behaves the way the simulator does.
The record says so, in a field:

```json
{ "authkit": { "kind": "simulator" }, "confidence": "rehearsed" }
```

`rehearsed` is not `verified`. Feeding the evidence file into a recovery
rehearsal (`npm run rehearse -- --authkit-evidence <file>`) marks the three
AuthKit checks `rehearsed` and leaves their boxes unticked, because a stand-in
cannot sign off a production check however many times it passes.

Pointing the drill at a live AuthKit with `--url` is refused rather than
half-done: it would create accounts and revoke somebody's real device sessions.

## The checks

| | |
|---|---|
| `authkit.contract` | `/v1/auth/status` answers `kuklabs-authkit-rest/1` |
| `authkit.bad_password` | a wrong password is refused and creates no session |
| `authkit.login` | sign-in returns a cookie and links one local user row |
| `authkit.no_token_to_browser` | no access or refresh token reaches the browser |
| `authkit.tokens_encrypted_at_rest` | both stored secrets are ciphertext |
| `authkit.product_header` | every upstream request carries `X-Kuklabs-Product` |
| `authkit.otp_signup` | signup needs an OTP; verifying it opens a session |
| `authkit.google` | Google sign-in links through AuthKit |
| `authkit.refresh_rotation` | an expired access token triggers one refresh, and both secrets change |
| `authkit.refresh_replay` | KukGit never replays a spent refresh token |
| `authkit.device_revocation` | central revocation refuses the bridge and clears the cookie |
| `authkit.product_denied` | blocked product membership denies access |
| `authkit.fails_closed` | protected APIs refuse during an outage; health stays up |
| `authkit.outage_keeps_cookie` | an outage refuses without signing everybody out |
| `authkit.logout` | logout removes the bridge even with central logout down |

`refresh_rotation` compares the secrets **after decrypting them**. AES-GCM uses
a fresh IV every time, so comparing the stored ciphertext would report a
rotation whenever the row was rewritten — including when the same token was
re-encrypted unchanged.

The last two are a pair, and they pull in opposite directions. Failing closed
means refusing during an outage; keeping the cookie means refusing *without*
emptying every browser on a healthy instance because one dependency was briefly
unreachable. It is easy to fix either one and break the other, so both are
checked and both have a test that breaks the code and watches the drill notice.

## What it found

**A centrally revoked device session left the cookie behind.** KukGit deleted
the bridge and answered 401, but only the central-session guard cleared
`kukgit_session`; the identity middleware's expiry path did not. A browser whose
device had been signed out centrally kept sending a cookie that resolved to
nothing, on every request, until the tab was closed — while the documentation
said the cookie was cleared.

Fixed in `src/authkit-identity.mjs`, and only on 401. A 503 means AuthKit is
unreachable, not that the session ended, and clearing cookies during an outage
signs out an entire healthy instance.

## The simulator

`src/authkit-simulator.mjs` speaks `kuklabs-authkit-rest/1` over real HTTP. It
is deliberately not a permissive test double:

- access tokens expire on a clock, so a refresh has to actually happen
- refresh tokens rotate, and **replaying a spent one kills the device session** —
  which is what a real identity provider does, and the only way to find out
  whether KukGit ever replays one
- device sessions are rows that can be revoked one at a time
- a request without `X-Kuklabs-Product` is refused, and the omission is recorded
- `offline` makes every route fail, so failing closed can be observed

Signup deliberately answers **without** a `sid` in the response envelope, so the
path where KukGit reads the device-session id out of the access-token claims —
the one production depends on — is the one under test.

It is a simulator, not a mock: nothing in it knows what the drill wants. Where
the real service's behaviour is unknown it refuses rather than guesses, because
a stand-in more forgiving than production is a stand-in that certifies a bug.

It is not an identity provider. Passwords are compared in plain text and the OTP
code is fixed. It exists to be talked to, never to hold an account.

## What a staging run still has to prove

These need the real service and cannot be rehearsed here:

- that AuthKit's response envelopes match the shapes above — every field name
  KukGit reads is a guess until one real response has been seen
- that a real Google ID token links to the same central identity
- that a real OTP arrives, and within the window the product expects
- that `/v1/auth/sessions` reports `current` on the session that presented the
  token, which is what the whole device binding rests on
- that AuthKit's rate limits do not refuse KukGit's per-request validation under
  real load

## Running it in CI

`npm run ci` does not run the drill; the test suite does, through
`test/authkit-rehearsal.test.mjs`, which runs it once and then breaks the code
four separate ways to confirm the drill notices. A drill that cannot fail is a
green light wired to nothing.
