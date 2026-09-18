import type { ModelProvider } from "./models";

export type DeliveryMode = "interrupt" | "queue";
export type OutputMode = "condensed" | "full";
export type AgentStatus =
  | "idle"
  | "running"
  | "queued"
  | "error"
  | "offline"
  | "starting";
export type AgentKind = "core" | "extra" | "claude";

export interface QueuedInstruction {
  id: string;
  text: string;
  mode: DeliveryMode;
  createdAt: number;
}

export interface AgentSnapshot {
  id: string;
  name: string;
  kind: AgentKind;
  parentId?: string;
  model: string;
  availableModels: string[];
  provider?: ModelProvider;
  reasoningEffort?: "medium";
  status: AgentStatus;
  percent: number;
  headline: string;
  summary: string;
  lastActions: string[];
  outputMode: OutputMode;
  queueLength: number;
  queue: QueuedInstruction[];
  condensedLog: string;
  fullLog: string;
  /** Original instruction for the current or most recently started task. */
  lastInstruction?: string;
  claude?: {
    attached: boolean;
    status: AgentStatus;
    headline: string;
    percent: number;
  };
  updatedAt: number;
  runId?: string;
  cwd?: string;
  /** Epoch ms when the current run started; undefined when not running. */
  runStartedAt?: number;
  /** Tool calls observed in the current run. */
  toolCount?: number;
  /** Epoch ms of the last streamed event for the current run. */
  lastEventAt?: number;
  /** Parallel subagents launched by the current run (Task tool). */
  subagents?: Array<{ name: string; status: "running" | "done" }>;
}

export interface HealthReport {
  ok: boolean;
  workerConnected: boolean;
  lastHeartbeatAt: number | null;
  keepAwake: {
    caffeinate: boolean;
    preventingSleep: boolean;
    detail: string;
  };
  cursorSdk: {
    ready: boolean;
    apiKeyPresent: boolean;
    detail: string;
  };
  codex?: { ready: boolean; detail: string };
  claude: {
    available: boolean;
    detail: string;
  };
  agents: Array<{ id: string; present: boolean; status: AgentStatus }>;
  issues: string[];
  host: {
    hostname: string;
    platform: string;
    uptimeSec: number;
  };
}

export type WorkerToServer =
  | {
      type: "hello";
      workerId: string;
      health: HealthReport;
      agents: AgentSnapshot[];
    }
  | {
      type: "heartbeat";
      health: HealthReport;
      agents: AgentSnapshot[];
    }
  | { type: "agent_update"; agent: AgentSnapshot }
  | {
      type: "ack";
      commandId: string;
      ok: boolean;
      error?: string;
      files?: WorkspaceFileInfo[];
      file?: WorkspaceFileContent;
    };

export type ServerToWorker =
  | {
      type: "stop_agent";
      commandId: string;
      agentId: string;
      /** The exact active run observed by the operator; stale requests are rejected. */
      runId: string;
    }
  | {
      type: "remove_queued_instruction";
      commandId: string;
      agentId: string;
      instructionId: string;
    }
  | {
      type: "command";
      commandId: string;
      agentId: string;
      mode: DeliveryMode;
      text: string;
    }
  | {
      type: "set_model";
      commandId: string;
      agentId: string;
      model: string;
    }
  | {
      type: "set_output_mode";
      commandId: string;
      agentId: string;
      outputMode: OutputMode;
    }
  | {
      type: "spawn_agent";
      commandId: string;
      name: string;
      model: string;
      cwd?: string;
    }
  | {
      type: "spawn_claude";
      commandId: string;
      agentId: string;
      text: string;
      mode: DeliveryMode;
    }
  | {
      type: "stop_claude";
      commandId: string;
      agentId: string;
      mode: DeliveryMode;
    }
  | {
      type: "set_cwd";
      commandId: string;
      agentId: string;
      cwd: string;
    }
  | {
      type: "list_files";
      commandId: string;
      agentId: string;
    }
  | {
      type: "read_file";
      commandId: string;
      agentId: string;
      path: string;
    };

export interface WorkspaceFileInfo {
  path: string;
  bytes: number;
  mtime: number;
}

export interface WorkspaceFileContent {
  path: string;
  content: string;
  bytes: number;
  mtime: number;
}

export interface UiCommandRequest {
  text: string;
  mode: DeliveryMode;
}

export function emptyHealth(): HealthReport {
  return {
    ok: false,
    workerConnected: false,
    lastHeartbeatAt: null,
    keepAwake: {
      caffeinate: false,
      preventingSleep: false,
      detail: "Worker not connected",
    },
    cursorSdk: {
      ready: false,
      apiKeyPresent: false,
      detail: "Worker not connected",
    },
    claude: { available: false, detail: "Worker not connected" },
    agents: [],
    issues: ["Worker is offline"],
    host: { hostname: "unknown", platform: "unknown", uptimeSec: 0 },
  };
}

export function emptyAgent(
  id: string,
  name: string,
  model: string,
  kind: AgentKind = "core"
): AgentSnapshot {
  return {
    id,
    name,
    kind,
    model,
    availableModels: [],
    status: "offline",
    percent: 0,
    headline: "Waiting for Worker",
    summary: "",
    lastActions: [],
    outputMode: "condensed",
    queueLength: 0,
    queue: [],
    condensedLog: "",
    fullLog: "",
    updatedAt: Date.now(),
  };
}
