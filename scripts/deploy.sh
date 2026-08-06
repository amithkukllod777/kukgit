#!/usr/bin/env bash
#
# Upgrade a running KukGit instance, on the machine it runs on.
#
# The live server was set up by hand, one command at a time, across an evening.
# Nothing recorded how to put a new version on it — so every deploy was that
# evening again, from memory, at whatever hour the change was ready. This is
# that procedure, written down and made to fail safely.
#
# What it does, in order:
#
#   1. refuses to run if the working tree is dirty — a deploy that quietly
#      includes somebody's debugging edit is a deploy nobody can reproduce
#   2. records the commit that is running now, for the rollback
#   3. fetches and checks out the requested ref
#   4. installs production dependencies
#   5. runs the deployment checks and stops if any fail
#   6. backs up the database BEFORE restarting
#   7. restarts the service and waits for it to answer
#   8. rolls the code back and restarts again if it does not
#
# Usage, on the server:
#
#   ./scripts/deploy.sh              # deploy origin/main
#   ./scripts/deploy.sh v0.3.0       # deploy a tag or commit
#   ./scripts/deploy.sh --dry-run    # say what would happen and change nothing
#
# IT DOES NOT MIGRATE DOWN. Schema migrations are forward-only, so a rollback
# restores the code and leaves the newer schema in place. That is survivable for
# an additive migration — a column the old code ignores — and is not survivable
# for anything else. A release that changes a table in a way old code cannot
# read needs a human, and this script will have made the situation worse rather
# than better. Read the migration before deploying it.

set -euo pipefail

REF="${1:-origin/main}"
DRY_RUN=""
if [ "${REF}" = "--dry-run" ]; then DRY_RUN="yes"; REF="origin/main"; fi
if [ "${2:-}" = "--dry-run" ]; then DRY_RUN="yes"; fi

SERVICE="${KUKGIT_SERVICE:-kukgit}"
# The file systemd loads for the service. The check in step 5 has to read the
# same one, or it reports on a configuration nobody runs.
KUKGIT_ENV_FILE="${KUKGIT_ENV_FILE:-$HOME/kukgit.env}"
HEALTH_URL="${KUKGIT_HEALTH_URL:-http://127.0.0.1:${PORT:-8787}/}"
HEALTH_TIMEOUT="${KUKGIT_HEALTH_TIMEOUT:-60}"

cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
run() {
  if [ -n "${DRY_RUN}" ]; then printf '  would run: %s\n' "$*"; else "$@"; fi
}

# 1 ------------------------------------------------------------------ clean
if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has uncommitted changes:" >&2
  git status --short >&2
  echo >&2
  echo "A deploy that quietly includes an edit made on the server is a deploy" >&2
  echo "nobody can reproduce. Commit it, or 'git checkout -- .' to discard it." >&2
  exit 1
fi

# 2 --------------------------------------------------------------- rollback
PREVIOUS="$(git rev-parse HEAD)"
say "Running now: ${PREVIOUS} ($(git log -1 --format=%s))"

# 3 ------------------------------------------------------------------ fetch
say "Fetching ${REF}"
run git fetch --all --tags --prune
TARGET="$(git rev-parse "${REF}" 2>/dev/null || echo '')"
if [ -z "${TARGET}" ]; then echo "No such ref: ${REF}" >&2; exit 1; fi
if [ "${TARGET}" = "${PREVIOUS}" ]; then
  say "Already at ${TARGET}. Nothing to deploy."
  exit 0
fi
say "Deploying:  ${TARGET} ($(git log -1 --format=%s "${TARGET}"))"
git log --oneline "${PREVIOUS}..${TARGET}" | sed 's/^/  /' || true

run git checkout --detach "${TARGET}"

# 4 --------------------------------------------------------------- install
# `--omit=dev` because the tests do not run here; `--ignore-scripts` because a
# postinstall script from a dependency is code we did not review running as the
# user that owns the repositories.
say "Installing production dependencies"
run npm ci --omit=dev --ignore-scripts

# 5 ----------------------------------------------------------------- checks
#
# With the service's own environment, not the deploying shell's. The first real
# use of this script ran the check bare and it reported no base URL, no founder
# password and a data directory inside the checkout — none of which was true of
# the running service. A check reading the wrong environment is worse than no
# check, because its output looks like findings.
say "Checking the deployment"
if [ -f "${KUKGIT_ENV_FILE}" ]; then
  echo "  environment: ${KUKGIT_ENV_FILE}"
  set -a; . "${KUKGIT_ENV_FILE}"; set +a
else
  echo "  no environment file at ${KUKGIT_ENV_FILE}; checking with this shell's environment" >&2
fi

if [ -z "${DRY_RUN}" ]; then
  # The port check always fails here: the service holding the port is the one we
  # are about to restart. Everything else still has to pass, so the report is
  # read rather than the exit code.
  CHECKS="$(npm run --silent deploy:check -- --json || true)"
  BLOCKING="$(printf '%s' "${CHECKS}" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      let report;
      try { report = JSON.parse(raw); } catch { console.log("the deploy check produced no readable report"); return; }
      const failed = (report.checks || []).filter((entry) => entry.status === "fail" && entry.id !== "port");
      console.log(failed.map((entry) => entry.message).join("; "));
    });
  ')"
  npm run --silent deploy:check || true
  if [ -n "${BLOCKING}" ]; then
    echo >&2
    echo "Deployment checks failed: ${BLOCKING}" >&2
    echo "Returning to ${PREVIOUS} without restarting." >&2
    git checkout --detach "${PREVIOUS}"
    npm ci --omit=dev --ignore-scripts
    exit 1
  fi
else
  printf '  would run: npm run deploy:check\n'
fi

# 6 ---------------------------------------------------------------- backup
#
# `create`, not bare. Without the subcommand the backup script prints its usage
# and exits zero, so the first real use of this took no backup at all and said
# nothing about it.
say "Backing up before the restart"
run npm run --silent backup -- create

# 7 --------------------------------------------------------------- restart
say "Restarting ${SERVICE}"
run sudo systemctl restart "${SERVICE}"

if [ -n "${DRY_RUN}" ]; then
  say "Dry run finished. Nothing was changed."
  exit 0
fi

# 8 ----------------------------------------------------------------- health
say "Waiting for ${HEALTH_URL}"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
healthy=""
while [ "$(date +%s)" -lt "${deadline}" ]; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${HEALTH_URL}" || true)"
  if [ "${code}" = "200" ]; then healthy="yes"; break; fi
  sleep 2
done

if [ -z "${healthy}" ]; then
  echo >&2
  echo "${HEALTH_URL} did not answer within ${HEALTH_TIMEOUT}s. Rolling back." >&2
  echo "A server that is down has to be up before anybody debugs why." >&2
  git checkout --detach "${PREVIOUS}"
  npm ci --omit=dev --ignore-scripts
  sudo systemctl restart "${SERVICE}"
  echo >&2
  echo "Rolled back to ${PREVIOUS}. THE SCHEMA WAS NOT ROLLED BACK — if this" >&2
  echo "release migrated anything, the old code is now running against the new" >&2
  echo "schema. Check that before walking away." >&2
  echo "Logs: sudo journalctl -u ${SERVICE} -n 200 --no-pager" >&2
  exit 1
fi

say "Deployed ${TARGET}"
echo "  ${HEALTH_URL} answered 200"
echo "  previous: ${PREVIOUS}"
echo "  roll back with: ./scripts/deploy.sh ${PREVIOUS}"
