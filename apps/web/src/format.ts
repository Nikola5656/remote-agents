import type { AgentSnapshot, AgentStatus, HealthReport } from "@remote-agents/shared";
import {
  CORE_AGENT_IDS,
  CORE_AGENTS,
  emptyAgent,
  modelLabel,
} from "@remote-agents/shared";

export type OverallHealth = "ok" | "degraded" | "down";
export type LiveMode = "live" | "poll" | "offline";

export function overallHealth(health: HealthReport): OverallHealth {
  if (!health.workerConnected) return "down";
  if (!health.ok || health.issues.length > 0) return "degraded";
  return "ok";
}

export function liveModeLabel(mode: LiveMode): string {
  switch (mode) {
    case "live":
      return "LIVE";
    case "poll":
      return "POLL";
    default:
      return "NO LINK";
  }
}

export function statusLabel(status: AgentStatus): string {
  switch (status) {
    case "idle":
      return "Ready";
    case "running":
      return "Running";
    case "queued":
      return "Queued";
    case "error":
      return "Error";
    case "offline":
      return "Offline";
    case "starting":
      return "Connecting";
    default:
      return status;
  }
}

export function formatRelative(ts: number | null, now = Date.now()): string {
  if (!ts) return "never";
  const delta = Math.max(0, Math.round((now - ts) / 1000));
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  const mins = Math.floor(delta / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatUptime(sec: number): string {
  if (!sec || sec < 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** mm:ss or h:mm:ss elapsed since startMs. */
export function formatElapsed(startMs: number, now = Date.now()): string {
  const total = Math.max(0, Math.floor((now - startMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function displayModel(id: string): string {
  return modelLabel(id);
}

export function agentWithModel(name: string, model: string): string {
  return `${name} · ${displayModel(model)}`;
}

/** Claude sidecars attached to a parent slot — not first-class fleet rows. */
export function isClaudeSidecar(agent: AgentSnapshot): boolean {
  return Boolean(agent.parentId);
}

/** Legacy agent-1/2/3 placeholders apply only when the worker still uses them. */
export function usesLegacyCoreSlots(agents: AgentSnapshot[]): boolean {
  if (agents.length === 0) return true;
  const ids = new Set(agents.map((agent) => agent.id));
  return CORE_AGENT_IDS.some((id) => ids.has(id));
}

export function mergeAgentLists(agents: AgentSnapshot[]): AgentSnapshot[] {
  const fleet = agents.filter((agent) => !isClaudeSidecar(agent));

  if (fleet.length === 0) {
    return CORE_AGENTS.map((core) =>
      emptyAgent(core.id, core.name, core.defaultModel, "core")
    );
  }

  if (!usesLegacyCoreSlots(fleet)) {
    return fleet;
  }

  const map = new Map(fleet.map((agent) => [agent.id, agent]));
  const cores = CORE_AGENTS.map(
    (core) =>
      map.get(core.id) ?? emptyAgent(core.id, core.name, core.defaultModel, "core")
  );
  const extras = fleet.filter(
    (agent) =>
      !CORE_AGENT_IDS.includes(agent.id as (typeof CORE_AGENT_IDS)[number])
  );
  return [...cores, ...extras];
}

export function corePresence(health: HealthReport, agents: AgentSnapshot[]) {
  return CORE_AGENTS.map((core) => {
    const fromHealth = health.agents.find((a) => a.id === core.id);
    const fromList = agents.find((a) => a.id === core.id);
    const present =
      fromHealth?.present ??
      Boolean(fromList && fromList.status !== "offline");
    const status = fromHealth?.status ?? fromList?.status ?? "offline";
    const model = fromList?.model ?? core.defaultModel;
    return { ...core, present, status, model };
  });
}

export function isAgentSnapshot(value: unknown): value is AgentSnapshot {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as AgentSnapshot).id === "string" &&
      typeof (value as AgentSnapshot).name === "string"
  );
}

export const LAST_AGENT_KEY = "ra:lastAgent";

export function readLastAgent(): string | null {
  try {
    return sessionStorage.getItem(LAST_AGENT_KEY);
  } catch {
    return null;
  }
}

export function writeLastAgent(id: string): void {
  try {
    sessionStorage.setItem(LAST_AGENT_KEY, id);
  } catch {
    /* ignore quota / private mode */
  }
}

export function agentsNavPath(): string {
  const last = readLastAgent();
  return last ? `/agents/${encodeURIComponent(last)}` : "/overview";
}

/** Remember the last instruction successfully accepted by the worker. */
export function rememberPrompt(agentId: string, text: string): void {
  try {
    sessionStorage.setItem(`ra:lastPrompt:${agentId}`, text);
  } catch {
    /* ignore quota / private mode */
  }
}

export function readPrompt(agentId: string): string | null {
  try {
    return sessionStorage.getItem(`ra:lastPrompt:${agentId}`);
  } catch {
    return null;
  }
}
