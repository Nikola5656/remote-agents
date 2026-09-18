# Setup

Set up **two services from this repository**: a control server on your Linux server, and a worker on your local computer. Complete the server steps first, then connect the worker.

| Where | What runs there | What you keep there |
| --- | --- | --- |
| **Remote Linux server** | Web interface (`apps/web`), authentication, API, and connection relay (`apps/server`), behind nginx | Domain/TLS configuration, web sign-in credentials, sessions, and worker connection token |
| **Local computer** | Worker (`apps/worker`) and the Cursor, Codex, and Claude Code CLIs | Your projects, provider sign-ins/API keys, agent conversations, reports, and fleet settings |
| **Phone or another computer** | A browser visiting your server's HTTPS address | No worker or provider installation needed to use the interface |

```text
Phone / browser  ── HTTPS ──►  Linux control server
Local worker    ── WSS ─────►  Linux control server
      │
      └── runs provider CLIs against projects on your local computer
```

The worker opens the outbound connection. Tasks travel back through that connection and execute on the local computer; the server relays activity and requested documents to the browser. Provider CLIs communicate with their providers from the worker computer. Keep that computer awake and connected while agents work. Your project repositories do not need to be copied to the control server.

The two services use **separate private environment files**. The shared `WORKER_TOKEN` connects them:

| Setting | Server environment | Local worker environment |
| --- | --- | --- |
| Public address | `PUBLIC_ORIGIN=https://agents.example.com` | `SERVER_URL=https://agents.example.com` |
| Worker connection secret | Generated `WORKER_TOKEN` | Copy the **same** `WORKER_TOKEN` securely |
| Web sign-in | `APP_USERNAME`, `APP_PASSWORD_HASH`, `SESSION_SECRET` | Not needed |
| Provider authentication | Not needed | Provider CLI sign-ins and, where required, `CURSOR_API_KEY` |
| Project and fleet paths | Not needed | `DEFAULT_CWD`, `WORKSPACES_ROOT`, `AGENT_FLEET_FILE` as needed |

Replace `agents.example.com` with your domain everywhere below. Use the same repository revision on both machines. Building the monorepo compiles both components; the installer you run determines which service starts on that machine.

## Control server (Linux)

**Run this section in a terminal on your remote Linux server.** It installs the web app and relay, not the agent worker.

Prerequisites: Ubuntu 22.04/24.04 or Debian 12, Node.js ≥22.13, npm 10.9.2, Git, Python 3, nginx, systemd, rsync, and gettext (`envsubst`). The supplied TLS script also requires certbot and openssl. Install these prerequisites before continuing.

1. Point your domain at the server. Permit HTTPS and the HTTP ACME challenge; keep the application port bound to loopback.
2. Clone and build in a staging directory, separate from the final installation:

   ```sh
   git clone https://github.com/Nikola5656/remote-agents.git remote-agents-staging
   cd remote-agents-staging
   npm ci
   npm run build
   npm test
   ```

   Stay in this directory for the following server commands. No provider login is needed here. If you already have a built release archive, unpack it into a separate staging directory instead; see [Release, backup and rollback](#release-backup-and-rollback).
3. Generate the server configuration:

   ```sh
   PUBLIC_ORIGIN=https://agents.example.com APP_USERNAME=admin node scripts/gen-secrets.js .env.production
   ```

   This creates private `.env.production` and `.env.production.credentials.json` files. The JSON file contains your **web app login**, not provider credentials. Store those login details securely, then remove the credentials JSON. Keep the generated `WORKER_TOKEN` available for the local worker setup. Never commit either file.
4. Review `.env.production`: keep `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=3847`, `TRUST_PROXY=1` for the supplied nginx proxy, `SESSION_DIR=/var/lib/remote-agents/sessions`, and your `PUBLIC_ORIGIN`. Keep the generated password hash and secrets. Production forbids `APP_PASSWORD`.
5. Install the server service from this staging directory:

   ```sh
   sudo REMOTE_AGENTS_DOMAIN=agents.example.com bash deploy/install-server.sh "$PWD"
   ```

   The installer copies the application into `/opt/remote-agents`, installs runtime dependencies, and starts the `remote-agents` systemd service as `www-data`. It copies `.env.production` to `/opt/remote-agents/.env` on first installation. State lives in `/var/lib/remote-agents`. Later installations preserve the installed environment and sessions. The staging directory and installation destination must differ.

   See [deploy/env.server.example](../deploy/env.server.example) for overrides. Pass installer settings such as `REMOTE_AGENTS_INSTALL_DIR` in the command environment; application `.env` files do not automatically configure the installer.
6. Set up HTTPS using the supplied script or your existing ACME tooling:

   ```sh
   sudo REMOTE_AGENTS_DOMAIN=agents.example.com REMOTE_AGENTS_LE_EMAIL=admin@example.com bash deploy/issue-cert.sh
   curl --fail https://agents.example.com/api/healthz
   systemctl status remote-agents
   ```

   Use your own certificate contact email. If you changed installation paths, pass the same overrides to the certificate script. Open the HTTPS address in a browser and sign in with the generated web credentials. **The worker will be offline until you finish the local computer section.**

`/api/healthz` confirms the server responds. It does not confirm that a worker or provider is ready. Do not use a legacy OS as the reference for a new installation; older systems can have separate Node compatibility and security support limitations.

## Worker setup

**Run this section on your local computer, as the user who owns your projects and provider accounts.** On Windows, run inside WSL2 Ubuntu and read the [Windows notes](#windows-through-wsl2) first. This installs the agent worker, not the public web server.

Prerequisites: macOS, Linux, or WSL2 Ubuntu; Node.js ≥22.13, npm 10.9.2, Git, Python 3, and enough disk space for your projects. Linux/WSL service installation requires a systemd user session. Install the provider CLIs in this same environment and user account.

1. Clone into a stable location and build:

   ```sh
   git clone https://github.com/Nikola5656/remote-agents.git
   cd remote-agents
   npm ci
   npm run build
   npm test
   cp .env.example .env
   chmod 600 .env
   ```

   Stay in this checkout for the following worker commands. Keep it in place after installing the service, because the worker runs from this checkout.
2. Edit the local `.env` using its **Worker** section and the shared `WORKER_TOKEN` field:

   ```dotenv
   SERVER_URL=https://agents.example.com
   WORKER_TOKEN=replace-with-the-token-generated-on-your-server
   CURSOR_RUNTIME=cli
   ```

   Replace the token placeholder with the server's exact value, transferred securely. Leave server-only secrets empty on this machine. Configure provider binary paths/API keys as needed. To start agents in an existing project, set `DEFAULT_CWD` to that project's path **on this computer**; otherwise slots get separate folders under `~/remote-agent-workspaces`. `WORKSPACES_ROOT` changes that base folder. `AGENT_FLEET_FILE` selects a custom fleet.
3. Install and authenticate providers **on this local computer**:

   | Provider | Authentication | Execution policy |
   | --- | --- | --- |
   | Cursor CLI | `CURSOR_API_KEY` or the CLI's signed-in account; verify your chosen mode | `--sandbox disabled --force --trust` |
   | Codex | `codex login`, then `codex login status` | `danger-full-access`, approval policy `never` |
   | Claude Code | `claude auth login`, then `claude auth status --json` | `--dangerously-skip-permissions` |

   Install from the providers' official instructions: [Cursor CLI](https://cursor.com/docs/cli/installation), [Codex CLI](https://developers.openai.com/codex/cli), [Claude Code](https://code.claude.com/docs/en/setup). Authentication is interactive and cannot be copied from this repository. Your accounts must have access to the selected models. These are separate from the web app login created on the server.
4. Check prerequisites and install the local worker service:

   ```sh
   node scripts/doctor.mjs --strict
   node scripts/setup-worker.mjs
   ```

   Address doctor findings before installation; it checks prerequisites, not model inference. Setup selects the macOS LaunchAgent or Linux/WSL systemd user service. It writes a private worker environment file and prints the service, state, and log locations. New service installations keep state outside the repository; explicit existing `WORKER_DATA_DIR` values preserve the previous location. Back up existing state before changing that path.

   If you already built and want the platform installer directly, use `bash apps/worker/scripts/install-macos.sh` on macOS or `bash apps/worker/scripts/install-linux.sh` on Linux/WSL.
5. In your browser, return to `https://agents.example.com`. **Health** should show the worker connected. **Agents** should show the eleven default slots, or your custom fleet. Send a harmless instruction to each configured provider and open the resulting report in **Documents**. This checks the full browser → server → local worker → provider → report path.

Full folder access means access as the worker user; it does not bypass OS ownership, Windows mount permissions, or macOS privacy controls. Configure platform permissions if a project needs them.

## Windows through WSL2

Use a current Store WSL release with `wsl --cd` support. Install WSL2 Ubuntu, enable systemd in `/etc/wsl.conf` if necessary (`[boot]` followed by `systemd=true`), and restart the distribution. Clone into the Linux filesystem, install Node and all three provider CLIs, authenticate inside WSL, and follow the Linux worker steps. Windows projects can be reached through `/mnt/c/...` when the Windows account allows it.

From a Windows checkout, run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-worker-wsl.ps1` for the WSL setup entrypoint. From a clone inside the Linux filesystem, use the Linux commands above. Native Windows worker service execution and Codex desktop synchronization are not part of this path. A WSL distribution must be running for the worker to stay online; configure Windows startup accordingly. Keep `WORKER_DATA_DIR` and private environment files on the Linux filesystem so Unix file permissions apply.

Run `pwsh -NoProfile -File scripts/run-wsl-validation.ps1` to validate from Windows. It builds a temporary copy on the WSL Linux filesystem, runs the build and tests, and removes the copy afterwards. GitHub Actions runs this check on a real Windows runner with WSL2.

## Provider configuration templates

[config/README.md](../config/README.md) links the canonical templates. They are examples for manual CLI defaults, not credentials, and are not automatically copied into global profiles. Claude's bypass permission default belongs in user or managed settings, not a project settings file. Runtime flags establish the requested execution policy for remote runs.

## Custom default fleet

Copy [examples/fleet.defaults.json](../examples/fleet.defaults.json), edit it, then set `AGENT_FLEET_FILE` to its path. Each slot has a stable ID, explicit provider, model, name, and optional working directory. Relative directories resolve against the fleet file. Restart the worker after configuration changes.

A custom file is authoritative for the visible roster; saved unlisted slots remain on disk. Saved compatible model selections and conversation IDs take precedence for existing IDs. Use a new ID for a fresh conversation or change the model through the dashboard. Unknown providers, mismatched models, duplicate IDs, invalid state, and unsupported schema versions fail visibly instead of silently replacing conversations.

## Operations

- Check `systemctl --user status remote-agents-worker` and its journal on Linux/WSL; check the LaunchAgent and its configured log paths on macOS.
- Back up the server environment/session directory and worker state before upgrades. Keep backups private.
- Deploy only after builds and tests pass; stop or finish active runs before restarting the worker.
- No inbound SSH connection to the worker is needed for normal operation. Agent commands and updates use WSS to the server.

### Package manager

Use Node.js 22 LTS with npm 10.9.2 for release validation (`npx --yes npm@10.9.2 ci` also works without changing a global npm installation). The repository pins `packageManager` to npm 10.9.2. npm 11 reports the deliberate scoped patched-Undici override as invalid; release topology checks use npm 10, and transport regression tests remain required. Provider account authentication must be configured separately on each worker host.

## Local development credentials

After copying `.env.example` to `.env`, set `NODE_ENV=development`, `PUBLIC_ORIGIN=http://127.0.0.1:5173`, `SERVER_URL=http://127.0.0.1:3847`, `TRUST_PROXY=0`, and uncomment `APP_PASSWORD` with a local-only password. Configure `WORKER_TOKEN` identically for server and worker. Use a private `SESSION_SECRET` if sessions must survive restarts. Run the three `dev:*` commands in separate terminals. The credential generator is for HTTPS production environments; production always requires a password hash.

## Release, backup and rollback

Build and test the exact Git revision with the pinned package manager, then run `npm run package:release`. The `release/` directory contains a runtime archive, SHA-256 sidecar, and an embedded per-file `RELEASE-MANIFEST.json`. Verify the checksum before unpacking into a separate staging directory and invoking `deploy/install-server.sh` as described above. Keep the existing private server `.env`; do not put credentials into the release archive. GitLab's release job produces the same archive only after its validation jobs pass.

The `deploy/rollback-server.sh` script expects a **private installed-tree backup**, not the credential-free CI release archive. For the default install directory, stop the application briefly and create it as follows:

```sh
sudo systemctl stop remote-agents
sudo sh -c 'umask 077; tar -czf /root/remote-agents-backup.tgz -C /opt remote-agents'
sudo systemctl start remote-agents
```

Also back up the active systemd unit/drop-ins, nginx vhost and external session directory separately. The installed-tree archive must contain exactly one top-level directory matching the installation basename (`remote-agents/` by default), including `.env`, `apps/server/dist/index.js` and `node_modules/`. Normal npm workspace and `.bin` links are supported when they resolve to a regular file or directory inside that archive root. Rollback rejects corrupt archives, unexpected roots, path traversal, duplicate paths, escaping or chained links, paths descending through links, and special files before stopping the service or moving the existing install. When run as root, extraction restores archived numeric ownership as well as permission bits. Adapt the basename and parent directory consistently for a custom installation path. Do not upload this archive to GitLab: it contains live credentials.

To restore that installed tree, use `sudo REMOTE_AGENTS_SERVICE_NAME=remote-agents bash deploy/rollback-server.sh /root/remote-agents-backup.tgz`, then restore any separately changed unit/drop-ins, nginx configuration and external session data. The service name is validated and defaults to `remote-agents`. The script stages and validates the complete archive on the destination filesystem before downtime, preserves the displaced private install with a timestamp, and attempts to restore the previous tree and service if activation fails. A successful restore restarts the selected unit even when it was failed or inactive before rollback. After restart the script checks once per second that the unit remains active for five seconds; `RA_POST_RESTART_VERIFY_SECONDS` may select a bounded 1–60 second window for slower applications. Recovery reports restart failures and the resulting service state instead of hiding them. Once the application passes its health window it is committed: a later nginx reload failure returns nonzero and requires operator attention, but deliberately keeps the healthy restored application and timestamped prior tree in place. It assumes a compatible service unit and runtime already exist; it is not a host-level or cross-version operating-system restore. Check service status, authenticated dashboard health and one harmless agent run afterward.

For a disposable isolated rehearsal only, select both a non-production install path and a dedicated systemd unit, and set `RA_SKIP_NGINX=1` so the production nginx service is neither checked nor reloaded:

```sh
sudo REMOTE_AGENTS_INSTALL_DIR=/opt/remote-agents-rollback-test \
  REMOTE_AGENTS_SERVICE_NAME=remote-agents-rollback-test \
  RA_SKIP_NGINX=1 \
  bash deploy/rollback-server.sh /root/remote-agents-rollback-test.tgz
```

The archive top-level directory must match the selected install basename (`remote-agents-rollback-test/` in this example). Never use the production service name for an isolated rehearsal. A disposable full rollback rehearsal remains a release gate until executed on the target hosting layout.

To remove services while retaining files/state, use `deploy/uninstall-server.sh` with the configured domain, or the worker platform `uninstall-*` script. Review which unit/vhost it targets before removal; installation state and workspaces are preserved.
