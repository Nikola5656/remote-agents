#!/usr/bin/env node
/**
 * Shared helpers for non-interactive worker/server setup scripts.
 * No secrets are logged.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MIN_NODE_WORKER = [22, 13];
export const MIN_NODE_SERVER = [22, 13];

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(arg);
  }
  return out;
}

export function log(msg) {
  process.stdout.write(`${msg}\n`);
}

export function warn(msg) {
  process.stderr.write(`warning: ${msg}\n`);
}

export function fail(msg, code = 1) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

export function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: opts.capture ? "pipe" : "inherit",
    env: opts.env ?? process.env,
    cwd: opts.cwd,
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${cmd} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`, result.status ?? 1);
  }
  return result;
}

export function runSoft(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: opts.capture ? "pipe" : "inherit",
    env: opts.env ?? process.env,
    cwd: opts.cwd,
  });
}

export function parseNodeVersion(version = process.versions.node) {
  return version.split(".").map((part) => Number(part.replace(/[^0-9].*$/, "")));
}

export function nodeAtLeast(minParts, version = process.versions.node) {
  const have = parseNodeVersion(version);
  for (let i = 0; i < minParts.length; i++) {
    const a = have[i] || 0;
    const b = minParts[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

export function assertNode(minParts = MIN_NODE_WORKER, label = "worker") {
  const minLabel = Array.isArray(minParts) ? minParts.join(".") : String(minParts);
  if (!nodeAtLeast(Array.isArray(minParts) ? minParts : [minParts])) {
    fail(`${label} requires Node >= ${minLabel}; found ${process.versions.node}`);
  }
}

export function commandExists(name) {
  const checker = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [name] : ["-v", name];
  const result = runSoft(checker, args, { capture: true });
  return result.status === 0;
}

export function which(name) {
  if (process.platform === "win32") {
    const result = runSoft("where", [name], { capture: true });
    if (result.status !== 0) return "";
    return (result.stdout || "").trim().split(/\r?\n/)[0] || "";
  }
  const result = runSoft("which", [name], { capture: true });
  if (result.status !== 0) return "";
  return (result.stdout || "").trim().split("\n")[0] || "";
}

export function isWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSLENV) return true;
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export function resolveWorkerEntry(repoRoot = REPO_ROOT) {
  const pkgPath = path.join(repoRoot, "apps/worker/package.json");
  let main = "dist/index.js";
  if (fs.existsSync(pkgPath)) {
    try {
      main = JSON.parse(fs.readFileSync(pkgPath, "utf8")).main || main;
    } catch {
      /* keep default */
    }
  }
  const entry = path.join(repoRoot, "apps/worker", main);
  if (fs.existsSync(entry)) return entry;
  for (const rel of [main, "dist/index.js", "dist/main.js"]) {
    const candidate = path.join(repoRoot, "apps/worker", rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return entry;
}

export function sanitizeAuthOutput(text) {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key[=:]\s*\S+/gi, "api_key=[redacted]")
    .replace(/token[=:]\s*\S+/gi, "token=[redacted]")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" | ")
    .slice(0, 240);
}

export function readEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const raw of fs.readFileSync(filePath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function mergeEnv(repoEnvPath, extra = {}) {
  return { ...readEnvFile(repoEnvPath), ...extra };
}

export function defaultWorkerStateDir() {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "remote-agents-worker");
  }
  return path.join(os.homedir(), ".local", "share", "remote-agents-worker");
}

export function defaultWorkspacesRoot() {
  return path.join(os.homedir(), "remote-agent-workspaces");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function copyTemplate(src, dest, vars) {
  let text = fs.readFileSync(src, "utf8");
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${key}}}`, String(value));
  }
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, text);
}

export function npmCi(repoRoot) {
  log("==> npm ci");
  run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: repoRoot });
}

export function npmBuild(repoRoot) {
  log("==> npm run build");
  run("npm", ["run", "build"], { cwd: repoRoot });
}

export function platformLabel() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return isWsl() ? "windows-wsl" : "linux";
  if (process.platform === "win32") return "windows";
  return process.platform;
}
