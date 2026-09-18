#!/usr/bin/env bash
# Host launcher: git export -> Ubuntu container -> packaged runtime E2E.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

resolve_host_repo() {
  local candidate="${REMOTE_AGENTS_SOURCE_REPO:-}"
  if [[ -n "${candidate}" ]]; then
    candidate="$(cd "${candidate}" && pwd)"
    if ! git -C "${candidate}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      echo "REMOTE_AGENTS_SOURCE_REPO is not a git repository: ${candidate}" >&2
      exit 1
    fi
    if [[ ! -f "${candidate}/package.json" || ! -d "${candidate}/apps/server" ]]; then
      echo "REMOTE_AGENTS_SOURCE_REPO does not look like remote-agents: ${candidate}" >&2
      exit 1
    fi
    printf '%s' "${candidate}"
    return
  fi
  if ! git -C "${ROOT}" rev-parse --show-toplevel >/dev/null 2>&1; then
    echo "Could not determine git root from harness; set REMOTE_AGENTS_SOURCE_REPO" >&2
    exit 1
  fi
  git -C "${ROOT}" rev-parse --show-toplevel
}

HOST_REPO="$(resolve_host_repo)"
COMMIT="$(git -C "${HOST_REPO}" rev-parse HEAD)"
echo "==> source repo: ${HOST_REPO} (${COMMIT})"
EXPORT_DIR="$(mktemp -d)"
EVIDENCE_DIR="${ROOT}/evidence/fresh-runtime-e2e-$(date -u +%Y%m%dT%H%M%SZ)"
trap 'rm -rf "${EXPORT_DIR}"' EXIT

mkdir -p "${EVIDENCE_DIR}"
git -C "${HOST_REPO}" archive HEAD | tar -x -C "${EXPORT_DIR}"

docker run --rm \
  -v "${EXPORT_DIR}:/export:ro" \
  -v "${ROOT}:/harness:ro" \
  -v "${EVIDENCE_DIR}:/evidence:rw" \
  -e CI_COMMIT_SHA="${COMMIT}" \
  -e EXPORT=/export \
  -e EVIDENCE=/evidence \
  -e HARNESS=/harness \
  ubuntu:24.04 \
  bash -c 'export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl python3 rsync gettext-base systemd >/dev/null
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
    bash /harness/scripts/fresh-runtime-e2e-inner.sh' | tee "${EVIDENCE_DIR}/container.log"

echo "evidence: ${EVIDENCE_DIR}"
cat "${EVIDENCE_DIR}/run.json"
