/**
 * Minimal Cursor Cloud Agents API client (api.cursor.com/v1).
 * Used by the "machine" runtime: agents execute on this Mac via a local
 * `cursor agent worker` (My Machines) while conversations sync through
 * Cursor's backend — which makes them visible and live in the IDE sidebar.
 */

const BASE_URL = "https://api.cursor.com";
const JSON_TIMEOUT_MS = 30_000;

export class CloudApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number
  ) {
    super(message);
  }
}

/** True when the account-level privacy/storage setting blocks cloud agents. */
export function isPrivacyModeError(err: unknown): boolean {
  if (!(err instanceof CloudApiError)) return false;
  if (err.code === "feature_unavailable") return true;
  return /privacy mode|storage mode/i.test(err.message);
}

export interface CloudRunRef {
  agentId: string;
  runId: string;
}

export interface CloudRunState {
  status: string;
  result?: string;
}

export interface CloudAgentListItem {
  id: string;
  name?: string;
  status?: string;
  createdAt?: string;
  env?: { type?: string; name?: string };
}

export interface SseEvent {
  event: string;
  data: unknown;
  id?: string;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON body
  }
  if (!res.ok) {
    const error = (body.error || {}) as { code?: string; message?: string };
    throw new CloudApiError(
      error.message || `HTTP ${res.status}: ${text.slice(0, 200)}`,
      error.code || `http_${res.status}`,
      res.status
    );
  }
  return body;
}

/** Incremental parser for a text/event-stream body. */
export class SseParser {
  private buf = "";

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const events: SseEvent[] = [];
    let sep: number;
    // Events are separated by a blank line.
    while ((sep = this.buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = this.buf.slice(0, sep);
      this.buf = this.buf.slice(sep).replace(/^\r?\n\r?\n/, "");
      const parsed = parseSseBlock(block);
      if (parsed) events.push(parsed);
    }
    return events;
  }
}

function parseSseBlock(block: string): SseEvent | null {
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    else if (line.startsWith("id:")) id = line.slice(3).trim();
  }
  if (!dataLines.length && event === "message") return null;
  let data: unknown = {};
  const raw = dataLines.join("\n");
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { text: raw };
    }
  }
  return { event, data, id };
}

export class CloudAgentsApi {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = BASE_URL
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  /** Cheap probe: does the account allow cloud agents at all? */
  async probe(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/agents?limit=1`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      });
      await readJson(res);
      return { ok: true };
    } catch (err) {
      if (err instanceof CloudApiError) {
        return { ok: false, reason: err.message };
      }
      // Network trouble is not a policy failure; let the runtime start.
      return { ok: true };
    }
  }

  async createAgent(input: {
    promptText: string;
    name: string;
    model: string;
    machineName: string;
  }): Promise<CloudRunRef> {
    const res = await fetch(`${this.baseUrl}/v1/agents`, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      body: JSON.stringify({
        prompt: { text: input.promptText },
        name: input.name,
        model: { id: input.model },
        env: { type: "machine", name: input.machineName },
      }),
    });
    const body = await readJson(res);
    const agent = (body.agent || {}) as { id?: string; latestRunId?: string };
    const run = (body.run || {}) as { id?: string };
    const agentId = agent.id;
    const runId = run.id || agent.latestRunId;
    if (!agentId || !runId) {
      throw new CloudApiError("create agent returned no ids", "bad_response", 200);
    }
    return { agentId, runId };
  }

  async createRun(agentId: string, promptText: string): Promise<CloudRunRef> {
    const res = await fetch(`${this.baseUrl}/v1/agents/${agentId}/runs`, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      body: JSON.stringify({ prompt: { text: promptText } }),
    });
    const body = await readJson(res);
    const run = (body.run || {}) as { id?: string };
    if (!run.id) {
      throw new CloudApiError("create run returned no id", "bad_response", 200);
    }
    return { agentId, runId: run.id };
  }

  async getAgent(agentId: string): Promise<{ id: string; latestRunId?: string; status?: string }> {
    const res = await fetch(`${this.baseUrl}/v1/agents/${agentId}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
    const body = await readJson(res);
    return body as { id: string; latestRunId?: string; status?: string };
  }

  async listAgents(limit = 50): Promise<CloudAgentListItem[]> {
    const res = await fetch(`${this.baseUrl}/v1/agents?limit=${limit}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
    const body = await readJson(res);
    return ((body.items || []) as CloudAgentListItem[]).filter((a) => Boolean(a.id));
  }

  async unarchive(agentId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/agents/${agentId}/unarchive`, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
    await readJson(res);
  }

  async getRun(agentId: string, runId: string): Promise<CloudRunState> {
    const res = await fetch(`${this.baseUrl}/v1/agents/${agentId}/runs/${runId}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
    const body = await readJson(res);
    return { status: String(body.status || ""), result: body.result as string | undefined };
  }

  async cancelRun(agentId: string, runId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/agents/${agentId}/runs/${runId}/cancel`, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
    // 409 run_not_cancellable is fine — the run already ended.
    if (!res.ok && res.status !== 409) await readJson(res);
    else await res.text();
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
    const body = await readJson(res);
    const models = (body.models || []) as Array<string | { id?: string }>;
    return models
      .map((m) => (typeof m === "string" ? m : m.id))
      .filter((id): id is string => Boolean(id));
  }

  /**
   * Stream SSE events for one run. Yields raw SseEvents; the caller decides
   * how to map them. Reconnects with Last-Event-ID until a terminal event or
   * `signal` aborts. Throws CloudApiError on unrecoverable HTTP errors.
   */
  async *streamRun(
    agentId: string,
    runId: string,
    signal: AbortSignal
  ): AsyncGenerator<SseEvent> {
    let lastEventId: string | undefined;
    let attempts = 0;
    while (!signal.aborted) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/v1/agents/${agentId}/runs/${runId}/stream`, {
          headers: this.headers({
            Accept: "text/event-stream",
            ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
          }),
          signal,
        });
      } catch (err) {
        if (signal.aborted) return;
        if (++attempts > 6) throw err;
        await sleep(Math.min(1000 * 2 ** attempts, 15_000), signal);
        continue;
      }
      if (res.status === 410) return; // stream expired — caller polls getRun
      if (!res.ok) {
        await readJson(res); // throws CloudApiError
        return;
      }
      attempts = 0;
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      const parser = new SseParser();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            if (event.id) lastEventId = event.id;
            yield event;
            if (event.event === "done") return;
          }
        }
      } catch {
        // dropped connection — reconnect below
      } finally {
        reader.releaseLock();
      }
      if (signal.aborted) return;
      if (++attempts > 6) return;
      await sleep(Math.min(1000 * 2 ** attempts, 15_000), signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done);
  });
}
