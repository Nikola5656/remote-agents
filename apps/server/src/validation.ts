import {
  AgentSnapshot,
  AgentStatus,
  HealthReport,
  WorkerToServer,
  WorkspaceFileContent,
  WorkspaceFileInfo,
} from "@remote-agents/shared";

export const MAX_WS_MESSAGE_BYTES = 32 * 1024 * 1024;
export const MAX_AGENT_COUNT = 100;
export const MAX_AGENT_LOG_CHARS = 256 * 1024;
export const MAX_FILE_CONTENT_CHARS = 512 * 1024;

const STATUSES = new Set<AgentStatus>([
  "idle",
  "running",
  "queued",
  "error",
  "offline",
  "starting",
]);

export class InvalidWorkerMessage extends Error {
  constructor() {
    super("Invalid worker message");
    this.name = "InvalidWorkerMessage";
  }
}

export function redactSensitive(value: string): string {
  return value
    .replace(
      /\b(password|passwd|token|secret|api[_-]?key|authorization)\b(\s*[:=]\s*)([^\r\n,;]+)/gi,
      "$1$2[REDACTED]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|key|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]");
}

function redactKnownSecrets<T>(value: T, secrets: readonly string[], key = ""): T {
  if (typeof value === "string") {
    if (key === "content") return value as T;
    let redacted: string = value;
    for (const secret of secrets) {
      if (secret.length >= 8) redacted = redacted.split(secret).join("[REDACTED]");
    }
    return redacted as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactKnownSecrets(item, secrets, key)) as T;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      (value as Record<string, unknown>)[childKey] = redactKnownSecrets(
        child,
        secrets,
        childKey
      );
    }
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidWorkerMessage();
  }
  return value as Record<string, unknown>;
}

function stringValue(
  value: unknown,
  max: number,
  options: { optional?: boolean; allowEmpty?: boolean; redact?: boolean } = {}
): string | undefined {
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string" || value.length > max) {
    throw new InvalidWorkerMessage();
  }
  if (!options.allowEmpty && value.length === 0) throw new InvalidWorkerMessage();
  if (/\u0000/.test(value)) throw new InvalidWorkerMessage();
  return options.redact ? redactSensitive(value) : value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") throw new InvalidWorkerMessage();
  return value;
}

function numberValue(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new InvalidWorkerMessage();
  }
  return value;
}

function optionalNumber(value: unknown, min: number, max: number): number | undefined {
  return value === undefined ? undefined : numberValue(value, min, max);
}

function statusValue(value: unknown): AgentStatus {
  if (typeof value !== "string" || !STATUSES.has(value as AgentStatus)) {
    throw new InvalidWorkerMessage();
  }
  return value as AgentStatus;
}

function stringArray(value: unknown, count: number, itemMax: number): string[] {
  if (!Array.isArray(value) || value.length > count) throw new InvalidWorkerMessage();
  return value.map((item) => stringValue(item, itemMax, { allowEmpty: true, redact: true }) as string);
}

function agentValue(value: unknown): AgentSnapshot {
  const input = record(value);
  const kind = stringValue(input.kind, 16) as AgentSnapshot["kind"];
  if (!new Set(["core", "extra", "claude"]).has(kind)) throw new InvalidWorkerMessage();
  const outputMode = stringValue(input.outputMode, 16) as AgentSnapshot["outputMode"];
  if (outputMode !== "condensed" && outputMode !== "full") throw new InvalidWorkerMessage();
  const provider = stringValue(input.provider, 16, { optional: true }) as AgentSnapshot["provider"];
  if (provider !== undefined && provider !== "cursor" && provider !== "codex" && provider !== "claude") {
    throw new InvalidWorkerMessage();
  }
  const reasoningEffort = stringValue(input.reasoningEffort, 16, { optional: true }) as AgentSnapshot["reasoningEffort"];
  if (reasoningEffort !== undefined && reasoningEffort !== "medium") {
    throw new InvalidWorkerMessage();
  }
  if (!Array.isArray(input.queue) || input.queue.length > 100) throw new InvalidWorkerMessage();
  const queue = input.queue.map((entry) => {
    const item = record(entry);
    const rawMode = stringValue(item.mode, 16);
    if (rawMode !== "interrupt" && rawMode !== "queue") throw new InvalidWorkerMessage();
    const mode: "interrupt" | "queue" = rawMode;
    return {
      id: stringValue(item.id, 128) as string,
      text: stringValue(item.text, 64 * 1024, { redact: true }) as string,
      mode,
      createdAt: numberValue(item.createdAt, 0, Number.MAX_SAFE_INTEGER),
    };
  });
  let claude: AgentSnapshot["claude"];
  if (input.claude !== undefined) {
    const item = record(input.claude);
    claude = {
      attached: booleanValue(item.attached),
      status: statusValue(item.status),
      headline: stringValue(item.headline, 512, { allowEmpty: true, redact: true }) as string,
      percent: numberValue(item.percent, 0, 100),
    };
  }
  let subagents: AgentSnapshot["subagents"];
  if (input.subagents !== undefined) {
    if (!Array.isArray(input.subagents) || input.subagents.length > 50) {
      throw new InvalidWorkerMessage();
    }
    subagents = input.subagents.map((entry) => {
      const item = record(entry);
      const status = stringValue(item.status, 16);
      if (status !== "running" && status !== "done") throw new InvalidWorkerMessage();
      return { name: stringValue(item.name, 128, { redact: true }) as string, status };
    });
  }
  return {
    id: stringValue(input.id, 128) as string,
    name: stringValue(input.name, 128, { redact: true }) as string,
    kind,
    parentId: stringValue(input.parentId, 128, { optional: true }),
    model: stringValue(input.model, 128) as string,
    availableModels: stringArray(input.availableModels, 100, 128),
    provider,
    reasoningEffort,
    status: statusValue(input.status),
    percent: numberValue(input.percent, 0, 100),
    headline: stringValue(input.headline, 512, { allowEmpty: true, redact: true }) as string,
    summary: stringValue(input.summary, 4096, { allowEmpty: true, redact: true }) as string,
    lastInstruction: stringValue(input.lastInstruction, 64 * 1024, { optional: true, allowEmpty: true, redact: true }),
    lastActions: stringArray(input.lastActions, 100, MAX_AGENT_LOG_CHARS).map(action => action.slice(0, 512)),
    outputMode,
    queueLength: numberValue(input.queueLength, 0, 100_000),
    queue,
    condensedLog: stringValue(input.condensedLog, 32 * 1024, { allowEmpty: true, redact: true }) as string,
    fullLog: stringValue(input.fullLog, MAX_AGENT_LOG_CHARS, { allowEmpty: true, redact: true }) as string,
    claude,
    updatedAt: numberValue(input.updatedAt, 0, Number.MAX_SAFE_INTEGER),
    runId: stringValue(input.runId, 128, { optional: true }),
    cwd: stringValue(input.cwd, 4096, { optional: true }),
    runStartedAt: optionalNumber(input.runStartedAt, 0, Number.MAX_SAFE_INTEGER),
    toolCount: optionalNumber(input.toolCount, 0, 1_000_000),
    lastEventAt: optionalNumber(input.lastEventAt, 0, Number.MAX_SAFE_INTEGER),
    subagents,
  };
}

function agentArray(value: unknown): AgentSnapshot[] {
  if (!Array.isArray(value) || value.length > MAX_AGENT_COUNT) {
    throw new InvalidWorkerMessage();
  }
  const agents = value.map(agentValue);
  if (new Set(agents.map((agent) => agent.id)).size !== agents.length) {
    throw new InvalidWorkerMessage();
  }
  return agents;
}

function healthValue(value: unknown): HealthReport {
  const input = record(value);
  const keepAwake = record(input.keepAwake);
  const cursorSdk = record(input.cursorSdk);
  const claude = record(input.claude);
  const host = record(input.host);
  if (!Array.isArray(input.agents) || input.agents.length > MAX_AGENT_COUNT) {
    throw new InvalidWorkerMessage();
  }
  let codex: HealthReport["codex"];
  if (input.codex !== undefined) {
    const value = record(input.codex);
    codex = {
      ready: booleanValue(value.ready),
      detail: stringValue(value.detail, 2048, { allowEmpty: true, redact: true }) as string,
    };
  }
  return {
    ok: booleanValue(input.ok),
    workerConnected: booleanValue(input.workerConnected),
    lastHeartbeatAt:
      input.lastHeartbeatAt === null
        ? null
        : numberValue(input.lastHeartbeatAt, 0, Number.MAX_SAFE_INTEGER),
    keepAwake: {
      caffeinate: booleanValue(keepAwake.caffeinate),
      preventingSleep: booleanValue(keepAwake.preventingSleep),
      detail: stringValue(keepAwake.detail, 2048, { allowEmpty: true, redact: true }) as string,
    },
    cursorSdk: {
      ready: booleanValue(cursorSdk.ready),
      apiKeyPresent: booleanValue(cursorSdk.apiKeyPresent),
      detail: stringValue(cursorSdk.detail, 2048, { allowEmpty: true, redact: true }) as string,
    },
    codex,
    claude: {
      available: booleanValue(claude.available),
      detail: stringValue(claude.detail, 2048, { allowEmpty: true, redact: true }) as string,
    },
    agents: input.agents.map((entry) => {
      const item = record(entry);
      return {
        id: stringValue(item.id, 128) as string,
        present: booleanValue(item.present),
        status: statusValue(item.status),
      };
    }),
    issues: stringArray(input.issues, 100, 2048),
    host: {
      hostname: stringValue(host.hostname, 255, { redact: true }) as string,
      platform: stringValue(host.platform, 64) as string,
      uptimeSec: numberValue(host.uptimeSec, 0, Number.MAX_SAFE_INTEGER),
    },
  };
}

function fileInfoValue(value: unknown): WorkspaceFileInfo {
  const input = record(value);
  return {
    path: stringValue(input.path, 4096) as string,
    bytes: numberValue(input.bytes, 0, Number.MAX_SAFE_INTEGER),
    mtime: numberValue(input.mtime, 0, Number.MAX_SAFE_INTEGER),
  };
}

function fileContentValue(value: unknown): WorkspaceFileContent {
  const input = record(value);
  return {
    ...fileInfoValue(input),
    content: stringValue(input.content, MAX_FILE_CONTENT_CHARS, { allowEmpty: true }) as string,
  };
}

export function parseWorkerMessage(
  raw: string,
  knownSecrets: readonly string[] = []
): WorkerToServer {
  if (Buffer.byteLength(raw) > MAX_WS_MESSAGE_BYTES) throw new InvalidWorkerMessage();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidWorkerMessage();
  }
  const input = record(parsed);
  const type = stringValue(input.type, 32);
  if (type === "hello") {
    return redactKnownSecrets({
      type,
      workerId: stringValue(input.workerId, 128) as string,
      health: healthValue(input.health),
      agents: agentArray(input.agents),
    }, knownSecrets);
  }
  if (type === "heartbeat") {
    return redactKnownSecrets(
      { type, health: healthValue(input.health), agents: agentArray(input.agents) },
      knownSecrets
    );
  }
  if (type === "agent_update") {
    return redactKnownSecrets({ type, agent: agentValue(input.agent) }, knownSecrets);
  }
  if (type === "ack") {
    let files: WorkspaceFileInfo[] | undefined;
    if (input.files !== undefined) {
      if (!Array.isArray(input.files) || input.files.length > 2_000) {
        throw new InvalidWorkerMessage();
      }
      files = input.files.map(fileInfoValue);
    }
    return redactKnownSecrets({
      type,
      commandId: stringValue(input.commandId, 128) as string,
      ok: booleanValue(input.ok),
      error: stringValue(input.error, 2048, { optional: true, redact: true }),
      files,
      file: input.file === undefined ? undefined : fileContentValue(input.file),
    }, knownSecrets);
  }
  throw new InvalidWorkerMessage();
}
