#!/usr/bin/env bash
# Build release from git export, install prod deps, run runtime E2E (no source-mounted runtime).
set -euo pipefail

SRC_EXPORT="${EXPORT:-/export}"
WORK="/tmp/ra-export-work"
PKG_STAGE="/tmp/ra-runtime-package"
EVIDENCE="${EVIDENCE:-/tmp/fresh-runtime-e2e-evidence}"
HARNESS="${HARNESS:-/harness}"

rm -rf "${WORK}" "${PKG_STAGE}"
mkdir -p "${WORK}" "${PKG_STAGE}" "${EVIDENCE}"
cp -a "${SRC_EXPORT}/." "${WORK}/"
cd "${WORK}"

echo "[fresh-runtime-e2e] build release archive"
npm ci --no-audit --no-fund >/dev/null
npm run build >/dev/null
: "${CI_COMMIT_SHA:?set CI_COMMIT_SHA}"
node scripts/package-release.mjs >/dev/null
TARBALL="$(ls -1 release/remote-agents-*.tgz | head -1)"
tar -xzf "${TARBALL}" -C "${PKG_STAGE}"
PKG="${PKG_STAGE}/remote-agents"
test -d "${PKG}/apps/server/dist" && test -d "${PKG}/apps/worker/dist"

echo "[fresh-runtime-e2e] production install in unpacked package"
cd "${PKG}"
npx --yes npm@10.9.2 ci --omit=dev --ignore-scripts --no-audit --no-fund \
  --workspace @remote-agents/shared --workspace @remote-agents/server --workspace @remote-agents/worker >/dev/null

rm -rf "${WORK}"
echo "[fresh-runtime-e2e] removed build tree; runtime-only package at ${PKG}"

export E2E_EVIDENCE="${EVIDENCE}"
node "${HARNESS}/scripts/fresh-runtime-e2e.mjs" --package "${PKG}" | tee "${EVIDENCE}/run.json"
grep -q '"status": "PASS"' "${EVIDENCE}/run.json"
echo "[fresh-runtime-e2e] PASS"
