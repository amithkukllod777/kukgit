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
| `authkit.request_budget` | ten page loads spend at most three AuthKit requests |
| `authkit.rate_limited` | a `429` refuses the request without signing anybody out |

`refresh_rotation` compares the secrets **after decrypting them**. AES-GCM uses
a fresh IV every time, so comparing the stored ciphertext would report a
rotation whenever the row was rewritten — including when the same token was
re-encrypted unchanged.

The last two are a pair, and they pull in opposite directions. Failing closed
means refusing during an outage; keeping the cookie means refusing *without*
emptying every browser on a healthy instance because one dependency was briefly
unreachable. It is easy to fix either one and break the other, so both are
checked and both have a test that breaks the code and watches the drill notice.

## The twenty-requests-a-minute problem

The live service allows twenty requests a minute on `/v1/auth/*`, **per source
IP**, and KukGit calls it server-to-server — so every user of an instance shares
one bucket. KukGit asked three questions per protected browser request, which is
about six page loads a minute for the whole product.

The last two checks are about that, and they run on their own instance with the
real limit switched on, so they cannot make the others flap. The first thirteen
run against a simulator with the limit off, because each of them needs to see
KukGit *ask* AuthKit a question.

The drill now reports `10 page loads spent 0 AuthKit requests`.

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

No route puts a `sid` in the response envelope, because the live service does
not — it is in the access token's claims and nowhere else, so the claims path is
the only one KukGit can use and the only one worth testing.

It is a simulator, not a mock: nothing in it knows what the drill wants.

Since the real contract was read line by line, it matches it — twenty requests a
minute with the differently-shaped `429` body, `200` with `access: false` rather
than `403`, no `sid` in any envelope, three distinct messages behind one `401`,
and a 24-hour access token.

**One deliberate divergence:** the simulator revokes a device session when a
spent refresh token is replayed. The live service does not. Being stricter is
safe — a stand-in more forgiving than production is a stand-in that certifies a
bug — but it means `authkit.refresh_replay` proves KukGit never replays, not
that replaying would be punished.

It is not an identity provider. Passwords are compared in plain text and the OTP
code is fixed. It exists to be talked to, never to hold an account.

## What a staging run still has to prove

These need the real service and cannot be rehearsed here:

- that a real Google ID token links to the same central identity
- that a real OTP arrives, and within the window the product expects
- that a real signed-in session survives a real refresh rotation, and that the
  rotated token still carries the same `sid`
- that the revalidation window is short enough in practice — a revoked device
  keeps working for up to five minutes, and only real use says whether that is
  acceptable

The response shapes are no longer on this list. They were read from the service's
own source, endpoint by endpoint, and the simulator was corrected to match; what
remains is behaviour under real accounts and real load.

There is no staging environment to do any of it in. One environment, live,
shared with every Kuklabs product — which is why `--url` is refused rather than
offered with a warning.

## Running it in CI

`npm run ci` does not run the drill; the test suite does, through
`test/authkit-rehearsal.test.mjs`, which runs it once and then breaks the code
six separate ways to confirm the drill notices. A drill that cannot fail is a
green light wired to nothing.
