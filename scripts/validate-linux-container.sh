#!/usr/bin/env bash
# Runs inside ubuntu:24.04 (or similar). Disposable paths only; no host installs.
set -euo pipefail

SRC_REPO="${REPO:-/workspace}"
WORK="${RA_WORK_COPY:-/tmp/ra-workspace}"
EVIDENCE="${EVIDENCE:-/tmp/ra-validation-evidence}"
export HOME="${HOME:-/tmp/ra-home}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/ra-runtime}"

mkdir -p "${HOME}" "${EVIDENCE}" "${XDG_RUNTIME_DIR}"
chmod 700 "${HOME}" "${XDG_RUNTIME_DIR}"
rm -rf "${WORK}"
cp -a "${SRC_REPO}/." "${WORK}/"
cd "${WORK}"
REPO="${WORK}"

log() { echo "[validate-linux] $*"; }

log "node $(node -v)"
node scripts/assert-node-version.mjs 22.13.0 worker

log "npm ci"
npm ci --no-audit --no-fund 2>&1 | tee "${EVIDENCE}/npm-ci.log" | tail -3

log "npm run build"
npm run build 2>&1 | tee "${EVIDENCE}/npm-build.log" | tail -5

log "npm test"
npm test 2>&1 | tee "${EVIDENCE}/npm-test.log" | tail -8

log "doctor"
SERVER_URL=https://ci.example.test WORKER_TOKEN=ci-token-not-real \
  node scripts/doctor.mjs --json 2>&1 | tee "${EVIDENCE}/doctor.json"

log "smoke-preflight"
SERVER_URL=https://ci.example.test WORKER_TOKEN=ci-token-not-real \
  node scripts/smoke-preflight.mjs 2>&1 | tee "${EVIDENCE}/smoke-preflight.log"

log "nginx whitelist render (preserve \$host / \$http_upgrade)"
export REMOTE_AGENTS_DOMAIN=ci.example.test
export REMOTE_AGENTS_PORT=3847
export REMOTE_AGENTS_ACME_ROOT=/var/www/remote-acme
bash deploy/render-nginx-template.sh http-only "${EVIDENCE}/nginx-whitelist.conf"
grep -q 'ci.example.test' "${EVIDENCE}/nginx-whitelist.conf"
grep -q '\$host' "${EVIDENCE}/nginx-whitelist.conf"
grep -q '\$http_upgrade' "${EVIDENCE}/nginx-whitelist.conf"

log "reject src==dest"
if REMOTE_AGENTS_DOMAIN=ci.example.test RA_SERVER_INSTALL_ROOT="${REPO}" \
  bash deploy/install-server.sh "${REPO}" >/dev/null 2>&1; then
  echo "expected src==dest failure" >&2
  exit 1
fi

log "systemd template render"
sed \
  -e 's|{{REMOTE_AGENTS_INSTALL_DIR}}|/opt/remote-agents|g' \
  -e 's|{{REMOTE_AGENTS_STATE_DIR}}|/var/lib/remote-agents|g' \
  -e 's|{{REMOTE_AGENTS_SERVICE_USER}}|www-data|g' \
  deploy/systemd/remote-agents.service.template > "${EVIDENCE}/remote-agents.service"
grep -q ExecStart "${EVIDENCE}/remote-agents.service"

log "worker linux install (file-only)"
cat > "${REPO}/.env" <<'EOF'
SERVER_URL=https://ci.example.test
WORKER_TOKEN=ci-token-with spaces and "quotes"
CURSOR_API_KEY=sk-test-not-real
WORKER_ID=linux-ci-primary
EOF
chmod 600 "${REPO}/.env"
RA_SKIP_SYSTEMD=1 bash apps/worker/scripts/install-linux.sh 2>&1 | tee "${EVIDENCE}/install-linux.log"
test -f "${HOME}/.config/systemd/user/remote-agents-worker.service"
test -f "${HOME}/.local/share/remote-agents-worker/worker.env"
grep -q 'EnvironmentFile=-' "${HOME}/.config/systemd/user/remote-agents-worker.service"
if grep -q 'ci-token' "${HOME}/.config/systemd/user/remote-agents-worker.service"; then
  echo "secret leaked into systemd unit" >&2
  exit 1
fi
RA_SKIP_SYSTEMD=1 bash apps/worker/scripts/install-linux.sh 2>&1 | tee "${EVIDENCE}/install-linux-rerun.log"

log "server reinstall preserves .env + session sentinel (absent from source)"
SERVER_ROOT="${EVIDENCE}/server-reinstall-root"
rm -rf "${SERVER_ROOT}"
mkdir -p "${SERVER_ROOT}/apps/server/data/sessions"
echo 'WORKER_TOKEN=sentinel-secret-keep' > "${SERVER_ROOT}/.env"
echo 'SENTINEL_SESSION_STATE' > "${SERVER_ROOT}/apps/server/data/sessions/sentinel.txt"
chmod 600 "${SERVER_ROOT}/.env"
chmod 750 "${SERVER_ROOT}/apps/server/data" "${SERVER_ROOT}/apps/server/data/sessions"

REMOTE_AGENTS_DOMAIN=ci.example.test \
  RA_SERVER_INSTALL_ROOT="${SERVER_ROOT}" \
  RA_SKIP_SYSTEMCTL=1 \
  RA_SKIP_NGINX=1 \
  RA_SYSTEMD_UNIT_OUT="${EVIDENCE}/server-unit-first.service" \
  RA_NGINX_RENDER_OUT="${EVIDENCE}/server-nginx-first.conf" \
  bash deploy/install-server.sh "${REPO}" 2>&1 | tee "${EVIDENCE}/install-server-first.log"

grep -q 'sentinel-secret-keep' "${SERVER_ROOT}/.env"
grep -q 'SENTINEL_SESSION_STATE' "${SERVER_ROOT}/apps/server/data/sessions/sentinel.txt"

REMOTE_AGENTS_DOMAIN=ci.example.test \
  RA_SERVER_INSTALL_ROOT="${SERVER_ROOT}" \
  RA_SKIP_SYSTEMCTL=1 \
  RA_SKIP_NGINX=1 \
  RA_SYSTEMD_UNIT_OUT="${EVIDENCE}/server-unit-rerun.service" \
  RA_NGINX_RENDER_OUT="${EVIDENCE}/server-nginx-rerun.conf" \
  bash deploy/install-server.sh "${REPO}" 2>&1 | tee "${EVIDENCE}/install-server-rerun.log"

grep -q 'preserved existing' "${EVIDENCE}/install-server-rerun.log"
grep -q 'sentinel-secret-keep' "${SERVER_ROOT}/.env"
grep -q 'SENTINEL_SESSION_STATE' "${SERVER_ROOT}/apps/server/data/sessions/sentinel.txt"
test ! -f "${SERVER_ROOT}/.env.production"

log "PASS — evidence in ${EVIDENCE}"
ls -la "${EVIDENCE}" | tee "${EVIDENCE}/manifest.txt"
