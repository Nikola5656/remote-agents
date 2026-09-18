#!/usr/bin/env bash
# Validate on the Linux filesystem: Windows drive mounts may ignore chmod.
set -euo pipefail

source_root="$(realpath "${1:-.}")"
build_root="$(mktemp -d /tmp/remote-agents-wsl.XXXXXX)"
trap 'rm -rf -- "$build_root"' EXIT

tar -C "$source_root" \
  --exclude=.git --exclude=node_modules --exclude=dist --exclude=evidence \
  --exclude='.env*' -cf - . | tar -C "$build_root" -xf -
if [[ -f "$source_root/.env.example" ]]; then
  cp "$source_root/.env.example" "$build_root/.env.example"
fi

cd "$build_root"
echo "WSL validation: clean build on the Linux filesystem"
bash scripts/wsl-bootstrap-node.sh .
node scripts/smoke-clean-install.mjs
