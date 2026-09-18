import { MODEL_CATALOG } from "@remote-agents/shared";
import { CloudAgentsApi, CloudApiError } from "./cloud-api";
import { CloudEventMapper, mapRunStatus } from "./cloud-events";
import { log, logError } from "./log";
import type { MachineWorkers } from "./machine-workers";
import type {
  CursorAgentHandle,
  CursorRunHandle,
  CursorRunResult,
  CursorRuntime,
  SendOptions,
} from "./runtime";

/**
 * Runs agents as Cursor Cloud Agents pinned to this Mac (My Machines).
 * Execution is local (tool calls run here via `cursor agent worker`), but the
 * conversation syncs through Cursor's backend — so each agent appears in the
 * IDE sidebar as a normal agent and updates live, with no SQLite mirroring.
 */
export class MachineCursorRuntime implements CursorRuntime {
  readonly kind = "machine" as const;
  readonly transcript = null;
  /** Cloud agent ids already bound to a slot (prevents double adoption). */
  private readonly knownIds = new Set<string>();

  constructor(
    private readonly api: CloudAgentsApi,
    private readonly workers: MachineWorkers
  ) {}

  isResumableId(id: string): boolean {
    return id.startsWith("bc-");
  }

  async create(input: {
    slotId: string;
    name?: string;
    model: string;
    cwd: string;
  }): Promise<CursorAgentHandle> {
    // Spawn the local worker right away so this machine shows up in the
    // cursor.com/agents environment picker even before the first message.
    this.workers.ensure(input.slotId, input.cwd);
    // The cloud API requires a prompt to create an agent, so the real agent
    // is created (or adopted) lazily on the first send.
    return new MachineAgentHandle(this.api, this.workers, this.knownIds, {
      slotId: input.slotId,
      name: input.name || input.slotId,
      cwd: input.cwd,
      agentId: "",
    });
  }

  async resume(
    agentId: string,
    input: { model: string; cwd: string; name?: string; slotId?: string }
  ): Promise<CursorAgentHandle> {
    if (!this.isResumableId(agentId)) {
      throw new Error(`not a cloud agent id: ${agentId}`);
    }
    // Verify the agent still exists; a deleted agent falls back to create().
    const agent = await this.api.getAgent(agentId);
    if ((agent.status || "").toUpperCase() === "ARCHIVED") {
      await this.api.unarchive(agentId);
      log("unarchived machine agent", agentId);
    }
    const slotId = input.slotId || input.name || agentId;
    this.workers.ensure(slotId, input.cwd);
    this.knownIds.add(agentId);
    log("resumed machine agent", agentId, slotId);
    return new MachineAgentHandle(this.api, this.workers, this.knownIds, {
      slotId,
      name: input.name || agentId,
      cwd: input.cwd,
      agentId,
    });
  }

  async listModels(): Promise<string[]> {
    try {
      const ids = await this.api.listModels();
      if (ids.length) return ids;
    } catch (err) {
      logError("cloud listModels failed", err);
    }
    return MODEL_CATALOG.map((m) => m.id);
  }
}

class MachineAgentHandle implements CursorAgentHandle {
  private realAgentId: string;
  private readonly slotId: string;
  private readonly name: string;
  private cwd: string;
  private lastRunId: string | null = null;

  constructor(
    private readonly api: CloudAgentsApi,
    private readonly workers: MachineWorkers,
    private readonly knownIds: Set<string>,
    input: { slotId: string; name: string; cwd: string; agentId: string }
  ) {
    this.slotId = input.slotId;
    this.name = input.name;
    this.cwd = input.cwd;
    this.realAgentId = input.agentId;
  }

  get agentId(): string {
    return this.realAgentId;
  }

  async send(text: string, options: SendOptions): Promise<CursorRunHandle> {
    // Slot ids like "agent-1" map to machine names like "remote-agent-1";
    // ensure the local worker for this slot is up before dispatching.
    const machineName = this.workers.ensure(this.slotId, this.cwd);
    const ref = await this.startRun(text, options, machineName);
    this.realAgentId = ref.agentId;
    this.knownIds.add(ref.agentId);
    this.lastRunId = ref.runId;
    return new MachineRun(this.api, ref.agentId, ref.runId);
  }

  private async startRun(
    text: string,
    options: SendOptions,
    machineName: string
  ): Promise<{ agentId: string; runId: string }> {
    if (!this.realAgentId) {
      // Prefer adopting an agent already bound to this machine (created once
      // from cursor.com/agents, where repo-less machine agents are allowed).
      const adopted = await this.adoptExisting(machineName);
      if (adopted) {
        this.realAgentId = adopted;
        return this.followUp(text, options, machineName);
      }
      try {
        return await this.api.createAgent({
          promptText: text,
          name: this.name,
          model: options.model,
          machineName,
        });
      } catch (err) {
        if (err instanceof CloudApiError && /repo-less|workspace binding/i.test(err.message)) {
          throw new Error(
            `One-time setup needed for ${this.name}: open cursor.com/agents, pick environment "${machineName}" and send any message. The next instruction here will adopt that chat automatically.`
          );
        }
        throw err;
      }
    }
    return this.followUp(text, options, machineName);
  }

  /** Newest non-archived cloud agent bound to this machine name. */
  private async adoptExisting(machineName: string): Promise<string | null> {
    try {
      const items = await this.api.listAgents(50);
      for (const item of items) {
        if (this.knownIds.has(item.id)) continue;
        if ((item.status || "").toUpperCase() === "ARCHIVED") continue;
        if (item.env?.type !== "machine") continue;
        if (item.env?.name && item.env.name !== machineName) continue;
        log("adopted machine agent", this.slotId, machineName, item.id, item.name || "");
        return item.id;
      }
    } catch (err) {
      logError("adopt scan failed", machineName, err);
    }
    return null;
  }

  private async followUp(
    text: string,
    options: SendOptions,
    machineName: string
  ): Promise<{ agentId: string; runId: string }> {
    try {
      return await this.api.createRun(this.realAgentId, text);
    } catch (err) {
      if (err instanceof CloudApiError && err.code === "agent_busy") {
        // Terminal-state mismatch or force-send: cancel the active run and retry.
        await this.cancelActiveRun();
        return this.api.createRun(this.realAgentId, text);
      }
      if (err instanceof CloudApiError && err.httpStatus === 404) {
        // Agent was deleted server-side — forget it and adopt/create fresh.
        log("cloud agent gone, starting over", this.slotId, this.realAgentId);
        this.realAgentId = "";
        return this.startRun(text, options, machineName);
      }
      throw err;
    }
  }

  private async cancelActiveRun(): Promise<void> {
    try {
      const agent = await this.api.getAgent(this.realAgentId);
      const runId = agent.latestRunId || this.lastRunId;
      if (runId) await this.api.cancelRun(this.realAgentId, runId);
      // Give the backend a moment to settle the cancellation.
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      logError("cancel active cloud run failed", this.slotId, err);
    }
  }

  async dispose(): Promise<void> {
    // Keep the cloud agent (it is the visible sidebar conversation).
  }
}

class MachineRun implements CursorRunHandle {
  readonly id: string;
  private readonly events: unknown[] = [];
  private readonly waiters: Array<() => void> = [];
  private done = false;
  private result: CursorRunResult = { status: "running" };
  private readonly finished: Promise<CursorRunResult>;
  private readonly abort = new AbortController();

  constructor(
    private readonly api: CloudAgentsApi,
    private readonly agentId: string,
    runId: string
  ) {
    this.id = runId;
    this.finished = this.pump().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error" as const, error: { message } };
    });
  }

  supports(op: string): boolean {
    return op === "cancel" || op === "wait" || op === "stream";
  }

  async *stream(): AsyncIterable<unknown> {
    let index = 0;
    while (true) {
      if (index < this.events.length) {
        yield this.events[index++];
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  wait(): Promise<CursorRunResult> {
    return this.finished;
  }

  async cancel(): Promise<void> {
    this.result = { status: "cancelled", result: "cancelled" };
    this.abort.abort();
    try {
      await this.api.cancelRun(this.agentId, this.id);
    } catch (err) {
      logError("cloud cancel failed", this.agentId, this.id, err);
    }
    await this.finished.catch(() => undefined);
  }

  private push(event: unknown): void {
    this.events.push(event);
    const waiter = this.waiters.shift();
    if (waiter) waiter();
  }

  private finishStream(): void {
    this.done = true;
    for (const waiter of this.waiters) waiter();
    this.waiters.length = 0;
  }

  private async pump(): Promise<CursorRunResult> {
    const mapper = new CloudEventMapper();
    try {
      for await (const sse of this.api.streamRun(this.agentId, this.id, this.abort.signal)) {
        for (const event of mapper.push(sse.event, sse.data)) this.push(event);
        if (mapper.result) break;
      }
      for (const event of mapper.finish()) this.push(event);
    } catch (err) {
      if (!this.abort.signal.aborted) {
        logError("cloud stream failed", this.agentId, this.id, err);
      }
    }

    if (this.result.status === "cancelled") {
      this.finishStream();
      return this.result;
    }

    if (mapper.result) {
      this.result = {
        status: mapRunStatus(mapper.result.status),
        result: mapper.result.text,
        error:
          mapRunStatus(mapper.result.status) === "error"
            ? { message: mapper.error || mapper.result.text || "run failed" }
            : undefined,
      };
      this.finishStream();
      return this.result;
    }

    // Stream ended without a terminal event — poll the run for its state.
    const polled = await this.pollTerminal();
    this.result = polled;
    this.finishStream();
    return this.result;
  }

  private async pollTerminal(): Promise<CursorRunResult> {
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline && !this.abort.signal.aborted) {
      try {
        const run = await this.api.getRun(this.agentId, this.id);
        const s = run.status.toUpperCase();
        if (s === "FINISHED" || s === "ERROR" || s === "CANCELLED" || s === "EXPIRED") {
          const status = mapRunStatus(s);
          return {
            status,
            result: run.result,
            error: status === "error" ? { message: run.result || `run ${s}` } : undefined,
          };
        }
      } catch (err) {
        logError("cloud run poll failed", this.agentId, this.id, err);
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (this.result.status === "cancelled") return this.result;
    return { status: "error", error: { message: "run did not reach a terminal state" } };
  }
}
