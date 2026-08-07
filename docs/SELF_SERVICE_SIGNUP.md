# Self-service signup

KukGit can offer email/password self-service signup when the instance owns local accounts and has a working transactional email sender.

The whole browser side lives in `public/account-screens-ui.js`, alongside email verification, password reset and the forgot-password form. It is one module because the four screens are one journey: they share a card, a style sheet, the links row on the sign-in form, and the rule that none of them may say whether an address has an account.

**One fragment, one owner.** `#/signup` is claimed by that module and nothing else. A second module claiming the same route does not fail — both write the whole of `#app`, each one's `MutationObserver` fires on the other's write, and the page rewrites itself forever with the form destroyed and rebuilt on every pass. That shipped once, when `signup-ui.js` arrived on a route `account-screens-ui.js` already owned. `test/public-page-routes.test.mjs` loads every module `index.html` lists and asserts the page comes to rest.

`app.js` must leave these routes alone entirely — see `WHOLE_PAGE_ROUTES` there. It listens for `hashchange` too, and a route it does not recognise is sent back to `#/`, which is not a rendering problem but an address problem: the fragment is gone before the owning module is scheduled to read it. Opening the address directly hides this, because a page load fires no `hashchange`; clicking the link is what exposes it.

## Browser flow

1. The sign-in form shows **Create an account**.
2. `#/signup` asks for display name, email, password and password confirmation. It is drawn in the same two-column frame as the sign-in page — `public/brand-hero.js`, shared with `app.js` so the two cannot drift.
3. The browser sends `POST /api/account/signup` with `displayName`, `email` and `password`.

**All four fields are required, the name included.** It used to fall back to the part of the address before the `@`, which fills a repository page with `info`, `devops2` and `a.kukllod` — a display name is what everybody else in an organization sees next to a commit, a review and a pull request, and an address is not one. Required on the form *and* on the server, so the API cannot accept what the UI forbids. It is refused before the address is looked up, like every other check here, so an empty name fails identically whether or not the account exists.
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

Both conditions are answered by one route. `GET /api/account/signup` returns `{"available":true}` where signup is offered and `404` where it is not — the same 404 the `POST` gives, because a route that answers "no" is still a route. It is public, like `/api/auth/providers`, because the sign-in screen renders before there is a session; it says whether this instance takes signups and nothing about any account.

The sign-in form's **Create an account** link is drawn only on that answer. A link to a form that collects a password and then reports the route as missing is worse than no link at all.

The `#/signup` screen draws its form without waiting for that answer, and replaces it with the unavailable state if the answer says so. Waiting would be the bug: the module renders before the application has finished asking who is signed in, and a screen that has drawn nothing yet is a screen `renderLogin()` paints over. Everything the late answer does is therefore conditional on that screen still being the one on the page — it must not land on a page somebody has navigated away to, and it must not overwrite an account that was just made.

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

An unverified self-service signup may sign in, but it cannot create an
organization until the email address is verified. Repository creation is not a
separate verification gate: it follows the user's effective permission in an
organization they can already access.

## Tests

`test/signup.test.mjs` covers the server: the identical answer for a new and an existing address, the warning email the existing address's owner gets instead, the availability route, and the 404 in AuthKit mode or with no mail sender.

`test/account-screens-ui.test.mjs` covers the browser:

- request shape, and the one accepted message whatever the server's body says,
- password-confirmation and length preflight, neither of which reaches the server,
- the server's own refusal on screen, escaped, with the form still there,
- `404` on submit reading as policy rather than as a broken site,
- the sign-in link present only where signup is offered, and asked for once,
- the two late-answer cases above,
- the screens with `app.js` running underneath, reached by **navigating** rather than by opening the address — a page load fires no `hashchange`, and every bug in this area so far has lived in the difference.

`test/public-page-routes.test.mjs` loads every module `index.html` lists and asserts the page comes to rest, with one signup card and one link to it.
