import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveChatWorkspace } from "./composer-sidebar";
import { DEFAULT_AGENTS, MODEL_CATALOG, modelProvider, type AgentDefinition } from "@remote-agents/shared";
import type { SandboxMode } from "./cli-cursor-runtime";

export type CursorRuntimeMode = "cli" | "sdk" | "machine" | "bridge" | "degraded";

export interface FleetAgent extends AgentDefinition { cwd?: string; }

export interface WorkerConfig {
  /** Omitted by legacy callers; pool uses DEFAULT_AGENTS. */
  fleet?: FleetAgent[];
  fleetFile?: string;
  serverUrl: string;
  serverHost: string;
  workerToken: string;
  cursorApiKey: string;
  cursorRuntime: CursorRuntimeMode;
  cursorBin: string;
  chatWorkspace: string;
  workerId: string;
  defaultCwd: string;
  workspacesRoot: string;
  controlRoot: string;
  claudeBin: string;
  keepAwake: boolean;
  dataDir: string;
  heartbeatMs: number;
  /** WORKER_SANDBOX: cursor agent --sandbox mode; disabled by default so runs can write anywhere. */
  sandboxMode: SandboxMode;
  /** WORKER_FORCE: pass --force on every run; on by default. */
  forceRuns: boolean;
}

function parseDotEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const raw of text.split("\n")) {
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
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadDotEnv(fromDir = process.cwd()): void {
  const candidates = [
    path.join(fromDir, ".env"),
    path.join(fromDir, "..", ".env"),
    path.join(fromDir, "../..", ".env"),
    path.join(__dirname, "../../../.env"),
  ];
  for (const file of candidates) {
    try {
      parseDotEnv(path.resolve(file));
    } catch {
      // ignore unreadable env files
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  if (env === process.env) loadDotEnv();
  const controlRoot = path.resolve(__dirname, "../../..");
  const defaultCwd = env.DEFAULT_CWD?.trim() ? portablePath(env.DEFAULT_CWD) : "";
  const workspacesRoot =
    (env.WORKSPACES_ROOT?.trim() ? portablePath(env.WORKSPACES_ROOT) : "") ||
    path.join(os.homedir(), "remote-agent-workspaces");
  const keep = (env.KEEP_AWAKE ?? "1").toLowerCase();
  const runtimeRaw = (env.CURSOR_RUNTIME || "cli").trim().toLowerCase();
  const cursorRuntime: CursorRuntimeMode =
    runtimeRaw === "sdk" ||
    runtimeRaw === "degraded" ||
    runtimeRaw === "machine" ||
    runtimeRaw === "bridge"
      ? runtimeRaw
      : "cli";
  const sandboxRaw = (env.WORKER_SANDBOX || "disabled").trim().toLowerCase();
  const forceRaw = (env.WORKER_FORCE ?? "1").trim().toLowerCase();
  const fleetFile = env.AGENT_FLEET_FILE?.trim() ? portablePath(env.AGENT_FLEET_FILE) : undefined;
  return {
    fleetFile,
    fleet: fleetFile ? loadFleetFile(fleetFile) : DEFAULT_AGENTS.map((agent) => ({ ...agent })),
    serverUrl: (env.SERVER_URL || "").replace(/\/$/, ""),
    serverHost: (env.SERVER_HOST || "").trim(),
    workerToken: env.WORKER_TOKEN || "",
    cursorApiKey: (env.CURSOR_API_KEY || "").trim(),
    cursorRuntime,
    cursorBin: executablePath(env.CURSOR_BIN, "cursor"),
    chatWorkspace: env.CURSOR_CHAT_WORKSPACE?.trim() ? portablePath(env.CURSOR_CHAT_WORKSPACE) : resolveChatWorkspace(undefined, controlRoot),
    workerId: env.WORKER_ID?.trim() || "worker-primary",
    defaultCwd,
    workspacesRoot,
    controlRoot,
    claudeBin: executablePath(env.CLAUDE_BIN, "claude"),
    keepAwake: keep !== "0" && keep !== "false",
    dataDir: env.WORKER_DATA_DIR?.trim() ? portablePath(env.WORKER_DATA_DIR) : path.join(__dirname, "..", "data"),
    heartbeatMs: 8000,
    sandboxMode: sandboxRaw === "enabled" ? "enabled" : "disabled",
    forceRuns: forceRaw !== "0" && forceRaw !== "false",
  };
}

export function workerWsUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/worker";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Host-native absolute paths; no shell evaluation or environment interpolation. */
export function portablePath(value: string, base = process.cwd()): string {
  const clean = value.trim();
  if (!clean || clean.includes("\0")) throw new Error("Path must be nonempty and contain no NUL");
  if (clean === "~") return os.homedir();
  if (/^~[\\/]/.test(clean)) return path.resolve(os.homedir(), clean.slice(2));
  if (clean.startsWith("~")) throw new Error("Named-user home paths are not supported; use ~/ or an absolute path");
  return path.resolve(base, clean);
}

export function validateFleet(value: unknown, base = process.cwd()): FleetAgent[] {
  const fail = (message: string): never => { throw new Error(`Invalid agent fleet: ${message}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("expected {version:1,agents:[...]}");
  const root = value as Record<string, unknown>;
  if (Object.keys(root).some((key) => !["version", "agents"].includes(key))) return fail("unknown top-level field");
  if (root.version !== 1 || !Array.isArray(root.agents) || !root.agents.length || root.agents.length > 100) return fail("version must be 1 and agents must contain 1–100 entries");
  const ids = new Set<string>();
  return root.agents.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`agent ${index} must be an object`);
    const agent = value as Record<string, unknown>;
    if (Object.keys(agent).some((key) => !["id", "name", "provider", "defaultModel", "kind", "cwd"].includes(key))) return fail(`agent ${index} has an unknown field`);
    if (typeof agent.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agent.id) || agent.id.length > 80) return fail(`agent ${index} has an invalid id`);
    if (["constructor", "prototype"].includes(agent.id)) return fail(`${agent.id} is reserved`);
    if (ids.has(agent.id)) return fail(`duplicate id ${agent.id}`);
    ids.add(agent.id);
    if (typeof agent.name !== "string" || !agent.name.trim() || agent.name.length > 120 || /[\x00-\x1f]/.test(agent.name)) return fail(`${agent.id} has an invalid name`);
    if (!["cursor", "codex", "claude"].includes(String(agent.provider))) return fail(`${agent.id} requires an explicit provider`);
    if (typeof agent.defaultModel !== "string" || !MODEL_CATALOG.some((m) => m.id === agent.defaultModel)) return fail(`${agent.id} requires an exact catalog defaultModel`);
    if (modelProvider(agent.defaultModel) !== agent.provider) return fail(`${agent.id} provider/model mismatch`);
    if (agent.kind !== undefined && !["core", "extra", "claude"].includes(String(agent.kind))) return fail(`${agent.id} has an invalid kind`);
    if (agent.kind === "claude" && agent.provider !== "claude") return fail(`${agent.id}: kind claude requires provider claude`);
    if (agent.cwd !== undefined && (typeof agent.cwd !== "string" || !agent.cwd.trim())) return fail(`${agent.id} has an invalid cwd`);
    return {
      id: agent.id, name: agent.name.trim(), provider: agent.provider as FleetAgent["provider"],
      defaultModel: agent.defaultModel, kind: (agent.kind ?? (agent.provider === "claude" ? "claude" : "extra")) as FleetAgent["kind"],
      ...(agent.cwd === undefined ? {} : { cwd: portablePath(agent.cwd as string, base) }),
    };
  });
}

export function loadFleetFile(file: string): FleetAgent[] {
  const resolved = portablePath(file);
  try {
    return validateFleet(JSON.parse(fs.readFileSync(resolved, "utf8")), path.dirname(resolved));
  } catch (error) {
    throw new Error(`AGENT_FLEET_FILE ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function executablePath(value: string | undefined, fallback: string): string {
  const bin = value?.trim() || fallback;
  if (bin.includes("\0")) throw new Error("Executable path cannot contain NUL");
  return /[\\/]/.test(bin) || bin.startsWith("~") ? portablePath(bin) : bin;
}
