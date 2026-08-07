# Getting KukGit to Production

Updated: 2026-08-07

This is the current production gate for `main`. [DEPLOYMENT.md](DEPLOYMENT.md)
explains how to configure an instance; this document says what must be proved
before external users depend on it.

## 1. Decisions and infrastructure only an operator can supply

| Requirement | Why code cannot supply it |
| --- | --- |
| **A Linux host and persistent storage** | Git repositories, SQLite metadata and filesystem-backed objects must survive deployments. |
| **A TLS certificate and domain** | Production cookies and Git credentials require HTTPS. |
| **An explicit identity mode** | `local` and `authkit` are both supported. Production still defaults to `authkit` when the variable is omitted, so do not rely on omission. |
| **A real email sender** | Local signup, email verification, password reset, invitations and security notices need deliverable mail. |
| **Independent secret keys** | Encryption and signing boundaries must not share material. |
| **Off-instance backup storage** | A `.kgbak` on the same failed volume is not a backup. |
| **Real provider credentials** | Resend, Razorpay and Stripe adapters are tested against fixtures, but a real transaction or delivery requires the provider. |

### Choose the identity mode

KukGit owns first-party accounts. For an external-customer deployment, select
`local` deliberately and provide HTTPS, Secure cookies, founder credentials and
working Resend or SMTP delivery:

```bash
NODE_ENV=production
KUKGIT_AUTH_MODE=local
KUKGIT_BASE_URL=https://git.example.com
KUKGIT_COOKIE_SECURE=true
KUKGIT_ADMIN_EMAIL=founder@example.com
KUKGIT_ADMIN_PASSWORD=<long-private-password>
KUKGIT_RESEND_API_KEY=<real-key>
```

One Kuklabs Account remains available as optional `authkit` mode. Use it only
when the shared service's availability and rate limit fit the deployment:

```bash
NODE_ENV=production
KUKGIT_AUTH_MODE=authkit
KUKGIT_BASE_URL=https://git.example.com
KUKGIT_COOKIE_SECURE=true
KUKGIT_AUTHKIT_BASE_URL=https://auth.kuklabs.com
KUKGIT_AUTHKIT_PRODUCT_ID=kukgit
KUKGIT_AUTHKIT_ENCRYPTION_KEY=<independent-random-key>
```

Read [Deployment](DEPLOYMENT.md) for the complete configuration and
[One Kuklabs Account](ONE_KUKLABS_ACCOUNT.md) for the optional integration's
availability and rate-limit boundaries.

### Generate the keys separately

The current deploy check validates these five values and refuses duplicates:

```bash
for key in KUKGIT_AUTHKIT_ENCRYPTION_KEY KUKGIT_SECRETS_ENCRYPTION_KEY \
           KUKGIT_WEBHOOK_ENCRYPTION_KEY KUKGIT_LFS_AUTH_KEY \
           KUKGIT_EMAIL_PROVIDER_WEBHOOK_SECRET; do
  printf '%s=%s\n' "$key" "$(openssl rand -base64 48)"
done
```

`KUKGIT_SECRETS_ENCRYPTION_KEY` must be retained separately from backup
archives. Backups contain ciphertext, not this key; losing it means every
stored secret must be entered again.

## 2. Before the first external user

1. **Restore trustworthy repository CI.** GitHub-hosted Actions for this
   repository have been failing before their first step because the account has
   not received a runner. Resolve the account-level problem or install a trusted
   self-hosted runner, then execute `.github/workflows/ci.yml` from the exact
   commit being released.
2. **Run the local equivalent with PostgreSQL available.** Install dependencies,
   start PostgreSQL 16 with `npm run postgres:dev`, export the printed
   `KUKGIT_TEST_POSTGRES_URL`, and run `npm run ci`. A skipped PostgreSQL step is
   not a full pass.
3. **Run `npm run deploy:check` on the target host** with the exact production
   environment. Fix failures and review every warning.
4. **Prove recovery.** Run `npm run rehearse` against a production-sized archive
   and sign off the manual transport, identity and email checks in its evidence.
5. **Send backups off-instance.** Verify restore access from a machine other
   than the application host and confirm retention pruning.
6. **Exercise the selected identity mode.** For `local`, test signup, email
   verification, password reset, TOTP and recovery codes. For `authkit`, test
   login, refresh rotation, service outage and central device revocation.
7. **Run provider smoke tests.** Confirm a Resend delivery and, before accepting
   payment, one Razorpay and one Stripe test-mode checkout plus webhook.
8. **Wire monitoring.** Alert on readiness, critical instance health, storage,
   failed delivery queues, backups and recovery age.

## 3. Deployment topology

Job leases, stranded-row recovery, cross-instance notification fan-out,
concurrent migration locking and connection draining are implemented. They
remove the earlier guarantee that two processes would double-send every job.

That is not proof of high availability. Start private alpha with one application
instance unless the real load balancer, shared data volume or object store,
rollout drain and failure recovery have been rehearsed together. PostgreSQL is
not yet the authoritative runtime, and the SQLite storage topology remains the
binding operational decision.

## 4. Signup and public exposure boundary

The repository now includes first-party signup, verified email, password reset,
TOTP recovery, OAuth sign-in, abuse reports, reversible moderation, secret
scanning, push protection, status/incident pages, billing/metering and
S3-compatible LFS storage.

Public exposure still requires operational work:

- Resend, Razorpay and Stripe have not been verified against real providers
- repository, LFS, CI, artifact and package quota enforcement is incomplete
- hosted multi-tenant runners have no selected or penetrated sandbox
- operating-system, container and Git-side vulnerability coverage is incomplete
- package/container registries, release assets and code search are not built
- PostgreSQL cutover and backend-aware recovery remain open under issue #43

## 5. Workflow execution

Workflow parsing, secrets, scheduling, authorization, logs, triggers, artifacts,
caches, required-check publication and the self-hosted runner agent are built.
Private alpha jobs run on machines the operator controls with
`npm run runner` or the systemd installer.

Hosted multi-tenant execution is later work. Do not write a custom sandbox.
Select and validate Firecracker, gVisor or Kata on a real host, then test escape,
egress and resource-exhaustion boundaries before accepting untrusted jobs.

## 6. Private-alpha release checklist

- [ ] identity mode selected explicitly and exercised end to end
- [ ] email delivery authenticated with SPF, DKIM and DMARC
- [ ] five deploy-check keys generated independently and stored safely
- [ ] `npm run deploy:check` passes on the target host
- [ ] `npm run ci` passes with no skipped PostgreSQL step
- [ ] the release commit executes successfully in repository CI
- [ ] production-sized recovery rehearsal signed off
- [ ] backups stored and restored off-instance
- [ ] monitoring and paging connected
- [ ] self-hosted runner installed only on trusted execution hosts
- [ ] real-provider smoke tests completed for every enabled integration

## 7. Honest current state

| Area | Current state |
| --- | --- |
| Authentication | KukGit-owned local accounts and optional AuthKit; both production-capable |
| Runtime dependency | `pg` plus its transitive packages; loaded only for PostgreSQL paths |
| Authoritative metadata | SQLite |
| PostgreSQL | Stages 1–7 delivered; production cutover and backend-aware restore not enabled |
| Workflow execution | Self-hosted runner delivered; hosted multi-tenant runner not delivered |
| Multi-instance foundation | Leases, fan-out, migration locking and drain implemented; deployment-specific HA not proved |
| Provider validation | Fixture-tested; real Resend/Razorpay/Stripe validation outstanding |
| Repository CI | Local parity command exists; hosted Actions execution remains an external blocker |

Do not copy a hard-coded test count into a release decision. Run `npm run ci`
from the commit being released and keep its complete result as evidence.
