#!/usr/bin/env python3
"""Serialize paths and values for systemd unit files."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def validate_line_value(value: str, label: str = "value") -> None:
    if any(ch in value for ch in "\n\r\0"):
        raise ValueError(f"{label} contains newline")


def _needs_exec_quoting(value: str) -> bool:
    return not all(ch.isalnum() or ch in "/._:+@-" for ch in value) or "$" in value


def _escape_exec_start_body(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("%", "%%")
        .replace("$", "$$")
    )


def systemd_path_escape(value: str, label: str = "value") -> str:
    """Escape a single filesystem path for systemd unit keys (not ExecStart arguments)."""
    validate_line_value(value, label)
    if value == "":
        raise ValueError(f"{label} must not be empty")
    out: list[str] = []
    for ch in value:
        if ch == " ":
            out.append("\\s")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "%":
            out.append("%%")
        elif ch == '"':
            out.append('\\"')
        else:
            out.append(ch)
    return "".join(out)


def exec_start_quote(value: str, label: str = "value") -> str:
    """Quote an ExecStart argument; systemd expands $ even inside quotes unless escaped as $$."""
    validate_line_value(value, label)
    if value == "":
        return '""'
    if not _needs_exec_quoting(value):
        return value
    return f'"{_escape_exec_start_body(value)}"'


def environment_line(key: str, value: str) -> str:
    validate_line_value(value, key)
    escaped = f"{key}={value}".replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
    return f'Environment="{escaped}"'


def exec_start_line(executable: str, *args: str) -> str:
    parts = [exec_start_quote(executable, "ExecStart executable")]
    for index, arg in enumerate(args):
        parts.append(exec_start_quote(arg, f"ExecStart arg {index + 1}"))
    return "ExecStart=" + " ".join(parts)


def append_log_line(key: str, log_file: str) -> str:
    validate_line_value(log_file, key)
    return f"{key}=append:{systemd_path_escape(log_file, key)}"


def render_worker_unit(
    root: str,
    node: str,
    worker_js: str,
    env_file: str,
    log_dir: str,
) -> str:
    stdout_log = str(Path(log_dir) / "worker.log")
    stderr_log = str(Path(log_dir) / "worker.err.log")
    lines = [
        "[Unit]",
        "Description=Remote Agents worker",
        "After=network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        f"WorkingDirectory={systemd_path_escape(root, 'WorkingDirectory')}",
        exec_start_line(node, worker_js),
        "Restart=always",
        "RestartSec=3",
        f"EnvironmentFile=-{systemd_path_escape(env_file, 'EnvironmentFile')}",
        append_log_line("StandardOutput", stdout_log),
        append_log_line("StandardError", stderr_log),
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ]
    return "\n".join(lines)


def render_server_unit(
    template: Path,
    output: Path,
    install_dir: str,
    state_dir: str,
    service_user: str,
) -> None:
    install = Path(install_dir)
    replacements = {
        "{{REMOTE_AGENTS_SERVICE_USER}}": service_user,
        "{{REMOTE_AGENTS_INSTALL_DIR_QUOTED}}": systemd_path_escape(
            install_dir, "REMOTE_AGENTS_INSTALL_DIR"
        ),
        "{{REMOTE_AGENTS_STATE_DIR_QUOTED}}": systemd_path_escape(
            state_dir, "REMOTE_AGENTS_STATE_DIR"
        ),
        "{{REMOTE_AGENTS_NODE_PATH_ENV}}": environment_line(
            "NODE_PATH", str(install / "node_modules")
        ),
        "{{REMOTE_AGENTS_ENV_FILE_QUOTED}}": systemd_path_escape(
            str(install / ".env"), "EnvironmentFile"
        ),
        "{{REMOTE_AGENTS_SERVER_JS_QUOTED}}": exec_start_quote(
            str(install / "apps/server/dist/index.js"), "ExecStart script"
        ),
    }
    text = template.read_text()
    for key, value in replacements.items():
        text = text.replace(key, value)
    if "{{" in text:
        raise ValueError(f"unresolved template placeholders in {template}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Serialize values for systemd unit files")
    sub = parser.add_subparsers(dest="command", required=True)

    worker = sub.add_parser("worker-unit", help="Render worker systemd user unit")
    worker.add_argument("--output", required=True)
    worker.add_argument("--root", required=True)
    worker.add_argument("--node", required=True)
    worker.add_argument("--worker-js", required=True)
    worker.add_argument("--env-file", required=True)
    worker.add_argument("--log-dir", required=True)

    server = sub.add_parser("server-unit", help="Render server systemd unit from template")
    server.add_argument("--template", required=True)
    server.add_argument("--output", required=True)
    server.add_argument("--install-dir", required=True)
    server.add_argument("--state-dir", required=True)
    server.add_argument("--service-user", required=True)

    quote = sub.add_parser("quote", help="Quote one systemd path/value")
    quote.add_argument("value")

    args = parser.parse_args(argv)
    if args.command == "worker-unit":
        unit = render_worker_unit(args.root, args.node, args.worker_js, args.env_file, args.log_dir)
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(unit)
        return 0
    if args.command == "server-unit":
        render_server_unit(
            Path(args.template),
            Path(args.output),
            args.install_dir,
            args.state_dir,
            args.service_user,
        )
        return 0
    sys.stdout.write(systemd_path_escape(args.value) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
