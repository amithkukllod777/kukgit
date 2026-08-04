# KukGit Integrations

Keys for email, payments and sign-in, set by an operator from the console rather
than by editing a file on the server.

```
https://git.kuklabs.com/#/instance-admin/integrations
```

| Integration | What it is for |
| --- | --- |
| **Resend** | Transactional email — invitations, notifications, security alerts |
| **Razorpay** | Payments in India — UPI, netbanking, cards, e-mandate |
| **Stripe** | Payments outside India — cards and subscriptions |
| **Google** | Sign-in with Google |
| **GitHub** | Sign-in with GitHub |

## Why not the environment file

Every one of these used to mean an SSH session, an editor, and a restart — and a
restart is where somebody discovers the key had a trailing space. It also meant
the person who can change a payment credential is the person who can reach the
server, which is a larger group than it should be and a worse-audited one.

## A secret is never read back

Not by the API, not by the console, not by an operator. There is no endpoint
that returns one.

What can be read is whether a field is set, a **fingerprint** so two people can
agree they mean the same key without either of them seeing it, and who set it
last. To change a secret you replace it.

An endpoint that returned the value would be one stolen session away from being
every credential the business has.

Secrets are encrypted with the same AES-256-GCM envelope the secrets vault uses,
bound to the integration and field name so a ciphertext moved between rows fails
to decrypt rather than quietly becoming a different secret. They need
`KUKGIT_SECRETS_ENCRYPTION_KEY`; without it, saving one fails rather than
storing anything readable.

The audit row carries the field, whether it was secret, and the fingerprint —
never the value, and not a prefix of it. An audit log is read by more people and
kept longer than this table is.

## Only declared settings exist

An unknown integration or field is refused, not stored. A settings table
anybody can put anything into is a settings table nobody can audit, and a typo
that saves happily becomes a value that silently never applies.

## The environment still wins

Where an environment variable is set, it wins, and the console says so on the
field rather than letting you type into something that will be ignored.

An environment file that looks authoritative while something else is quietly in
charge is worse than either source alone. To move a value into the console,
remove it from the environment first.

| Integration | Variables |
| --- | --- |
| Resend | `KUKGIT_RESEND_API_KEY`, `KUKGIT_EMAIL_FROM` |
| Razorpay | `KUKGIT_RAZORPAY_KEY_ID`, `KUKGIT_RAZORPAY_KEY_SECRET`, `KUKGIT_RAZORPAY_WEBHOOK_SECRET` |
| Stripe | `KUKGIT_STRIPE_PUBLISHABLE_KEY`, `KUKGIT_STRIPE_SECRET_KEY`, `KUKGIT_STRIPE_WEBHOOK_SECRET` |
| Google | `KUKGIT_GOOGLE_CLIENT_ID`, `KUKGIT_GOOGLE_CLIENT_SECRET` |
| GitHub | `KUKGIT_GITHUB_CLIENT_ID`, `KUKGIT_GITHUB_CLIENT_SECRET` |

## Configured is not switched on

An integration reports `complete` when every field is set, and `enabled`
separately. Enabling something half-configured is how a customer meets a
sign-in button that does not work, so the two are different decisions.

## Sign-in with Google and GitHub

Production identity is **One Kuklabs Account** — that is a standing constraint,
not a preference. Google and GitHub belong **inside** AuthKit, federated there,
not beside it as a second way into KukGit.

Storing the credentials here is fine and is what this page is for. Wiring them
as a KukGit-side sign-in path would create a second identity system in
production, and that needs a decision, not an implementation.

## What this does not do yet

Nothing is wired. This stores and serves the credentials; the code that uses
them comes next, one integration at a time:

- **Resend** — KukGit's email transport is currently SMTP. Resend is an HTTP API,
  which is a different transport, not a different configuration.
- **Razorpay and Stripe** — the billing core takes provider adapters
  ([BILLING.md](BILLING.md)); neither adapter is written.
- **Google and GitHub** — see above.

There is also no connection test. A key that is set is a key that is stored, not
a key that is known to work, and the console does not currently claim otherwise.

## Related

- [Billing](BILLING.md) — where the payment credentials will be used
- [Secrets vault](SECRETS_VAULT.md) — the same encryption, for repository secrets
- [One Kuklabs Account](ONE_KUKLABS_ACCOUNT.md) — the production identity mandate
