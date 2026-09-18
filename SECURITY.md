# Security

Remote Agents is a **single-tenant control plane**: one authenticated operator uses a phone or browser to command agent slots on **their own worker machine**. The design assumes the operator **intentionally grants those agents broad local access**. Security effort focuses on **who can reach the control API and worker**, not on sandboxing the models on the host.

## Threat model

### Assets

| Asset | Location | Sensitivity |
| --- | --- | --- |
| Dashboard session | Control server (`express-session`, file store) | Medium — grants send/interrupt/read |
| `WORKER_TOKEN` | Server + worker `.env` | High — grants worker WebSocket |
| `CURSOR_API_KEY` | worker only | High — Cursor API spend/access |
| Codex desktop session | Worker (Codex login) | High — model use as logged-in user |
| Slot workspaces | `~/remote-agent-workspaces/*` | High — source code, secrets in repos |
| Worker user filesystem | Via intentional full access | **Critical** |

### Trust boundaries

```
[Operator phone/browser] --HTTPS+session--> [Control server] --WSS+token--> [worker] --local--> [Cursor/Codex/Claude + filesystem]
```

1. **Internet → control server** — Must fail closed: login rate limit (8 / 15 min / IP), scrypt password hash, `httpOnly` session cookie, `helmet`, API behind `requireAuth` except login/healthz.
2. **Internet → worker** — Worker only connects **outbound** to the server; no inbound agent port on the worker.
3. **Control server → worker** — Shared `WORKER_TOKEN`; timing-safe compare on WebSocket upgrade.
4. **Worker → host** — Agents run as the **worker account** with **full filesystem access** (see below). Compromise of any slot ≈ compromise of that user account.

### Intentional full local access

The operator has authorized **unrestricted local agents**:

| Runtime | Mechanism | Default |
| --- | --- | --- |
| Cursor CLI | `--sandbox disabled --force` | On (`WORKER_FORCE=1`, `WORKER_SANDBOX=disabled`) |
| Codex native | `danger-full-access`, `approvalPolicy: never` | Always for remote slots |
| Codex desktop path | Task settings updated before each turn | Same policy |
| Claude Code | `--dangerously-skip-permissions` | On for every remote run |

This allows cross-project work (for example editing repos outside the slot’s default folder). It does **not** grant root or bypass macOS TCC for other users’ data; it **does** allow reading/writing any path the worker user can access, including SSH keys, `.env` files, and cloud credentials stored on disk.

**Do not expose the dashboard or worker token to untrusted networks or users.**

### Out of scope / accepted risks

- Multi-tenant isolation (not a goal).
- Model prompt injection hardening beyond provider defaults.
- Encrypting slot transcripts at rest on the worker.
- Supply-chain guarantees for Cursor/Codex/Claude binaries.

## Hardening checklist (operator)

1. **Strong dashboard password** — Use `APP_PASSWORD_HASH` (see `node scripts/gen-secrets.js`); never commit `.env`.
2. **Long random `WORKER_TOKEN` and `SESSION_SECRET`** — Rotate if leaked; worker and server must match.
3. **TLS only** — Terminate HTTPS at nginx; set `PUBLIC_ORIGIN` to `https://…`.
4. **Bind server to localhost** — `HOST=127.0.0.1`; expose only via reverse proxy.
5. **Restrict nginx** — Optional IP allowlist or VPN in front of the vhost.
6. **Dedicated worker user** — Consider a non-admin macOS account for the worker if you need blast-radius reduction (agents still see that user’s files).
7. **Monitor worker logs** — use the installed service’s configured log paths. On macOS, `WORKER_LAUNCH_AGENT_LABEL` selects the worker LaunchAgent; its default is `com.remote-agents.worker`.
8. **Revoke sessions** — remove session files from the configured `SESSION_DIR` on the server to force re-login. Confirm that directory before removal.

## Reporting

Report vulnerabilities privately to the repository maintainer or your deployment operator. Do not file public issues containing tokens, transcripts, or hostnames.

## Controls and limitations

The server validates worker messages before accepting snapshots, checks exact browser origins, uses secure HTTP-only production cookies, rate-limits login and mutations, and requires an authenticated worker hello. It accepts worker credentials only in the Authorization header. Server credentials must be strong and distinct; plaintext dashboard passwords are rejected in production.

File browsing is limited to bounded Markdown files within a slot workspace and its captured artifacts, with symlink-ancestor checks. This protects the remote file API; it deliberately does not restrict the agent's tool access outside that workspace. Automatic reports and copied outputs become visible to the authenticated operator and may contain sensitive project information.

Persistence rejects corrupt state instead of overwriting conversation IDs. Reinstallation preserves private environment and session data. Re-validate authentication, provider access and platform compatibility after upgrades. These checks do not guarantee immunity from prompt injection or compromise of provider tools. The control server is single-instance; multi-instance operation requires a shared session store and rate limiter.
