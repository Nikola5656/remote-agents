import os from "node:os";
import type { AgentSnapshot, AgentStatus, HealthReport } from "@remote-agents/shared";
import { resolveClaudeBin } from "./claude";
import type { WorkerConfig } from "./config";
import type { KeepAwakeReport } from "./keep-awake";

export interface SdkHealth {
  ready: boolean;
  apiKeyPresent: boolean;
  detail: string;
}

export function buildHealth(input: {
  config: WorkerConfig;
  connected: boolean;
  lastHeartbeatAt: number | null;
  keepAwake: KeepAwakeReport;
  cursorSdk: SdkHealth;
  codex?: { ready: boolean; detail: string };
  agents: AgentSnapshot[];
}): HealthReport {
  const claude = resolveClaudeBin(input.config.claudeBin);
  const issues: string[] = [];
  if (!input.connected) issues.push("Worker is not connected to the control server");
  if (!input.cursorSdk.ready) {
    issues.push(input.cursorSdk.detail || "Cursor chats are not ready");
  }
  if (input.config.keepAwake && process.platform === "darwin" && !input.keepAwake.preventingSleep) {
    issues.push("caffeinate is not preventing sleep");
  }
  if (input.codex && !input.codex.ready) issues.push(input.codex.detail);
  const failed = input.agents.filter((a) => a.status === "error");
  if (failed.length) issues.push(`Agents need attention: ${failed.map((a) => a.name).join(", ")}`);
  const missing = input.agents.filter((a) => a.status === "offline");
  if (missing.length) issues.push(`Offline agents: ${missing.map((a) => a.id).join(", ")}`);

  return {
    ok: issues.length === 0 && input.connected,
    workerConnected: input.connected,
    lastHeartbeatAt: input.lastHeartbeatAt,
    keepAwake: input.keepAwake,
    cursorSdk: input.cursorSdk,
    codex: input.codex,
    claude: { available: claude.available, detail: claude.detail },
    agents: input.agents.map((a) => ({
      id: a.id,
      present: a.status !== "offline",
      status: a.status as AgentStatus,
    })),
    issues,
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      uptimeSec: Math.round(os.uptime()),
    },
  };
}
