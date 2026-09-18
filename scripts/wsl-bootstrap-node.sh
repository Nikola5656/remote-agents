#!/usr/bin/env bash
# Bootstrap Node.js >= 22.13 inside WSL/Linux when missing (CI validation only).
set -euo pipefail

ROOT="${1:-.}"
MIN="22.13.0"

if command -v node >/dev/null 2>&1; then
  if node "${ROOT}/scripts/assert-node-version.mjs" "${MIN}" worker >/dev/null 2>&1; then
    echo "node bootstrap: existing $(node -v) satisfies >= ${MIN}"
    exit 0
  fi
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "wsl-bootstrap-node: apt-get unavailable; install Node >= ${MIN} manually" >&2
  exit 1
fi

echo "wsl-bootstrap-node: installing Node 22.x via NodeSource"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node "${ROOT}/scripts/assert-node-version.mjs" "${MIN}" worker
