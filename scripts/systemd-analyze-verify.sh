#!/usr/bin/env bash
# Verify rendered systemd units with systemd-analyze inside a disposable Ubuntu container.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${SYSTEMD_VERIFY_IMAGE:-ubuntu:24.04}"

if ! command -v docker >/dev/null 2>&1; then
  echo "systemd-analyze-verify: docker not available" >&2
  exit 2
fi

docker run --rm \
  -v "${REPO}:/repo:ro" \
  -e HOME=/tmp/ra-home \
  "${IMAGE}" \
  bash /repo/scripts/systemd-analyze-verify-inner.sh
