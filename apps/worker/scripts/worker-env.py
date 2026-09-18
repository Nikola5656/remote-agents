#!/usr/bin/env python3
"""Build worker service environment and optional LaunchAgent plist.

Values are read from argv, process environment, and repo .env only.
No shell interpolation into Python source.
"""
from __future__ import annotations

import argparse
import os
import plistlib
import re
import sys
from pathlib import Path


def normalize_value(value: str) -> str:
    value = value.strip()
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    return value


def parse_dotenv(env_file: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not env_file.is_file():
        return out
    for raw in env_file.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = normalize_value(value)
    return out


def expand_path(value: str, home: Path) -> str:
    if value == "~":
        return str(home)
    if value.startswith("~/"):
        return str(home / value[2:])
    return value


def nonempty(value: str, fallback: str) -> str:
    trimmed = value.strip()
    return trimmed if trimmed else fallback


def resolve_value(key: str, dotenv: dict[str, str], fallback: str = "") -> str:
    raw = os.environ.get(key)
    if raw is not None and raw.strip():
        return normalize_value(raw)
    if key in dotenv and dotenv[key].strip():
        return normalize_value(dotenv[key])
    return fallback


def launch_agent_label(root: Path, home: Path) -> str:
    """Preserve an existing installation identity so upgrades cannot double-start it."""
    configured = resolve_value("WORKER_LAUNCH_AGENT_LABEL", parse_dotenv(root / ".env"))
    if configured and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", configured):
        raise ValueError("WORKER_LAUNCH_AGENT_LABEL must be a launchd identifier without path separators")
    worker_entry = (root / "apps" / "worker" / "dist" / "index.js").resolve()
    existing: set[str] = set()
    for file in (home / "Library" / "LaunchAgents").glob("*.plist"):
        try:
            with file.open("rb") as source:
                plist = plistlib.load(source)
            args = plist.get("ProgramArguments", [])
            if not isinstance(args, list) or len(args) < 2 or not isinstance(args[1], str):
                continue
            if Path(args[1]).resolve() != worker_entry:
                continue
            label = plist.get("Label")
            if isinstance(label, str) and file.name == label + ".plist":
                existing.add(label)
        except (OSError, ValueError, TypeError, AttributeError, plistlib.InvalidFileException):
            continue
    if len(existing) > 1:
        raise ValueError("Multiple LaunchAgents target this worker; stop and remove duplicate services before installing")
    previous = next(iter(existing), "")
    if previous and configured and previous != configured:
        raise ValueError("An existing LaunchAgent targets this worker. Keep WORKER_LAUNCH_AGENT_LABEL unchanged, or uninstall the existing service before changing it")
    return configured or previous or "com.remote-agents.worker"


def build_worker_env(
    root: Path,
    home: Path,
    path_value: str,
    worker_id_default: str,
    keep_awake_default: str,
) -> dict[str, str]:
    dotenv = parse_dotenv(root / ".env")
    state_default = str(home / ".local" / "share" / "remote-agents-worker")
    workspaces_default = str(home / "remote-agent-workspaces")

    state = expand_path(
        nonempty(resolve_value("WORKER_DATA_DIR", dotenv, state_default), state_default),
        home,
    )
    workspaces = expand_path(
        nonempty(resolve_value("WORKSPACES_ROOT", dotenv, workspaces_default), workspaces_default),
        home,
    )
    # No override means the built-in fleet; agents.json is conversation state,
    # not the differently shaped fleet configuration file.
    agent_fleet = expand_path(resolve_value("AGENT_FLEET_FILE", dotenv), home)

    Path(state).mkdir(parents=True, exist_ok=True)
    Path(workspaces).mkdir(parents=True, exist_ok=True)

    return {
        "PATH": resolve_value("WORKER_PATH", dotenv, path_value),
        "HOME": str(home),
        "SERVER_URL": resolve_value("SERVER_URL", dotenv),
        "SERVER_HOST": resolve_value("SERVER_HOST", dotenv),
        "WORKER_TOKEN": resolve_value("WORKER_TOKEN", dotenv),
        "CURSOR_API_KEY": resolve_value("CURSOR_API_KEY", dotenv),
        "CURSOR_RUNTIME": resolve_value("CURSOR_RUNTIME", dotenv, "cli"),
        "CURSOR_BIN": resolve_value("CURSOR_BIN", dotenv, "cursor"),
        "CURSOR_CHAT_WORKSPACE": resolve_value("CURSOR_CHAT_WORKSPACE", dotenv),
        "WORKER_ID": resolve_value("WORKER_ID", dotenv, worker_id_default),
        "DEFAULT_CWD": expand_path(resolve_value("DEFAULT_CWD", dotenv), home),
        "WORKSPACES_ROOT": workspaces,
        "WORKER_DATA_DIR": state,
        "AGENT_FLEET_FILE": agent_fleet,
        "CLAUDE_BIN": resolve_value("CLAUDE_BIN", dotenv, "claude"),
        "KEEP_AWAKE": resolve_value("KEEP_AWAKE", dotenv, keep_awake_default),
        "WORKER_SANDBOX": resolve_value("WORKER_SANDBOX", dotenv, "disabled"),
        "WORKER_FORCE": resolve_value("WORKER_FORCE", dotenv, "1"),
        "CODEX_BIN": resolve_value("CODEX_BIN", dotenv, "codex"),
    }


def esc_env_value(value: str) -> str:
    if value == "":
        return '""'
    if any(c in value for c in ' \t#"$\\'):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def write_env_file(path: Path, env: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if any("\n" in v or "\r" in v or "\0" in v for v in env.values()):
        raise ValueError("Service environment values must be single-line")
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as target:
        target.write("\n".join(f"{k}={esc_env_value(v)}" for k, v in env.items()) + "\n")
    os.chmod(path, 0o600)


def write_plist(
    dest: Path,
    label: str,
    node: str,
    worker_js: str,
    root: Path,
    log_dir: Path,
    env: dict[str, str],
) -> None:
    plist = {
        "Label": label,
        "ProgramArguments": [node, worker_js],
        "WorkingDirectory": str(root),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ProcessType": "Interactive",
        "StandardOutPath": str(log_dir / "worker.log"),
        "StandardErrorPath": str(log_dir / "worker.err.log"),
        "EnvironmentVariables": env,
    }
    dest.parent.mkdir(parents=True, exist_ok=True)
    with os.fdopen(os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as target:
        target.write(plistlib.dumps(plist))
    os.chmod(dest, 0o600)


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--root", required=True, help="Repository root")
    parser.add_argument("--home", default=os.environ.get("HOME", ""), help="Service user HOME")
    parser.add_argument(
        "--path-value",
        default=os.environ.get("PATH_VALUE", ""),
        help="PATH for the worker service",
    )
    parser.add_argument(
        "--worker-id-default",
        default="worker-primary",
        help="Default WORKER_ID when unset in .env",
    )
    parser.add_argument(
        "--keep-awake-default",
        default="1",
        help="Default KEEP_AWAKE when unset in .env",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write worker service env or LaunchAgent plist")
    sub = parser.add_subparsers(dest="command", required=True)

    label_parser = sub.add_parser("launch-agent-label", help="Resolve a safe new or existing LaunchAgent identity")
    label_parser.add_argument("--root", required=True)
    label_parser.add_argument("--home", required=True)

    env_parser = sub.add_parser("write-env-file", help="Write worker.env for systemd")
    add_common_args(env_parser)
    env_parser.add_argument("--env-file", required=True, help="Destination worker.env path")

    plist_parser = sub.add_parser("write-plist", help="Write LaunchAgent plist for macOS")
    add_common_args(plist_parser)
    plist_parser.add_argument("--dest", required=True, help="LaunchAgent plist path")
    plist_parser.add_argument("--label", required=True, help="LaunchAgent label")
    plist_parser.add_argument("--node", required=True, help="Node binary path")
    plist_parser.add_argument("--worker-js", required=True, help="Worker entry script")
    plist_parser.add_argument("--log-dir", required=True, help="Log directory")

    args = parser.parse_args(argv)
    home = Path(args.home).expanduser()
    if not str(home):
        print("error: --home is required", file=sys.stderr)
        return 1

    root = Path(args.root).resolve()
    if args.command == "launch-agent-label":
        try:
            print(launch_agent_label(root, home))
        except ValueError as error:
            print(f"error: {error}", file=sys.stderr)
            return 1
        return 0

    path_value = args.path_value or os.environ.get("PATH", "")
    env = build_worker_env(
        root=root,
        home=home,
        path_value=path_value,
        worker_id_default=args.worker_id_default,
        keep_awake_default=args.keep_awake_default,
    )

    if args.command == "write-env-file":
        write_env_file(Path(args.env_file).expanduser(), env)
        return 0

    write_plist(
        dest=Path(args.dest).expanduser(),
        label=args.label,
        node=args.node,
        worker_js=args.worker_js,
        root=root,
        log_dir=Path(args.log_dir).expanduser(),
        env=env,
    )
    print(f"Wrote {args.dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
