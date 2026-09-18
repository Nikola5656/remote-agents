#!/usr/bin/env bash
# Host launcher: build ubuntu:24.04 container, run validate-linux-container.sh, copy evidence out.
set -euo pipefail

HOST_REPO="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE_HOST="${HOST_REPO}/../evidence/linux-container-validation-$(date -u +%Y%m%dT%H%M%SZ)"
SOURCE_EXPORT="$(mktemp -d)"
trap 'rm -rf "${SOURCE_EXPORT}"' EXIT
git -C "${HOST_REPO}" archive HEAD | tar -x -C "${SOURCE_EXPORT}"
IMAGE="ubuntu:24.04"

mkdir -p "${EVIDENCE_HOST}"

echo "==> building validation image from ${IMAGE}"
docker build -t remote-agents-linux-validation:local - <<'DOCKERFILE'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git gettext-base python3 rsync systemd \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
DOCKERFILE

echo "==> running validation in disposable container"
docker run --rm \
  -v "${SOURCE_EXPORT}:/workspace:ro" \
  -v "${EVIDENCE_HOST}:/tmp/ra-validation-evidence:rw" \
  -e REPO=/workspace \
  -e EVIDENCE=/tmp/ra-validation-evidence \
  -e HOME=/tmp/ra-home \
  -e XDG_RUNTIME_DIR=/tmp/ra-runtime \
  remote-agents-linux-validation:local \
  bash /workspace/scripts/validate-linux-container.sh

echo "==> evidence: ${EVIDENCE_HOST}"
cat "${EVIDENCE_HOST}/manifest.txt"
