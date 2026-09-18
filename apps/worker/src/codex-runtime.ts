import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { CODEX_MODELS } from "@remote-agents/shared";
import type { CursorAgentHandle, CursorRunHandle, CursorRunResult, CursorRuntime } from "./runtime";
import { CodexConnection, CodexDesktopConnection, wakeCodexDesktop } from "./codex-connection";

export function resolveCodexBin(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  for (const bin of ["/Applications/Codex.app/Contents/Resources/codex", "/Applications/ChatGPT.app/Contents/Resources/codex"]) {
    if (fs.existsSync(bin)) return bin;
  }
  return "codex";
}

type WriterRecovery = { timeoutMs?: number; wakeDesktop?: (threadId: string) => Promise<void> };

type Slot = { cwd: string; name?: string; model?: string };
// Remote agents are explicitly authorized to work across projects on the worker host.
const fullAccess = { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } as const;
/** Native Codex conversations with stable names and preserved history. */
export class CodexRuntime implements CursorRuntime {
  readonly kind = "codex" as const;
  constructor(private readonly bin = resolveCodexBin(), private readonly desktopEnabled = true, private readonly desktopSocketPath?: string, private readonly recovery: WriterRecovery = {}) {}
  health(): { ready: boolean; detail: string } {
    const result = spawnSync(this.bin, ["login", "status"], { encoding: "utf8", timeout: 8000 });
    return { ready: result.status === 0, detail: result.status === 0
      ? "Codex signed in · Astra and Sol · Medium reasoning"
      : "Codex unavailable. Run codex login on the worker host." };
  }
  isResumableId(id: string): boolean { return /^codex:[0-9a-f-]{36}$/.test(id); }
  async listModels(): Promise<string[]> { return CODEX_MODELS.map((m) => m.id); }
  async create(input: Slot): Promise<CursorAgentHandle> { return this.prepare(input); }
  async resume(id: string, input: Slot): Promise<CursorAgentHandle> {
    if (!this.isResumableId(id)) throw new Error("Invalid Codex conversation");
    return this.prepare(input, id.slice(6));
  }
  private async prepare(input: Slot, existingId?: string): Promise<CursorAgentHandle> {
    const connection = new CodexConnection(this.bin, input.cwd);
    let threadId = existingId;
    try {
      await connection.initialize();
      const config = { cwd: input.cwd, model: input.model, sandbox: "danger-full-access", approvalPolicy: "never",
        config: { model_reasoning_effort: "medium" }, threadSource: "user" };
      if (!threadId) threadId = (await connection.rpc("thread/start", config)).thread.id;
      else {
        const { thread } = await connection.rpc("thread/read", { threadId, includeTurns: false });
        // exec threads are deliberately excluded from Codex's sidebar. Fork once
        // through the native API to preserve their transcript with an interactive source.
        if (thread.source === "exec") threadId = (await connection.rpc("thread/fork", { ...config, threadId, excludeTurns: true })).thread.id;
      }
      await connection.rpc("thread/name/set", { threadId, name: `${input.name || "Codex"} · Remote Agents` });
      const sections = await connection.rpc("threadSection/list", {});
      const section = sections.data.find((s: any) => s.name === "Remote Agents");
      if (section) await connection.rpc("thread/section/move", { threadId, sectionId: section.id });
    } finally { await connection.close(); }
    if (!threadId) throw new Error("Codex did not return a conversation ID");
    const id = threadId;
    let active: CodexRun | undefined;
    return {
      agentId: `codex:${id}`,
      send: async (text, options) => {
        if (!CODEX_MODELS.some((m) => m.id === options.model)) throw new Error(`Unsupported Codex model: ${options.model}`);
        if (active) await active.cancel();
        const run = new CodexRun(this.bin, input.cwd, id, this.desktopEnabled, this.desktopSocketPath, this.recovery);
        active = run;
        try { await run.start(text, options.model); } catch (e) { run.fail(e); await run.cancel(); throw e; }
        return run;
      },
      async dispose() { await active?.cancel(); },
    };
  }
}

export class CodexRun implements CursorRunHandle {
  readonly id = randomUUID();
  private events: unknown[] = [];
  private wake?: () => void;
  private done = false;
  private interrupting = false;
  private cancelling?: Promise<void>;
  private finalText = "";
  private turnId?: string;
  private readonly connection: CodexConnection;
  private desktop?: CodexDesktopConnection;
  private desktopAvailable = false;
  private cleanup?: Promise<void>;
  private pollTimer?: NodeJS.Timeout;
  private rolloutPath?: string;
  private rolloutOffset = 0;
  private rolloutBuffer = "";
  private rolloutDecoder = new StringDecoder("utf8");
  private startedTools = new Set<string>();
  private resolve!: (result: CursorRunResult) => void;
  private readonly finished = new Promise<CursorRunResult>((resolve) => { this.resolve = resolve; });
  private seen = new Set<string>();
  constructor(bin: string, private readonly cwd: string, private readonly threadId: string, private readonly desktopEnabled = true, private readonly desktopSocketPath?: string, private readonly recovery: WriterRecovery = {}) {
    this.connection = new CodexConnection(bin, cwd);
    this.connection.onClose = () => { if (!this.done) this.fail(new Error("Codex app server disconnected before completion")); };
    this.connection.onNotification = (method, p) => {
      if (p?.threadId !== this.threadId) return;
      if (method === "item/completed") this.item(p.item);
      if (method === "item/started" && p.item?.type !== "agentMessage") this.item(p.item);
      if (method === "turn/completed") this.completeTurn(p.turn);
    };
  }
  async start(text: string, model: string) {
    await this.connection.initialize();
    // Opening a conversation in Codex gives the desktop the writer lock. Send
    // through its owner instead of creating a second writer or a duplicate task.
    const deadline = Date.now() + (this.recovery.timeoutMs ?? 45000);
    let wokeDesktop = false;
    let attempts = 0;
    while (!this.done) {
      await this.findDesktopOwner();
      if (this.done) return;
      if (this.desktop) break;
      try {
        await this.connection.rpc("thread/resume", { threadId: this.threadId, cwd: this.cwd, model,
          sandbox: "danger-full-access", approvalPolicy: "never", config: { model_reasoning_effort: "medium" }, excludeTurns: true });
        break;
      } catch (e) {
        // Resume has not submitted a prompt. Only this pre-submission operation
        // may be retried; turn/start must never be replayed after an uncertain reply.
        if (!(e instanceof Error && /already has an active writer/i.test(e.message))) throw e;
        if (Date.now() >= deadline) throw new Error("Codex is still holding this conversation. Open the task in Codex and try again; its history is preserved.");
        if (this.desktopAvailable && !wokeDesktop) {
          wokeDesktop = true;
          await (this.recovery.wakeDesktop ?? wakeCodexDesktop)(this.threadId);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 250 * ++attempts, Math.max(0, deadline - Date.now()))));
      }
    }
    if (this.done) return;
    const request = { threadId: this.threadId, input: [{ type: "text", text, text_elements: [] }], model, effort: "medium", ...fullAccess };
    if (this.desktop) {
      const { thread } = await this.connection.rpc("thread/read", { threadId: this.threadId, includeTurns: false });
      this.rolloutPath = thread.path;
      if (!this.rolloutPath) throw new Error("Codex did not return its conversation log path");
      this.rolloutOffset = fs.statSync(this.rolloutPath).size;
      await this.desktop.rpc("thread-follower-update-thread-settings", { conversationId: this.threadId, threadSettings: { model, effort: "medium", ...fullAccess } }, 1);
      const response = await this.desktop.rpc("thread-follower-start-turn", { conversationId: this.threadId,
        turnStart: { request, context: {} } }, 2);
      this.turnId = response.result?.turn?.id || response.result?.result?.turn?.id;
      if (!this.turnId) throw new Error("Codex desktop accepted a request without a turn ID; check the task before retrying");
      void this.poll();
    } else {
      const response = await this.connection.rpc("turn/start", request);
      this.turnId = response.turn.id;
    }
  }
  private async findDesktopOwner() {
    if (!this.desktopEnabled) return;
    const desktop = new CodexDesktopConnection(this.desktopSocketPath);
    try {
      await desktop.connect();
      this.desktopAvailable = true;
      if (this.done) { desktop.close(); return; }
      if (await desktop.owns(this.threadId)) {
        this.desktop = desktop;
        desktop.onClose = () => { if (!this.done) this.fail(new Error("Codex desktop disconnected before completion")); };
      } else desktop.close();
    } catch (e) {
      desktop.close();
      if (!(e instanceof Error && /ENOENT|ECONNREFUSED/.test(e.message))) throw e;
    }
  }
  private async poll() {
    if (this.done) return;
    try {
      // A different app server labels an in-flight disk-only turn "interrupted".
      // Only explicit completion/abort events in the owner's log are authoritative.
      const handle = await fs.promises.open(this.rolloutPath!, "r");
      try {
        const buffer = Buffer.alloc(512 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.rolloutOffset);
        this.rolloutOffset += bytesRead;
        this.rolloutBuffer += this.rolloutDecoder.write(buffer.subarray(0, bytesRead));
      } finally { await handle.close(); }
      const lines = this.rolloutBuffer.split("\n");
      this.rolloutBuffer = lines.pop() || "";
      for (const line of lines) {
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type !== "event_msg" || event.payload?.turn_id !== this.turnId) continue;
        const p = event.payload;
        if (p.type === "item_completed") {
          const item = p.item;
          this.item({ ...item, type: item.type[0].toLowerCase() + item.type.slice(1),
            text: item.text || (item.content || []).map((c: any) => c.text || "").join(""),
            command: Array.isArray(item.command) ? item.command.join(" ") : item.command });
        } else if (p.type === "task_complete") {
          this.finalText = p.last_agent_message || this.finalText;
          this.completeTurn({ status: "completed" });
        } else if (p.type === "turn_aborted") this.completeTurn({ status: "interrupted" });
      }
    } catch (e) { this.fail(e); }
    if (!this.done) this.pollTimer = setTimeout(() => void this.poll(), 1000);
  }
  private item(item: any) {
    const key = `${item.id}:${item.status || "completed"}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (item.type === "agentMessage") {
      this.finalText = item.text || "";
      this.push({ type: "assistant", message: { content: [{ type: "text", text: this.finalText }] } });
    } else if (item.type === "reasoning") {
      this.push({ type: "thinking", text: (item.summary || []).join("\n") }); this.push({ type: "thinking" });
    } else if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"].includes(item.type)) {
      const name = item.command || item.tool || item.type;
      if (!this.startedTools.has(item.id)) {
        this.startedTools.add(item.id);
        this.push({ type: "tool_call", subtype: "started", name });
      }
      if (item.status !== "inProgress") this.push({ type: "tool_call", subtype: "completed", name });
    }
  }
  private completeTurn(turn: any) {
    this.finish(turn.status === "completed" ? { status: "finished", result: this.finalText }
      : turn.status === "interrupted" ? { status: "cancelled" }
      : { status: "error", error: { message: turn.error?.message || "Codex turn failed" } });
  }
  fail(error: unknown) { this.finish({ status: "error", error: { message: error instanceof Error ? error.message : String(error) } }); }
  private finish(result: CursorRunResult) {
    if (this.done) return;
    this.done = true; clearTimeout(this.pollTimer);
    if (!this.interrupting) {
      void this.closeConnections().then(() => this.resolve(result));
    } else this.resolve(result);
    this.wake?.();
  }
  private closeConnections(): Promise<void> {
    this.desktop?.close();
    return this.cleanup ??= this.connection.close();
  }
  private push(event: unknown) { this.events.push(event); this.wake?.(); }
  supports(op: string): boolean { return ["wait", "stream", "cancel"].includes(op); }
  async *stream(): AsyncIterable<unknown> {
    while (true) {
      while (this.events.length) yield this.events.shift();
      if (this.done) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
  wait(): Promise<CursorRunResult> { return this.finished; }
  cancel(): Promise<void> { return this.cancelling ??= this.interrupt(); }
  private async interrupt(): Promise<void> {
    if (this.done) { await this.closeConnections(); return; }
    this.interrupting = true;
    try {
      if (this.turnId) {
        if (this.desktop) await this.desktop.rpc("thread-follower-interrupt-turn", { conversationId: this.threadId, expectedTurnId: this.turnId }, 4);
        else await this.connection.rpc("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
      }
    } catch (e) {
      if (!this.done) throw e;
    } finally {
      this.interrupting = false;
      if (this.done) await this.closeConnections();
    }
    this.finish({ status: "cancelled" });
    await this.closeConnections();
  }
}
