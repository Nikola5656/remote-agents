# Provider configuration templates

Copy these into the **worker machine user profile** when setting up a new host.
They are **not** applied automatically and do **not** modify global IDE settings.

| Provider | Template | Full-access default |
|----------|----------|---------------------|
| Codex | `codex/config.toml.template` | `sandbox_mode = "danger-full-access"`, `approval_policy = "never"` |
| Claude Code | `claude/settings.json.template` | Fable 5.1 manual default, `permissions.defaultMode = "bypassPermissions"`, `sandbox.enabled = false` |
| Cursor CLI | `cursor/cli-defaults.md` | `--sandbox disabled --force` (worker env `WORKER_SANDBOX=disabled`, `WORKER_FORCE=1`) |

The worker runtime already requests these modes programmatically on each run; templates document
operator defaults for **manual** CLI use and onboarding checks (`scripts/doctor.mjs`, including sanitized `claude auth` probe).

**Windows:** install the worker inside **WSL2 Ubuntu** (`scripts/setup-worker-wsl.ps1`); native Windows is not supported.

**Precedence:** per-run CLI flags and worker env vars win over any copied global config.
The worker never overwrites `~/.claude/settings.json`, `~/.codex/config.toml`, or Cursor global settings.

Claude bypass defaults belong in user or managed settings, not project settings. The four fleet model choices come from the shared catalogue; this manual template selects Fable 5.1.
