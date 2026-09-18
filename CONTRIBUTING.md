# Contributing

Remote Agents is licensed under the [MIT License](LICENSE). Package manifests use `"private": true` to prevent accidental npm publication; this does not restrict use under the license.

## Prerequisites

| Component | Node.js | OS |
| --- | --- | --- |
| Monorepo build/test | ≥ 22.13 | macOS, Linux; Windows through WSL2 |
| Control server (`apps/server`) | ≥ 22.13 | Linux (systemd) or local dev |
| Worker (`apps/worker`) | ≥ 22.13 | macOS, Linux; Windows through WSL2 |
| Web dashboard (`apps/web`) | ≥ 22.13 | Any |

## Setup

```bash
git clone <your-remote> remote-agents
cd remote-agents
cp .env.example .env
# For local development set NODE_ENV=development and PUBLIC_ORIGIN=http://127.0.0.1:5173.
# Set SERVER_URL=http://127.0.0.1:3847 and APP_PASSWORD to a local-only password.
# Set TRUST_PROXY=0 for direct local development.
# Configure remaining values — see docs/setup.md
npm ci
npm run build
npm test
```

Use **`npm ci`** in a clean worktree (do not symlink a shared `node_modules` from another checkout).

Generate production server secrets locally (the generator requires an HTTPS origin):

```bash
node scripts/gen-secrets.js .env.generated
# Merge into .env; chmod 600 .env
```

## Development

```bash
npm run dev:server   # control API
npm run dev:web      # Vite dashboard
npm run dev:worker   # worker (requires env + providers)
```

## Commits

- One logical change per commit on a dedicated branch.
- Never commit `.env`, session data, API keys, or validation JSON with host-specific secrets.
- Run `npm run build && npm test` before pushing docs that claim behavior.

## Dependency updates

Run `npm audit` and `npm ls --omit=dev` at the repo root after a clean install. Record unresolved advisories and validate affected provider transports before release.

### Package manager

Use Node.js 22 LTS with npm 10.9.2 for release validation (`npx --yes npm@10.9.2 ci` also works without changing a global npm installation). The repository pins `packageManager` to npm 10.9.2. npm 11 reports the deliberate scoped patched-Undici override as invalid; release topology checks use npm 10, and transport regression tests remain required. Provider account authentication must be configured separately on each worker host.
