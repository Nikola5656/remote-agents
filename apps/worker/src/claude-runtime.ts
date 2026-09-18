import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CLAUDE_MODELS } from "@remote-agents/shared";
import { ClaudeProcess, claudeModelId, resolveClaudeBin, type ClaudeProcessOptions, type ClaudeProcessInput, type ClaudeEvent } from "./claude";
import type { CursorAgentHandle, CursorRunHandle, CursorRunResult, CursorRuntime } from "./runtime";

const SESSION = /^claude:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Slot = { cwd: string; model: string; slotId?: string; name?: string; apiKey?: string };

/** Native Claude Code sessions. Pool/slot scheduling remains owned by AgentSlot. */
export class ClaudeRuntime implements CursorRuntime {
  readonly kind = "claude" as const;
  constructor(private readonly bin = process.env.CLAUDE_BIN || "claude", private readonly options: ClaudeProcessOptions = {}) {}
  health(): { ready: boolean; detail: string } {
    const resolved = resolveClaudeBin(this.bin, { env: this.options.env });
    if (!resolved.available) return { ready: false, detail: resolved.detail };
    const checked = spawnSync(resolved.path, [...resolved.args, "auth", "status", "--json"], {
      shell: false, windowsHide: true, timeout: 8000, maxBuffer: 128 * 1024,
      encoding: "utf8", env: this.options.env ?? process.env,
    });
    let loggedIn = false;
    try { loggedIn = JSON.parse(checked.stdout || "{}").loggedIn === true; } catch { /* unavailable */ }
    const ready = checked.status === 0 && !checked.error && loggedIn;
    return { ready: Boolean(ready), detail: ready ? "Claude Code signed in" : "Claude Code unavailable or not signed in; check CLI authentication locally" };
  }
  isResumableId(id: string) { return SESSION.test(id); }
  async listModels(): Promise<string[]> {
    return CLAUDE_MODELS.map(({ id }) => id);
  }
  async create(input: Slot): Promise<CursorAgentHandle> { return this.agent(`claude:${randomUUID()}`, input, false); }
  async resume(id: string, input: Slot): Promise<CursorAgentHandle> {
    if (!this.isResumableId(id)) throw new Error("Invalid Claude Code conversation ID");
    return this.agent(id, input, true);
  }
  private agent(agentId: string, input: Slot, resume: boolean): CursorAgentHandle {
    let active: ClaudeConversationRun | undefined;
    let disposed = false;
    let submitting = false;
    return {
      agentId,
      send: async (text, options) => {
        claudeModelId(options.model);
        if (disposed) throw new Error("Claude Code agent disposed");
        if (submitting) throw new Error("Claude Code send already in progress");
        submitting = true;
        try {
          if (active) {
            await active.cancel();
            resume ||= active.sessionObserved;
          }
          if (disposed) throw new Error("Claude Code agent disposed");
          active = new ClaudeConversationRun({ bin: this.bin, cwd: input.cwd, text, model: options.model, sessionId: agentId.slice(7), resume }, this.options);
          return active;
        } finally { submitting = false; }
      },
      async dispose() { disposed = true; await active?.cancel(); },
    };
  }
}


/** One logical turn, with at most one proven pre-submission materialization. */
class ClaudeConversationRun implements CursorRunHandle {
  readonly id = randomUUID();
  private current: ClaudeProcess;
  private events: ClaudeEvent[] = [];
  private wake?: () => void;
  private done = false;
  private cancelled = false;
  private cancellationError?: unknown;
  private resolve!: (result: CursorRunResult) => void;
  private readonly finished = new Promise<CursorRunResult>((resolve) => { this.resolve = resolve; });
  constructor(private readonly input: ClaudeProcessInput, private readonly options: ClaudeProcessOptions) {
    this.current = new ClaudeProcess(input, options);
    void this.pump();
  }
  get sessionObserved() { return this.current.sessionObserved; }
  supports(op: string) { return ["wait", "stream", "cancel"].includes(op); }
  private push(event: ClaudeEvent) { this.events.push(event); this.wake?.(); }
  private async pump() {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        for await (const event of this.current.stream()) {
          // Hold terminal events until retry eligibility is resolved. Never show
          // a false failed turn followed by success for a single user command.
          if (event.type !== "result") this.push(event);
        }
        const result = await this.current.wait();
        if (attempt === 0 && this.input.resume && !this.cancelled && this.current.missingSessionBeforeSubmission) {
          this.current = new ClaudeProcess({ ...this.input, resume: false }, this.options);
          continue;
        }
        this.finish(this.cancelled && result.status !== "error" ? { status: "cancelled" } : result);
        return;
      }
    } catch {
      try { await this.current.cancel(); } catch { /* retain error, never success */ }
      this.finish({ status: "error", error: { message: "Claude Code conversation stream failed" } });
    }
  }
  private finish(result: CursorRunResult) {
    if (this.done) return;
    this.done = true;
    this.push({ type: "result", subtype: result.status === "finished" ? "success" : result.status, is_error: result.status === "error", result: result.result, error: result.error });
    this.resolve(result);
  }
  wait() { return this.finished; }
  async cancel() {
    if (this.cancellationError) throw this.cancellationError;
    if (!this.done) {
      this.cancelled = true;
      try { await this.current.cancel(); }
      catch (error) { this.cancellationError = error; throw error; }
    }
    await this.finished;
  }
  async *stream(): AsyncIterable<unknown> {
    while (true) {
      while (this.events.length) yield this.events.shift();
      if (this.done) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}
