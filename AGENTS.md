# Agent fleet

Remote Agents runs a **worker** on macOS, Linux, or Windows through WSL2 that hosts multiple independent agent **slots**. Each slot has its own conversation, queue, working directory, and model. The HTTPS control server relays commands; it does not run models itself.

## Default fleet (version 1 — eleven slots)

The worker provisions **11 default slots** from `DEFAULT_AGENTS` in `packages/shared/src/models.ts` (or an override file). Conversation IDs restore from `WORKER_DATA_DIR/agents.json` after restart (direct-run fallback: `apps/worker/data`). This state file is distinct from `AGENT_FLEET_FILE`.

| Slot ID | Display name | Provider | Default model | Kind |
| --- | --- | --- | --- | --- |
| `agent-1` | Agent 1 | Cursor | `grok-4.6` | core |
| `agent-2` | Agent 2 | Cursor | `grok-4.6` | core |
| `agent-3` | Agent 3 | Cursor | `composer-2.5` | core |
| `codex-astra-1` | Astra 1 | Codex | `gpt-6-astra` | extra |
| `codex-astra-2` | Astra 2 | Codex | `gpt-6-astra` | extra |
| `codex-sol-1` | Sol | Codex | `gpt-5.6-sol` | extra |
| `extra-1` | Research | Cursor | `composer-2.5` | extra |
| `claude-fable-5-1` | Claude Fable 5.1 | Claude Code | `claude-code:claude-fable-5-1` | claude |
| `claude-fable-5` | Claude Fable 5 | Claude Code | `claude-code:claude-fable-5` | claude |
| `claude-opus-5` | Claude Opus 5 | Claude Code | `claude-code:claude-opus-5` | claude |
| `claude-opus-4-8` | Claude Opus 4.8 | Claude Code | `claude-code:claude-opus-4-8` | claude |

**Additional slots** can still be created from **Overview → Add an agent** (`extra-N` ids).

### `AGENT_FLEET_FILE` override

Set `AGENT_FLEET_FILE` to a JSON file shaped like [examples/fleet.defaults.json](./examples/fleet.defaults.json):

```json
{ "version": 1, "agents": [ { "id": "...", "name": "...", "provider": "cursor|codex|claude", "defaultModel": "...", "kind": "core|extra|claude", "cwd": "optional" } ] }
```

Rules (worker validates at startup): `version` must be `1`; `defaultModel` must match `provider` and exist in `MODEL_CATALOG`; duplicate ids rejected; relative `cwd` resolves from the fleet file directory; `~` expands to the current user home. A **custom fleet is authoritative** — persisted extras not in the file are kept on disk but not re-added to the roster.

### Worker ↔ server transport

- **`hello`** on connect includes the full agent snapshot list.
- **`agent_update`** messages carry per-slot changes; the worker **coalesces** pending updates (250 ms) and drops superseded snapshots when the socket buffer is busy.
- **`heartbeat`** sends `agents: []` intentionally — the control server **retains** snapshots from `hello` / `agent_update` and only refreshes health from heartbeats (`apps/server/src/store.ts` `applyHeartbeat` treats an empty agent list as health-only).

## Working directories

- Default per slot: `~/remote-agent-workspaces/<slot-id>` (override with `WORKSPACES_ROOT`).
- Optional shared project: set `DEFAULT_CWD` so new slots start in one repo.
- Per-slot `cwd` can be changed from the agent detail page in the dashboard.

## Runtimes

| Provider | Modes | Auth on worker |
| --- | --- | --- |
| **Cursor** | `cli` (default), `sdk`, `bridge`, `machine`, `degraded` via `CURSOR_RUNTIME` | `CURSOR_API_KEY` for CLI/SDK/machine paths; bridge uses the signed-in Cursor IDE |
| **Codex** | Native app server + optional desktop owner socket | `codex login` / ChatGPT desktop sign-in; optional `CODEX_BIN` |
| **Claude Code** | Four native CLI sessions, plus optional on-demand helpers | `CLAUDE_BIN` on PATH and `claude auth login` |

### Full filesystem access (intentional)

Cursor CLI defaults: `WORKER_SANDBOX=disabled`, `WORKER_FORCE=1` (`--sandbox disabled --force`). Codex uses `danger-full-access` with approvals disabled. Claude Code uses `--dangerously-skip-permissions`. This is **authorized by the operator** so agents can work across projects on the worker. See [SECURITY.md](./SECURITY.md).

## Commands

- **Send** — queue or run immediately on an idle slot.
- **Interrupt** — stop the current run; queued items are preserved.
- **Stop task** — cancel the current run without submitting a replacement instruction; queued items continue afterward.
- **Remove** — remove an individual waiting instruction; instructions that have already started cannot be removed from the queue.
- **Output modes** — full vs condensed transcript in the dashboard.
- **Markdown workspace** — list/read `.md` files under the slot workspace via the API.
- **Report links** — use authenticated document URLs that work in a new tab; unavailable files show recovery guidance.
- **Provider filter** — remembered across Overview, Agents, and page reloads in the current browser.

API commands return success only after the worker acknowledges. Disconnected workers show offline on the Health page.
