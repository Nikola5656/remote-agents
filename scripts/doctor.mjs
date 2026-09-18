#!/usr/bin/env node
/**
 * Preflight checks for remote-agents worker install.
 * Non-interactive; exits 1 on hard failures, 0 with warnings only.
 */
import fs from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  MIN_NODE_WORKER,
  assertNode,
  nodeAtLeast,
  defaultWorkerStateDir,
  defaultWorkspacesRoot,
  log,
  platformLabel,
  readEnvFile,
  resolveWorkerEntry,
  runSoft,
  sanitizeAuthOutput,
  which,
} from "./setup-lib.mjs";

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const json = args.has("--json");

const report = {
  platform: platformLabel(),
  node: process.versions.node,
  repo: REPO_ROOT,
  checks: [],
  ok: true,
};

function add(name, status, detail) {
  report.checks.push({ name, status, detail });
  if (status === "fail") report.ok = false;
}

function checkNode() {
  const min = MIN_NODE_WORKER.join(".");
  if (nodeAtLeast(MIN_NODE_WORKER)) add("node", "pass", `Node ${process.versions.node} (>= ${min})`);
  else add("node", "fail", `Node ${process.versions.node}; worker requires >= ${min}`);
}

function checkRepo() {
  const pkg = path.join(REPO_ROOT, "package.json");
  if (fs.existsSync(pkg)) add("repo", "pass", REPO_ROOT);
  else add("repo", "fail", `missing package.json at ${REPO_ROOT}`);
}

function checkEnv() {
  const envPath = path.join(REPO_ROOT, ".env");
  const env = readEnvFile(envPath);
  const required = ["SERVER_URL", "WORKER_TOKEN"];
  const missing = required.filter((k) => !env[k] && !process.env[k]);
  if (missing.length) {
    add("env", strict ? "fail" : "warn", `missing ${missing.join(", ")} (copy .env.example)`);
  } else {
    add("env", "pass", ".env has SERVER_URL and WORKER_TOKEN");
  }
  if (!env.CURSOR_API_KEY && !process.env.CURSOR_API_KEY) {
    add("cursor-api-key", "warn", "CURSOR_API_KEY not set (CLI/SDK modes need it)");
  } else {
    add("cursor-api-key", "pass", "CURSOR_API_KEY present");
  }
}

function checkWritableState() {
  const stateDir = process.env.WORKER_DATA_DIR || defaultWorkerStateDir();
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const probe = path.join(stateDir, ".write-test");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    add("state-dir", "pass", stateDir);
  } catch (err) {
    add("state-dir", "fail", `${stateDir}: ${err.message}`);
  }
  const workspaces = process.env.WORKSPACES_ROOT || defaultWorkspacesRoot();
  try {
    fs.mkdirSync(workspaces, { recursive: true });
    add("workspaces-root", "pass", workspaces);
  } catch (err) {
    add("workspaces-root", "warn", `${workspaces}: ${err.message}`);
  }
}

function checkCodexLogin() {
  const codex = which(process.env.CODEX_BIN || "codex");
  if (!codex) {
    add("codex-login", "warn", "codex binary not found; run after installing Codex CLI");
    return;
  }
  const auth = runSoft(codex, ["login", "status"], { capture: true });
  const text = `${auth.stdout || ""}${auth.stderr || ""}`.toLowerCase();
  if (auth.status === 0 && (text.includes("logged in") || text.includes("authenticated"))) {
    add("codex-login", "pass", "codex login status OK");
  } else {
    add("codex-login", strict ? "fail" : "warn", "run `codex login` on this machine");
  }
}

function checkCursorLogin() {
  const cursor = which(process.env.CURSOR_BIN || "cursor");
  if (!cursor) {
    add("cursor-cli", "warn", "cursor CLI not on PATH");
    return;
  }
  const ver = runSoft(cursor, ["--version"], { capture: true });
  if (ver.status === 0) add("cursor-cli", "pass", (ver.stdout || ver.stderr || "").trim().split("\n")[0]);
  else add("cursor-cli", "warn", "cursor --version failed");
}

function checkClaude() {
  const bin = process.env.CLAUDE_BIN || "claude";
  const found = which(bin) || (fs.existsSync(bin) ? bin : "");
  if (!found) {
    add("claude-cli", strict ? "fail" : "warn", `${bin} not on PATH; install Claude Code CLI (four default agents)`);
    add("claude-auth", strict ? "fail" : "warn", "run `claude auth login` after installing Claude Code CLI");
    return;
  }

  const ver = runSoft(found, ["--version"], { capture: true });
  const verLine = ver.status === 0 ? sanitizeAuthOutput(`${ver.stdout || ""}${ver.stderr || ""}`) : found;
  add("claude-cli", "pass", verLine || "Claude Code CLI");

  const auth = runSoft(found, ["auth", "status", "--json"], { capture: true });
  let authenticated = false;
  try { authenticated = auth.status === 0 && JSON.parse(auth.stdout || "{}").loggedIn === true; } catch { /* unavailable */ }
  add("claude-auth", authenticated ? "pass" : strict ? "fail" : "warn",
    authenticated ? "logged in" : "run `claude auth login` (Claude Code)");
}

function checkPlatformNotes() {
  const label = platformLabel();
  if (label === "windows") {
    add(
      "platform-support",
      "warn",
      "Native Windows worker is not supported. Use WSL2 Ubuntu and install the Linux systemd user worker inside WSL: powershell -File scripts/setup-worker-wsl.ps1"
    );
  } else if (label === "windows-wsl") {
    add(
      "platform-support",
      "pass",
      "Windows via WSL2: Linux worker with systemd user service (install inside WSL, not native Windows)."
    );
  } else if (label === "linux") {
    add(
      "platform-support",
      "pass",
      "Linux supported for CLI worker via systemd user service; Codex desktop bridge requires macOS."
    );
  } else {
    add("platform-support", "pass", "macOS is the primary worker platform");
  }
}

function checkBuildArtifacts() {
  const entry = resolveWorkerEntry(REPO_ROOT);
  const rel = path.relative(REPO_ROOT, entry);
  if (fs.existsSync(entry)) {
    add("build", "pass", `${rel} present (apps/worker package.json main)`);
  } else {
    add("build", "warn", `missing ${rel}; run npm run build before installing service`);
  }
}

function main() {
  assertNode(MIN_NODE_WORKER, "doctor");
  checkRepo();
  checkNode();
  checkPlatformNotes();
  checkEnv();
  checkWritableState();
  checkClaude();
  checkCursorLogin();
  checkCodexLogin();
  checkBuildArtifacts();

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    log(`doctor: platform=${report.platform} node=${report.node}`);
    for (const c of report.checks) {
      const mark = c.status === "pass" ? "ok" : c.status === "warn" ? "!!" : "XX";
      log(`  [${mark}] ${c.name}: ${c.detail}`);
    }
  }
  if (!report.ok || (strict && report.checks.some((c) => c.status === "warn"))) {
    process.exit(1);
  }
}

main();
