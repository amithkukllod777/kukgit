#!/usr/bin/env bash
#
# Install a KukGit self-hosted runner as a service, on the machine that will
# build things.
#
# `npm run runner` works, and it works only until the terminal it was typed in
# closes. A build machine that stops when somebody's laptop sleeps is a build
# machine nobody can rely on, and the failure looks like "CI is stuck" rather
# than "the runner is gone". This makes it a service.
#
# Usage:
#
#   sudo ./scripts/runner-install.sh --url https://git.kuklabs.com --token kgr_...
#   sudo ./scripts/runner-install.sh --url ... --token ... --labels android,jdk21
#   ./scripts/runner-install.sh --check         # say what it would do, change nothing
#
# READ THIS BEFORE INSTALLING ON A MACHINE YOU CARE ABOUT.
#
# A runner executes whatever the repository's workflow says, as the user it runs
# as. There is no sandbox. That is not an oversight to be fixed later — it is
# what a self-hosted runner is, on every system that has them — so the isolation
# has to come from the machine. This script does what it can from here:
#
#   * refuses to run the service as root, and creates a dedicated user with no
#     login shell and no sudo
#   * gives that user a home of its own, so a build cannot read the deploying
#     account's SSH keys, shell history or cloud credentials
#   * sets systemd's own restrictions: private /tmp, no new privileges, a
#     read-only system tree, and no access to other users' home directories
#
# What it cannot do is make a build safe for a machine that also runs something
# valuable. Put a runner on a machine you are willing to rebuild.

set -euo pipefail

KUKGIT_URL=""
RUNNER_TOKEN=""
LABELS=""
RUNNER_USER="${KUKGIT_RUNNER_USER:-kukgit-runner}"
SERVICE="${KUKGIT_RUNNER_SERVICE:-kukgit-runner}"
CHECK_ONLY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --url) KUKGIT_URL="${2:-}"; shift 2 ;;
    --token) RUNNER_TOKEN="${2:-}"; shift 2 ;;
    --labels) LABELS="${2:-}"; shift 2 ;;
    --user) RUNNER_USER="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --check) CHECK_ONLY="yes"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
CHECKOUT="$(pwd)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
run() {
  if [ -n "${CHECK_ONLY}" ]; then printf '  would run: %s\n' "$*"; else "$@"; fi
}

# 1 ------------------------------------------------------------- arguments
if [ -z "${CHECK_ONLY}" ] && { [ -z "${KUKGIT_URL}" ] || [ -z "${RUNNER_TOKEN}" ]; }; then
  echo "Both --url and --token are required." >&2
  echo "Get a runner token from Settings -> Runners in KukGit." >&2
  exit 2
fi

if [ -n "${RUNNER_TOKEN}" ] && ! printf '%s' "${RUNNER_TOKEN}" | grep -qE '^kgr_'; then
  # A personal access token or a session cookie pasted here would be sent to
  # the runner endpoint on every poll, forever, in a systemd unit file that
  # anybody on the box can read.
  echo "That does not look like a runner token: they begin with 'kgr_'." >&2
  echo "Do not paste a personal access token here." >&2
  exit 2
fi

# 2 --------------------------------------------------------------- node
say "Checking prerequisites"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. The runner needs the same major version as the server." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "Node ${NODE_MAJOR} is too old; the runner needs 22 or newer." >&2
  exit 1
fi
echo "  node $(node -v)"

# 3 ------------------------------------------------------------ reachable
#
# Before creating users and units. An unreachable instance means a typo in the
# URL, and finding that out after the service is installed means finding it out
# from a log nobody is watching.
if [ -n "${KUKGIT_URL}" ]; then
  say "Checking ${KUKGIT_URL}"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${KUKGIT_URL}/api/health" || true)"
  if [ "${CODE}" = "000" ]; then
    echo "Could not reach ${KUKGIT_URL}. Check the URL and the network." >&2
    [ -z "${CHECK_ONLY}" ] && exit 1
  else
    echo "  answered ${CODE}"
  fi
fi

# 4 ------------------------------------------------------------------ user
say "Runner user: ${RUNNER_USER}"
if id "${RUNNER_USER}" >/dev/null 2>&1; then
  echo "  exists"
else
  # No login shell, no password, its own home. A build that escapes the
  # workspace lands somewhere with nothing worth taking.
  run useradd --system --create-home --shell /usr/sbin/nologin "${RUNNER_USER}"
fi

if [ "$(id -u "${RUNNER_USER}" 2>/dev/null || echo 1)" = "0" ]; then
  echo "The runner user must not be root. Builds run as this user." >&2
  exit 1
fi

# 5 --------------------------------------------------------------- service
UNIT="/etc/systemd/system/${SERVICE}.service"
say "Writing ${UNIT}"

ARGS="--url ${KUKGIT_URL} --token ${RUNNER_TOKEN}"
[ -n "${LABELS}" ] && ARGS="${ARGS} --labels ${LABELS}"

UNIT_TEXT="[Unit]
Description=KukGit self-hosted runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUNNER_USER}
WorkingDirectory=${CHECKOUT}
ExecStart=$(command -v node) ${CHECKOUT}/scripts/runner.mjs ${ARGS}
Restart=always
RestartSec=5

# A build is somebody else's code. These are what systemd can enforce from
# outside it; none of them make it safe, and together they make it survivable.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/home/${RUNNER_USER}
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
"

if [ -n "${CHECK_ONLY}" ]; then
  printf '  would write:\n%s\n' "${UNIT_TEXT}"
else
  printf '%s' "${UNIT_TEXT}" > "${UNIT}"
  # The token is in this file. Anybody who can read it can register a runner
  # and be handed other people's build jobs.
  chmod 600 "${UNIT}"
fi

# 6 ----------------------------------------------------------------- start
say "Starting ${SERVICE}"
run systemctl daemon-reload
run systemctl enable "${SERVICE}"
run systemctl restart "${SERVICE}"

if [ -n "${CHECK_ONLY}" ]; then
  say "Check finished. Nothing was changed."
  exit 0
fi

sleep 3
if ! systemctl is-active --quiet "${SERVICE}"; then
  echo >&2
  echo "${SERVICE} did not stay up." >&2
  echo "Logs: journalctl -u ${SERVICE} -n 50 --no-pager" >&2
  exit 1
fi

say "Runner installed"
echo "  status: systemctl status ${SERVICE}"
echo "  logs:   journalctl -u ${SERVICE} -f"
echo "  stop:   systemctl disable --now ${SERVICE}"
echo
echo "It appears in KukGit under Settings -> Runners once it polls."
echo
echo "This machine now runs other people's code. Install build tools it needs"
echo "(a JDK, the Android SDK, Docker) as ${RUNNER_USER}, and do not put"
echo "anything on this machine you would mind losing."
