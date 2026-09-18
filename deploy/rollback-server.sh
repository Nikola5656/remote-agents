#!/usr/bin/env bash
# Restore a private installed-tree backup without touching the live tree until
# the archive has been fully validated and extracted to same-filesystem staging.
# Usage: sudo REMOTE_AGENTS_SERVICE_NAME=remote-agents bash deploy/rollback-server.sh backup.tgz
set -euo pipefail
umask 077

fail() {
  echo "rollback-server: $*" >&2
  exit 1
}

BACKUP="${1:-}"
DEST="${REMOTE_AGENTS_INSTALL_DIR:-/opt/remote-agents}"
SERVICE_NAME="${REMOTE_AGENTS_SERVICE_NAME:-remote-agents}"
SKIP_NGINX="${RA_SKIP_NGINX:-0}"
VERIFY_SECONDS="${RA_POST_RESTART_VERIFY_SECONDS:-5}"

[[ -n "${BACKUP}" && -f "${BACKUP}" && ! -L "${BACKUP}" ]] || \
  fail "usage: $0 /path/to/private-installed-tree-backup.tgz"
[[ "${DEST}" == /* && "${DEST}" != "/" && "${DEST}" != *$'\n'* && "${DEST}" != *$'\r'* ]] || \
  fail "REMOTE_AGENTS_INSTALL_DIR must be a safe absolute path other than /"
[[ "${SERVICE_NAME}" =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$ ]] || \
  fail "REMOTE_AGENTS_SERVICE_NAME is invalid"
[[ "${SKIP_NGINX}" == "0" || "${SKIP_NGINX}" == "1" ]] || \
  fail "RA_SKIP_NGINX must be 0 or 1"
[[ "${VERIFY_SECONDS}" =~ ^[1-9][0-9]?$ && "${VERIFY_SECONDS}" -le 60 ]] || \
  fail "RA_POST_RESTART_VERIFY_SECONDS must be an integer from 1 through 60"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"
command -v systemctl >/dev/null 2>&1 || fail "systemctl is required"
if [[ "${SKIP_NGINX}" == "0" ]]; then
  command -v nginx >/dev/null 2>&1 || fail "nginx is required unless RA_SKIP_NGINX=1"
fi

DEST_PARENT="$(dirname "${DEST}")"
DEST_BASE="$(basename "${DEST}")"
mkdir -p "${DEST_PARENT}"
STAGE="$(mktemp -d "${DEST_PARENT}/.${DEST_BASE}.rollback-stage.XXXXXX")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DISPLACED="${DEST}.pre-rollback.${STAMP}"
FAILED_TREE="${DEST}.failed-rollback.${STAMP}"
OLD_MOVED=0
NEW_ACTIVE=0
WAS_ACTIVE=0
SERVICE_TOUCHED=0

cleanup_stage() {
  if [[ -n "${STAGE:-}" && -d "${STAGE}" ]]; then
    rm -rf -- "${STAGE}"
  fi
}

recover() {
  local status="${1:-1}"
  local recovery_state="not checked"
  trap - ERR INT TERM
  set +e
  if [[ "${NEW_ACTIVE}" == "1" && -e "${DEST}" ]]; then
    if ! mv -- "${DEST}" "${FAILED_TREE}"; then
      echo "rollback-server: recovery could not retain failed install at ${FAILED_TREE}" >&2
    fi
  fi
  if [[ "${OLD_MOVED}" == "1" && -e "${DISPLACED}" ]]; then
    if ! mv -- "${DISPLACED}" "${DEST}"; then
      echo "rollback-server: recovery could not restore previous install from ${DISPLACED}" >&2
    fi
  fi
  if [[ "${WAS_ACTIVE}" == "1" ]]; then
    if ! systemctl daemon-reload >/dev/null 2>&1; then
      echo "rollback-server: recovery systemctl daemon-reload failed" >&2
    fi
    if ! systemctl restart "${SERVICE_NAME}" >/dev/null 2>&1; then
      echo "rollback-server: recovery failed to restart previous service ${SERVICE_NAME}" >&2
      if systemctl is-active --quiet "${SERVICE_NAME}"; then
        recovery_state="active despite restart command failure"
      else
        recovery_state="not active (restart failed)"
      fi
    else
      recovery_state="active"
      for ((second = 1; second <= VERIFY_SECONDS; second++)); do
        sleep 1
        if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
          recovery_state="not active"
          echo "rollback-server: recovered service ${SERVICE_NAME} did not remain active" >&2
          break
        fi
      done
    fi
  elif [[ "${SERVICE_TOUCHED}" == "1" ]]; then
    if systemctl is-active --quiet "${SERVICE_NAME}"; then
      recovery_state="active"
    else
      recovery_state="not active (not restarted because it was not active before rollback)"
    fi
  else
    recovery_state="not touched"
  fi
  cleanup_stage
  echo "rollback-server: failed; previous install restored when available" >&2
  echo "rollback-server: service state after recovery: ${recovery_state}" >&2
  exit "${status}"
}

trap 'recover $?' ERR
trap 'recover 130' INT TERM

# Validate every member before extraction. Internal links used by npm are
# accepted only when their resolved targets remain inside the archive root and
# are not themselves links. No archive path may descend through a link.
python3 - "${BACKUP}" "${STAGE}" "${DEST_BASE}" <<'PY'
import os
import posixpath
import shutil
import sys
import tarfile
from pathlib import Path, PurePosixPath

archive_path, stage_arg, expected_root = sys.argv[1:]
stage = Path(stage_arg)
required_files = {
    f"{expected_root}/.env",
    f"{expected_root}/apps/server/dist/index.js",
}
required_dirs = {
    expected_root,
    f"{expected_root}/node_modules",
}


def resolved_link(member, raw):
    link = member.linkname
    if not link or link.startswith("/") or "\\" in link:
        raise ValueError(f"unsafe link target for {raw}: {link!r}")
    if member.issym():
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(raw), link))
    else:
        # POSIX tar hard-link names are relative to the archive root.
        resolved = posixpath.normpath(link)
    pure = PurePosixPath(resolved)
    if (
        resolved.startswith("/")
        or any(part in ("", ".", "..") for part in pure.parts)
        or not pure.parts
        or pure.parts[0] != expected_root
    ):
        raise ValueError(f"link target escapes archive root for {raw}: {link!r}")
    return resolved


def apply_owner(target, member, *, follow_symlinks=True):
    if os.geteuid() == 0:
        os.chown(target, member.uid, member.gid, follow_symlinks=follow_symlinks)

try:
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        if not members:
            raise ValueError("archive is empty")
        seen = set()
        kinds = {}
        by_name = {}
        link_targets = {}
        for member in members:
            raw = member.name.rstrip("/")
            pure = PurePosixPath(raw)
            if (
                not raw
                or raw.startswith("/")
                or "\\" in raw
                or any(part in ("", ".", "..") for part in pure.parts)
                or pure.parts[0] != expected_root
            ):
                raise ValueError(f"unsafe or unexpected archive path: {member.name!r}")
            if raw in seen:
                raise ValueError(f"duplicate archive path: {raw}")
            seen.add(raw)
            if member.isdir():
                kinds[raw] = "dir"
            elif member.isreg():
                kinds[raw] = "file"
            elif member.issym():
                kinds[raw] = "symlink"
                link_targets[raw] = resolved_link(member, raw)
            elif member.islnk():
                kinds[raw] = "hardlink"
                link_targets[raw] = resolved_link(member, raw)
            else:
                raise ValueError(f"special archive entry is forbidden: {raw}")
            by_name[raw] = member

        for raw in seen:
            parts = PurePosixPath(raw).parts
            for index in range(1, len(parts)):
                ancestor = "/".join(parts[:index])
                if ancestor in kinds and kinds[ancestor] != "dir":
                    raise ValueError(f"archive path descends through non-directory: {raw}")

        for raw, resolved in link_targets.items():
            target_kind = kinds.get(resolved)
            if kinds[raw] == "symlink" and target_kind not in ("file", "dir"):
                raise ValueError(f"symlink target is absent or another link: {raw}")
            if kinds[raw] == "hardlink" and target_kind != "file":
                raise ValueError(f"hard-link target is not a regular file: {raw}")
            if kinds[raw] == "hardlink":
                member = by_name[raw]
                target_member = by_name[resolved]
                if (member.uid, member.gid) != (target_member.uid, target_member.gid):
                    raise ValueError(f"hard-link ownership disagrees with target: {raw}")

        for required in required_files:
            if kinds.get(required) != "file":
                raise ValueError(f"required installed-tree file missing: {required}")
        for required in required_dirs:
            if kinds.get(required) != "dir":
                raise ValueError(f"required installed-tree directory missing: {required}")

        directories = [member for member in members if member.isdir()]
        files = [member for member in members if member.isreg()]
        hardlinks = [member for member in members if member.islnk()]
        symlinks = [member for member in members if member.issym()]

        for member in sorted(directories, key=lambda item: len(PurePosixPath(item.name).parts)):
            relative = PurePosixPath(member.name.rstrip("/"))
            target = stage.joinpath(*relative.parts)
            target.mkdir(parents=True, exist_ok=True)

        for member in files:
            relative = PurePosixPath(member.name.rstrip("/"))
            target = stage.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise ValueError(f"could not read archive member: {member.name}")
            with source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            os.chmod(target, member.mode & 0o777)
            apply_owner(target, member)

        for member in hardlinks:
            raw = member.name.rstrip("/")
            target = stage.joinpath(*PurePosixPath(raw).parts)
            source = stage.joinpath(*PurePosixPath(link_targets[raw]).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            os.link(source, target, follow_symlinks=False)

        for member in symlinks:
            raw = member.name.rstrip("/")
            target = stage.joinpath(*PurePosixPath(raw).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(member.linkname, target)
            apply_owner(target, member, follow_symlinks=False)

        for member in sorted(
            directories,
            key=lambda item: len(PurePosixPath(item.name).parts),
            reverse=True,
        ):
            target = stage.joinpath(*PurePosixPath(member.name.rstrip("/")).parts)
            os.chmod(target, member.mode & 0o777)
            apply_owner(target, member)
except (OSError, tarfile.TarError, ValueError) as error:
    print(f"rollback-server: invalid backup: {error}", file=sys.stderr)
    raise SystemExit(1)
PY

STAGED_ROOT="${STAGE}/${DEST_BASE}"
[[ -d "${STAGED_ROOT}" ]] || fail "validated backup did not produce ${DEST_BASE}/"
[[ ! -e "${DISPLACED}" && ! -e "${FAILED_TREE}" ]] || \
  fail "timestamped rollback destination already exists; retry later"

# Validate the unchanged nginx configuration before taking down the application.
if [[ "${SKIP_NGINX}" == "0" ]]; then
  nginx -t
fi

SERVICE_TOUCHED=1
if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
  WAS_ACTIVE=1
  systemctl stop "${SERVICE_NAME}"
fi

if [[ -e "${DEST}" ]]; then
  mv -- "${DEST}" "${DISPLACED}"
  OLD_MOVED=1
fi
mv -- "${STAGED_ROOT}" "${DEST}"
NEW_ACTIVE=1

systemctl daemon-reload
systemctl restart "${SERVICE_NAME}"
for ((second = 1; second <= VERIFY_SECONDS; second++)); do
  sleep 1
  if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
    echo "rollback-server: ${SERVICE_NAME} did not remain active after restart" >&2
    false
  fi
done
trap - ERR INT TERM
NEW_ACTIVE=0
OLD_MOVED=0
cleanup_stage

# The restored application is committed once it has passed its health window.
# An optional nginx reload failure must not reactivate the displaced release.
if [[ "${SKIP_NGINX}" == "0" ]]; then
  if ! systemctl reload nginx; then
    echo "rollback-server: nginx reload failed; restored application remains active" >&2
    exit 1
  fi
fi

echo "==> rolled back ${DEST} from ${BACKUP} (service=${SERVICE_NAME})"
if [[ -e "${DISPLACED}" ]]; then
  echo "==> previous private install preserved at ${DISPLACED}"
fi
