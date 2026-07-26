# KukGit SSH Keys and Deploy Keys

KukGit supports Git clone, fetch and push over OpenSSH with user SSH keys and repository-scoped deploy keys.

## Key types

KukGit accepts one OpenSSH public key per request:

- `ssh-ed25519`
- `ecdsa-sha2-nistp256`
- `ecdsa-sha2-nistp384`
- `ecdsa-sha2-nistp521`
- `ssh-rsa` with a modulus of at least 2048 bits

KukGit validates the binary SSH key blob, not only the text prefix. Comments are discarded and the canonical public-key value is stored.

Fingerprints use the OpenSSH-compatible SHA-256 form:

```text
SHA256:<base64-without-padding>
```

An active fingerprint can belong to only one user key or one deploy key. Revoked keys no longer authenticate.

## User SSH keys

Users manage personal keys from **Settings → SSH keys**.

A user key inherits the user's effective repository permission:

- Read or higher: clone and fetch
- Write or higher: push
- Archived repositories: clone and fetch only

KukGit records the key's last-used timestamp and audits authenticated SSH fetch and push operations.

## Repository deploy keys

Repository Admins manage deploy keys from **Repository → Settings → Deploy keys and SSH clone**.

Each deploy key:

- is permanently scoped to one repository
- can be read-only or read/write
- cannot authenticate another repository
- is disabled while the repository is in Trash
- cannot push while the repository is archived

Use read-only deploy keys unless automation must push commits or tags.

## SSH clone URLs

Configure:

```text
KUKGIT_SSH_HOST=git.kuklabs.com
KUKGIT_SSH_PORT=22
KUKGIT_SSH_USER=git
```

Standard port:

```text
git@git.kuklabs.com:kuklabs/project.git
```

Custom port:

```text
ssh://git@git.kuklabs.com:2222/kuklabs/project.git
```

Clone example:

```bash
git clone git@git.kuklabs.com:kuklabs/project.git
```

## Forced commands

KukGit does not provide an interactive shell. OpenSSH passes the authenticated key identity to:

```text
node scripts/ssh-command.mjs --key-kind <user|deploy> --key-id <id>
```

The script reads `SSH_ORIGINAL_COMMAND` and accepts only these exact forms:

```text
git-upload-pack 'organization/repository.git'
git-receive-pack 'organization/repository.git'
```

Shell metacharacters, path traversal, alternate quoting, arbitrary commands, SFTP and interactive shells are rejected.

After authorization KukGit invokes Git with an argument array, not a shell command string:

```text
git upload-pack <absolute bare repository path>
git receive-pack <absolute bare repository path>
```

The environment is reduced to PATH, HOME, locale and a validated `GIT_PROTOCOL` value.

## Dynamic AuthorizedKeysCommand

Recommended production deployment uses OpenSSH `AuthorizedKeysCommand`, which makes key add/revoke changes effective immediately.

The included example is:

```text
infra/sshd_config.kukgit
```

Core settings:

```text
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowUsers git
AuthorizedKeysFile none
AuthorizedKeysCommand /usr/bin/env node /opt/kukgit/scripts/authorized-keys-command.mjs --fingerprint %f
AuthorizedKeysCommandUser git
AllowAgentForwarding no
AllowTcpForwarding no
X11Forwarding no
PermitTunnel no
PermitTTY no
```

Adjust the Node.js and application paths for the production host. The `git` operating-system account needs:

- read/write access to `KUKGIT_DATA_DIR`
- execute access to Node.js and Git
- read access to KukGit server scripts
- no password
- no administrative privileges

The dynamic command looks up the presented SHA-256 fingerprint and emits a restricted authorized-key line only when the key is active.

## Static authorized_keys mode

For environments that cannot use `AuthorizedKeysCommand`, generate a restricted file:

```bash
npm run ssh:authorized-keys
```

Default destination:

```text
KUKGIT_AUTHORIZED_KEYS_PATH=./data/ssh/authorized_keys
```

Custom destination:

```bash
node scripts/authorized-keys.mjs --output /home/git/.ssh/authorized_keys
```

Print without writing:

```bash
node scripts/authorized-keys.mjs --stdout
```

Static mode must be regenerated after every add or revoke operation. Dynamic mode is preferred.

Each generated line includes:

```text
restrict,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,command="..."
```

## Branch protection

SSH pushes execute against the same bare repositories used by Git smart HTTP. Existing pre-receive hooks therefore enforce KukGit branch protection rules for both transports.

The SSH authorization layer additionally blocks:

- users without effective Write permission
- read-only deploy keys
- deploy keys used against another repository
- revoked keys
- pushes to archived repositories
- access to repositories in Trash

## Browser API

Personal keys:

- `GET /api/ssh-keys`
- `POST /api/ssh-keys`
- `DELETE /api/ssh-keys/:keyId`

Deploy keys:

- `GET /api/ssh-keys/:org/:repo/deploy-keys`
- `POST /api/ssh-keys/:org/:repo/deploy-keys`
- `DELETE /api/ssh-keys/:org/:repo/deploy-keys/:keyId`

All writes enforce same-origin protection. Personal key operations are restricted to the authenticated user. Deploy-key operations require Repository Admin permission.

## Operational checklist

1. Create a dedicated unprivileged `git` OS account.
2. Configure a stable SSH hostname and port.
3. Install Node.js and Git using absolute production paths.
4. Set `KUKGIT_NODE_BINARY` and `KUKGIT_SSH_COMMAND_SCRIPT`.
5. Ensure the `git` account can access KukGit's database and bare repositories.
6. Install the restricted sshd configuration.
7. Validate sshd configuration before restart.
8. Register a test user key and verify clone/fetch.
9. Verify a read-only deploy key cannot push.
10. Verify an archived repository rejects SSH push.
11. Verify branch-protection hooks reject prohibited direct pushes.
12. Monitor verbose SSH authentication and KukGit audit logs.

## Security guidance

- Prefer Ed25519 keys for new user and machine credentials.
- Use a unique key for each device and automation workload.
- Never reuse a personal user key as a deploy key.
- Revoke lost, retired or shared keys immediately.
- Keep read/write deploy keys rare and repository-specific.
- Disable password, keyboard-interactive, forwarding, tunneling and PTY access.
- Run the SSH service account without sudo or shell privileges.
- Back up the database because key registrations and fingerprints are stored there.
- Rotate host keys and review SSH audit activity under an incident-response procedure.
