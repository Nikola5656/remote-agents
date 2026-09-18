import type {
  AgentSnapshot,
  DeliveryMode,
  HealthReport,
  ModelOption,
  OutputMode,
  WorkspaceFileContent,
  WorkspaceFileInfo,
} from "@remote-agents/shared";
import { MODEL_CATALOG } from "@remote-agents/shared";

export class AuthError extends Error {
  constructor(message = "Not authenticated") {
    super(message);
    this.name = "AuthError";
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function readError(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return res.statusText || `Request failed (${res.status})`;
  try {
    const json = JSON.parse(text) as { error?: string; message?: string; code?: string; commandId?: unknown };
    if (json.code === "ACK_TIMEOUT" || json.code === "ACK_UNKNOWN") {
      const id = typeof json.commandId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(json.commandId)
        ? ` Command ID: ${json.commandId}.` : "";
      return "Acknowledgement unavailable. The instruction may already be queued or running. Check the agent before retrying." + id;
    }
    return json.error || json.message || text;
  } catch {
    return text;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers,
  });
  if (res.status === 401) {
    throw new AuthError();
  }
  if (!res.ok) {
    throw new ApiError(res.status, await readError(res));
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

function unwrapList<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const value = (data as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch("/api/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new ApiError(res.status, await readError(res));
  }
}

export async function logout(): Promise<void> {
  try {
    await api("/api/logout", { method: "POST" });
  } catch (err) {
    if (err instanceof AuthError) return;
    throw err;
  }
}

export async function fetchMe(): Promise<{ username: string } | null> {
  try {
    const data = await api<unknown>("/api/me");
    if (data && typeof data === "object") {
      const rec = data as Record<string, unknown>;
      const user = rec.user;
      if (typeof rec.username === "string") return { username: rec.username };
      if (user && typeof user === "object" && typeof (user as { username?: string }).username === "string") {
        return { username: (user as { username: string }).username };
      }
      if (typeof rec.name === "string") return { username: rec.name };
    }
    return { username: "user" };
  } catch (err) {
    if (err instanceof AuthError) return null;
    throw err;
  }
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthReport> {
  return api<HealthReport>("/api/health", { signal });
}

export async function fetchAgents(signal?: AbortSignal): Promise<AgentSnapshot[]> {
  const data = await api<unknown>("/api/agents", { signal });
  return unwrapList<AgentSnapshot>(data, "agents");
}

export async function fetchAgent(id: string): Promise<AgentSnapshot> {
  return api<AgentSnapshot>(`/api/agents/${encodeURIComponent(id)}`);
}

export async function sendAgentMessage(
  id: string,
  text: string,
  mode: DeliveryMode
): Promise<AgentSnapshot | void> {
  return api(`/api/agents/${encodeURIComponent(id)}/message`, {
    method: "POST",
    body: JSON.stringify({ text, mode }),
  });
}

export async function setAgentModel(
  id: string,
  model: string
): Promise<AgentSnapshot | void> {
  return api(`/api/agents/${encodeURIComponent(id)}/model`, {
    method: "POST",
    body: JSON.stringify({ model }),
  });
}

export async function stopAgent(id: string, runId: string): Promise<void> {
  await api(`/api/agents/${encodeURIComponent(id)}/stop`, {
    method: "POST",
    body: JSON.stringify({ runId }),
  });
}

export async function removeQueuedInstruction(id: string, instructionId: string): Promise<void> {
  await api(`/api/agents/${encodeURIComponent(id)}/queue/${encodeURIComponent(instructionId)}`, {
    method: "DELETE",
  });
}

export async function setAgentOutputMode(
  id: string,
  outputMode: OutputMode
): Promise<AgentSnapshot | void> {
  return api(`/api/agents/${encodeURIComponent(id)}/output-mode`, {
    method: "POST",
    body: JSON.stringify({ outputMode }),
  });
}

export async function setAgentCwd(
  id: string,
  cwd: string
): Promise<AgentSnapshot | void> {
  return api(`/api/agents/${encodeURIComponent(id)}/cwd`, {
    method: "POST",
    body: JSON.stringify({ cwd }),
  });
}

export async function spawnAgent(input: {
  name: string;
  model: string;
  cwd?: string;
}): Promise<AgentSnapshot | void> {
  return api("/api/agents", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function sendClaudeMessage(
  id: string,
  text: string,
  mode: DeliveryMode
): Promise<AgentSnapshot | void> {
  return api(`/api/agents/${encodeURIComponent(id)}/claude`, {
    method: "POST",
    body: JSON.stringify({ text, mode }),
  });
}

export async function stopClaude(
  id: string,
  mode: DeliveryMode
): Promise<AgentSnapshot | void> {
  return api(`/api/agents/${encodeURIComponent(id)}/claude/stop`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

export async function fetchModels(): Promise<ModelOption[]> {
  try {
    const data = await api<unknown>("/api/models");
    const list = unwrapList<ModelOption>(data, "models");
    if (list.length > 0) return list;
  } catch (err) {
    if (err instanceof AuthError) throw err;
  }
  return MODEL_CATALOG;
}

export async function fetchAgentFiles(id: string, signal?: AbortSignal): Promise<WorkspaceFileInfo[]> {
  const data = await api<{ files?: WorkspaceFileInfo[] }>(
    `/api/agents/${encodeURIComponent(id)}/files`, { signal }
  );
  return Array.isArray(data.files) ? data.files : [];
}

export async function fetchAgentFile(
  id: string,
  path: string,
  signal?: AbortSignal
): Promise<WorkspaceFileContent> {
  const qs = new URLSearchParams({ path });
  return api<WorkspaceFileContent>(
    `/api/agents/${encodeURIComponent(id)}/file?${qs.toString()}`, { signal }
  );
}

export async function requestAgentMarkdown(
  id: string,
  input: { path: string; instruct?: string; mode: DeliveryMode }
): Promise<void> {
  await api(`/api/agents/${encodeURIComponent(id)}/markdown`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/ui?protocol=2`;
}
