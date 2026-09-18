import { DEFAULT_AGENTS, type ModelProvider } from "@remote-agents/shared";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ClaudeRuntime } from "./claude-runtime";
import { CodexRuntime } from "./codex-runtime";
import { AgentPool } from "./agent-pool";
import { BridgeCursorRuntime } from "./bridge-cursor-runtime";
import { CliCursorRuntime } from "./cli-cursor-runtime";
import { ProcessClaudeLauncher } from "./claude";
import { CloudAgentsApi } from "./cloud-api";
import {
  createComposerSidebar,
  defaultComposerDbPath,
  enforceChatsCurrent,
} from "./composer-sidebar";
import { loadConfig } from "./config";
import { DegradedCursorRuntime, SdkCursorRuntime } from "./cursor-runtime";
import { assertBridgeEnabled, DesktopBridge, logBridgeState } from "./desktop-bridge";
import { buildHealth } from "./health";
import { MachineCursorRuntime } from "./machine-cursor-runtime";
import { MachineWorkers } from "./machine-workers";
import { KeepAwake } from "./keep-awake";
import { log, logError } from "./log";
import { AgentStore } from "./persist";
import type { CursorRuntime } from "./runtime";
import { WorkerTransport } from "./transport";

function cursorBinAvailable(bin: string): boolean {
  try {
    const result = spawnSync(bin, ["--help"], { timeout: 8000, encoding: "utf8" });
    return result.status === 0 || Boolean(result.stdout);
  } catch {
    return false;
  }
}

function fallbackToCli(config: ReturnType<typeof loadConfig>, reason: string): CursorRuntime {
  log("machine runtime unavailable — falling back to CLI runtime:", reason);
  log("fix: switch Privacy Mode (Legacy) → Privacy Mode at cursor.com/dashboard?tab=settings");
  // Re-probe periodically; exit cleanly so the LaunchAgent restarts into
  // machine mode as soon as the account setting is fixed.
  const api = new CloudAgentsApi(config.cursorApiKey);
  const timer = setInterval(() => {
    void api.probe().then(({ ok }) => {
      if (ok) {
        log("cloud agents became available — restarting into machine runtime");
        process.exit(0);
      }
    });
  }, 300_000);
  timer.unref?.();
  return pickCursorRuntime({ ...config, cursorRuntime: "cli" });
}

function pickBridgeRuntime(config: ReturnType<typeof loadConfig>): CursorRuntime {
  const dbPath = defaultComposerDbPath();
  // Continuously re-stamp the bridge enablement keys to disk so a freshly
  // launched Cursor loads them (a running Cursor uses an in-memory cache and
  // rewrites the server-config on quit).
  const agentChatIds = (): string[] => {
    try {
      const store = new AgentStore(path.join(config.dataDir, "agents.json"));
      return Object.values(store.load().agents)
        .map((slot) => slot.cursorAgentId)
        .filter((id): id is string => Boolean(id) && !id!.startsWith("codex:"));
    } catch {
      return [];
    }
  };
  const stamp = () => {
    assertBridgeEnabled(dbPath);
    enforceChatsCurrent(dbPath, agentChatIds());
  };
  stamp();
  const flagTimer = setInterval(stamp, 8_000);
  flagTimer.unref?.();

  const sidebar = createComposerSidebar({ chatWorkspace: config.chatWorkspace });
  if (!sidebar) {
    log("bridge runtime unavailable — sidebar workspace mapping missing, using CLI");
    return pickCursorRuntime({ ...config, cursorRuntime: "cli" });
  }
  const bridge = new DesktopBridge();
  if (!bridge.available()) {
    log("desktop bridge not running — falling back to CLI runtime");
    log("fix: restart the Cursor app (bridge flags are set; the server starts at app launch)");
    // Exit cleanly once the bridge appears so the LaunchAgent restarts into it.
    const timer = setInterval(() => {
      if (new DesktopBridge().available()) {
        log("desktop bridge became available — restarting into bridge runtime");
        process.exit(0);
      }
    }, 20_000);
    timer.unref?.();
    return pickCursorRuntime({ ...config, cursorRuntime: "cli" });
  }
  logBridgeState();
  log("bridge runtime active — messages run inside the Cursor IDE, live in the sidebar");
  const cliFallback = new CliCursorRuntime({
    bin: config.cursorBin, chatWorkspace: config.chatWorkspace, sidebar,
    sandbox: config.sandboxMode, forceRuns: config.forceRuns,
  });
  return new BridgeCursorRuntime(bridge, sidebar, cliFallback, config.cursorApiKey);
}

export async function pickRuntimeWithProbe(
  config: ReturnType<typeof loadConfig>
): Promise<CursorRuntime> {
  if (config.cursorRuntime === "bridge") return pickBridgeRuntime(config);
  if (config.cursorRuntime !== "machine") return pickCursorRuntime(config);
  if (!config.cursorApiKey) return fallbackToCli(config, "CURSOR_API_KEY missing");
  const api = new CloudAgentsApi(config.cursorApiKey);
  const probe = await api.probe();
  if (!probe.ok) return fallbackToCli(config, probe.reason || "probe failed");
  const workers = new MachineWorkers({
    bin: config.cursorBin,
    apiKey: config.cursorApiKey,
    dirs: [config.workspacesRoot, os.homedir()],
    machineName: (process.env.WORKER_MACHINE_NAME || "").trim() || undefined,
  });
  log("machine runtime active — agents run locally, chats sync to the IDE sidebar");
  return new MachineCursorRuntime(api, workers);
}

export function pickCursorRuntime(config: ReturnType<typeof loadConfig>): CursorRuntime {
  if (config.cursorRuntime === "sdk") {
    log("CURSOR_RUNTIME=sdk — headless SDK (sessions will not appear in this window sidebar)");
    return new SdkCursorRuntime();
  }
  if (config.cursorRuntime === "degraded") {
    return new DegradedCursorRuntime();
  }
  if (!cursorBinAvailable(config.cursorBin)) {
    log("cursor CLI not found — core agents will stay online in degraded mode");
    return new DegradedCursorRuntime();
  }
  const sidebar = createComposerSidebar({ chatWorkspace: config.chatWorkspace });
  return new CliCursorRuntime({
    bin: config.cursorBin,
    chatWorkspace: config.chatWorkspace,
    sidebar,
    sandbox: config.sandboxMode,
    forceRuns: config.forceRuns,
  });
}

export function probeProviderHealth(probe: () => { ready: boolean; detail: string }): { ready: boolean; detail: string } {
  try { return probe(); }
  catch (error) { return { ready: false, detail: error instanceof Error ? error.message : String(error) }; }
}

export async function main(): Promise<void> {
  const config = loadConfig();
  log(
    "starting",
    config.workerId,
    "workspaces",
    config.workspacesRoot,
    config.defaultCwd ? `shared ${config.defaultCwd}` : "per-agent folders"
  );

  const keepAwake = new KeepAwake(config.keepAwake);
  keepAwake.start();

  const enabledProviders = new Set<ModelProvider>((config.fleet ?? DEFAULT_AGENTS).map((agent) => agent.provider));
  let runtime: CursorRuntime;
  try { runtime = enabledProviders.has("cursor") ? await pickRuntimeWithProbe(config) : new DegradedCursorRuntime(); }
  catch (error) {
    logError("Cursor initialization failed; other providers will still start", error);
    runtime = new DegradedCursorRuntime();
  }
  log("cursor runtime", runtime.kind, "chat workspace", config.chatWorkspace);

  const codexRuntime = enabledProviders.has("codex") ? new CodexRuntime() : undefined;
  let codexHealth = probeProviderHealth(() => codexRuntime?.health() ?? { ready: false, detail: "Codex is not configured in this fleet" });
  const codexHealthTimer = setInterval(() => { codexHealth = probeProviderHealth(() => codexRuntime?.health() ?? { ready: false, detail: "Codex is not configured in this fleet" }); }, 60_000);
  codexHealthTimer.unref();
  const claudeRuntime = enabledProviders.has("claude") ? new ClaudeRuntime(config.claudeBin) : undefined;
  let claudeHealth = probeProviderHealth(() => claudeRuntime?.health() ?? { ready: false, detail: "Claude is not configured in this fleet" });
  const claudeHealthTimer = setInterval(() => { claudeHealth = probeProviderHealth(() => claudeRuntime?.health() ?? { ready: false, detail: "Claude is not configured in this fleet" }); }, 60_000);
  claudeHealthTimer.unref();
  const claude = new ProcessClaudeLauncher();
  const store = new AgentStore(path.join(config.dataDir, "agents.json"));

  let transport: WorkerTransport | undefined;
  const pool = new AgentPool({
    config,
    runtime,
    codexRuntime,
    claudeRuntime,
    providerHealth: { codex: () => codexHealth, claude: () => claudeHealth },
    claude,
    store,
    onAgentUpdate: (agent) => transport?.sendAgentUpdate(agent),
  });

  const health = () => {
    const report = buildHealth({
      config,
      connected: transport?.connected ?? false,
      lastHeartbeatAt: transport?.lastHeartbeat ?? null,
      keepAwake: keepAwake.report(),
      cursorSdk: pool.sdkHealth(),
      codex: pool.snapshots().some((agent) => agent.provider === "codex") ? codexHealth : undefined,
      agents: pool.snapshots(),
    });
    report.claude = { available: claudeHealth.ready, detail: claudeHealth.detail };
    if (pool.snapshots().some((agent) => agent.provider === "claude") && !claudeHealth.ready) {
      report.issues.push(claudeHealth.detail);
      report.ok = false;
    }
    return report;
  };

  await pool.start();

  transport = new WorkerTransport(config, {
    health,
    agents: () => pool.snapshots(),
    onCommand: (msg) => pool.dispatch(msg),
  });
  transport.start();

  const shutdown = async (signal: string) => {
    log("shutting down", signal);
    transport?.stop();
    keepAwake.stop();
    clearInterval(codexHealthTimer);
    clearInterval(claudeHealthTimer);
    await pool.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

export function runMain(): void {
  main().catch((err) => {
    logError(err);
    process.exit(1);
  });
}
