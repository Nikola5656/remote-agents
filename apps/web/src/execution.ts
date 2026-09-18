import { modelLabel, modelProvider } from "@remote-agents/shared";

export type ModelProviderKind = "cursor" | "codex" | "claude";

/** Minimal agent fields for execution UI (matches AgentSnapshot). */
export type ExecutionAgentStatus =
  | "idle"
  | "running"
  | "queued"
  | "error"
  | "offline"
  | "starting";

export interface ExecutionAgent {
  status: ExecutionAgentStatus;
  model: string;
  provider?: ModelProviderKind;
  headline: string;
  summary?: string;
  updatedAt: number;
  queueLength: number;
  runId?: string;
  runStartedAt?: number;
  toolCount?: number;
  lastEventAt?: number;
  lastActions?: string[];
  subagents?: Array<{ name: string; status: "running" | "done" }>;
}

export type ExecutionPhase =
  | "offline"
  | "connecting"
  | "queued"
  | "running"
  | "ready"
  | "error";

/** No stream events for this long while still "running" → stale warning. */
export const STALE_RUN_MS = 45_000;

export interface ExecutionView {
  phase: ExecutionPhase;
  statusLabel: string;
  headline: string;
  elapsedMs: number | null;
  lastUpdateMs: number | null;
  updateAgeMs: number | null;
  isStale: boolean;
  toolCount: number;
  lastActions: string[];
  provider: ModelProviderKind;
  providerLabel: string;
}

/** Prefer worker-reported provider; fall back to shared catalog rules. */
export function resolveAgentProvider(agent: ExecutionAgent): ModelProviderKind {
  if (agent.provider) return agent.provider;
  if (agent.model.startsWith("claude-code:")) return "claude";
  const provider = modelProvider(agent.model);
  return provider === "codex" ? "codex" : "cursor";
}

export function providerLabel(kind: ModelProviderKind): string {
  switch (kind) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    default:
      return "Cursor";
  }
}

export function displayExecutionModel(id: string): string {
  return modelLabel(id);
}

export function executionPhase(status: ExecutionAgentStatus): ExecutionPhase {
  switch (status) {
    case "offline":
      return "offline";
    case "starting":
      return "connecting";
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "error":
      return "error";
    case "idle":
    default:
      return "ready";
  }
}

export function executionStatusLabel(phase: ExecutionPhase): string {
  switch (phase) {
    case "connecting":
      return "Connecting";
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "ready":
      return "Ready";
    case "error":
      return "Error";
    case "offline":
      return "Offline";
  }
}

export function buildExecutionView(
  agent: ExecutionAgent,
  now = Date.now()
): ExecutionView {
  const phase = executionPhase(agent.status);
  const provider = resolveAgentProvider(agent);
  const active = phase === "running" || phase === "connecting";
  const lastUpdateMs =
    agent.lastEventAt ??
    (active ? agent.runStartedAt : undefined) ??
    agent.updatedAt;
  const updateAgeMs = lastUpdateMs
    ? Math.max(0, now - lastUpdateMs)
    : null;
  const isStale =
    phase === "running" &&
    updateAgeMs !== null &&
    updateAgeMs >= STALE_RUN_MS;

  let headline = agent.headline || "Standing by";
  if (phase === "ready" && (headline === "Idle" || !headline)) {
    headline = "Ready for your next task";
  }
  if (phase === "connecting" && !agent.headline) {
    headline = "Connecting to agent…";
  }
  if (phase === "queued" && !agent.headline) {
    headline = "Instruction queued — waiting to start";
  }
  if (isStale && updateAgeMs !== null) {
    const secs = Math.floor(updateAgeMs / 1000);
    headline = `Still running — no stream updates for ${secs}s`;
  }

  return {
    phase,
    statusLabel: executionStatusLabel(phase),
    headline,
    elapsedMs:
      active && agent.runStartedAt
        ? Math.max(0, now - agent.runStartedAt)
        : null,
    lastUpdateMs,
    updateAgeMs,
    isStale,
    toolCount: agent.toolCount ?? 0,
    lastActions: agent.lastActions ?? [],
    provider,
    providerLabel: providerLabel(provider),
  };
}

export function fleetCounts(agents: ExecutionAgent[]) {
  const byProvider = { cursor: 0, codex: 0, claude: 0 };
  for (const agent of agents) {
    byProvider[resolveAgentProvider(agent)] += 1;
  }
  return {
    connecting: agents.filter((a) => a.status === "starting").length,
    queued: agents.filter((a) => a.status === "queued").length,
    running: agents.filter(
      (a) => a.status === "running" || a.status === "starting"
    ).length,
    ready: agents.filter((a) => a.status === "idle").length,
    attention: agents.filter(
      (a) => a.status === "error" || a.status === "offline"
    ).length,
    instructionsQueued: agents.reduce((n, a) => n + a.queueLength, 0),
    ...byProvider,
  };
}
