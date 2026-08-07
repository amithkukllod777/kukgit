# Self-service signup

KukGit can offer email/password self-service signup when the instance owns local accounts and has a working transactional email sender.

## Browser flow

1. The sign-in form shows **Create an account**.
2. `#/signup` asks for display name, email, password and password confirmation.
3. The browser sends `POST /api/account/signup` with `displayName`, `email` and `password`.
4. A successful request always becomes the same browser-owned **Check your inbox** screen.
5. Signup does **not** create a browser session. The email verification link is the activation step for a new self-service account.
6. After verification, the user signs in normally.

## Account-enumeration boundary

The server deliberately returns the same `202` response whether the email address is new or already belongs to a KukGit account. The browser does not render the upstream success body; it renders one fixed accepted message:

> Check your inbox — if that address can be used, a link to finish setting up is on its way.

For an existing address, no account is created. The owner receives a rate-limited security email explaining that somebody tried to sign up with the address.

Do not add UI branches such as “account already exists”, “email available”, or different success pages. For a Git host, revealing whether an email address has an account can reveal whether a person or company uses the service.

## Password handling

The password policy is owned by the server. The browser only checks that the two password fields match before sending the request.

On recoverable validation errors the form stays mounted. Passwords remain only in the browser-owned password inputs; the signup module does not copy them into HTML strings, URLs, module state, logs or notifications.

## When signup is unavailable

`/api/account/signup` exists only when:

- `KUKGIT_AUTH_MODE=local`, and
- Resend or SMTP delivery is configured.

A signup route with a non-local authentication mode shows an instance-wide unavailable state without offering the local form. If local auth is enabled but email delivery is unavailable, the server returns `404` and the browser switches to the same unavailable state.

This prevents creation of accounts that cannot receive the verification link required to finish setup.

## Existing access paths

Self-service signup does not replace:

- organization or repository invitations,
- configured GitHub or Google provider sign-in,
- optional Kuklabs Account/AuthKit mode,
- existing local accounts.

The signup module does not replace a signed-in application shell.

## Verification and recovery

Email verification and password-reset screens are owned by `public/account-screens-ui.js`. The verification token remains in the URL fragment until spent so it is not sent in request URLs or Referer headers, and is removed after use.

An unverified self-service signup may sign in, but creation of organizations and repositories remains gated until the email address is verified.

## Tests

`test/signup-ui.test.mjs` covers:

- route ownership and sign-in link idempotence,
- request shape,
- generic success output independent of server response text,
- no authentication bootstrap after signup,
- password-confirmation preflight,
- recoverable validation behavior,
- signup-unavailable behavior,
- HTML escaping,
- signed-in shell isolation,
- the real `app.js` render race.

`test/signup-ui-authkit.test.mjs` separately pins the AuthKit-mode boundary.
