import { randomUUID } from "node:crypto";
import { MODEL_CATALOG, canonicalModelId } from "@remote-agents/shared";
import type { ComposerSidebar } from "./composer-sidebar";
import { DesktopBridge } from "./desktop-bridge";
import { log, logError } from "./log";
import type {
  CursorAgentHandle,
  CursorRunHandle,
  CursorRunResult,
  CursorRuntime,
  SendOptions,
} from "./runtime";

const POLL_MS = 1200;
/**
 * Safety net only: if the turn never reaches status "completed" (a hard error
 * where the IDE never updates status) we finish after the store has been quiet
 * this long. Normal completion is detected immediately via status "completed",
 * so this is deliberately long — a long-running task can pause for minutes
 * between tool calls, and cutting it off early makes the dashboard show IDLE
 * while the IDE is still working.
 */
const STALL_MS = 180_000;
const RUN_TIMEOUT_MS = 45 * 60_000;
/** How long to wait for the IDE to visibly start after sendMessage. */
const START_TIMEOUT_MS = 90_000;

/**
 * Drives the chats of the RUNNING Cursor IDE through its Desktop Bridge.
 * Messages are submitted into real sidebar conversations, the IDE executes
 * them itself (fully visible + live, on this Mac), and the worker streams the
 * output back by reading the conversation store the IDE persists.
 */
export class BridgeCursorRuntime implements CursorRuntime {
  readonly kind = "bridge" as const;
  // The IDE renders its own runs live; no mirroring needed.
  readonly transcript = null;

  constructor(
    private readonly bridge: DesktopBridge,
    private readonly sidebar: ComposerSidebar,
    private readonly cliFallback?: CursorRuntime,
    private readonly apiKey?: string
  ) {}

  async create(input: {
    slotId: string;
    name?: string;
    model: string;
    cwd: string;
  }): Promise<CursorAgentHandle> {
    const name = input.name || input.slotId;
    const existing = this.sidebar.findNamedChat(name);
    const chatId = existing || randomUUID();
    this.sidebar.ensureChat({ composerId: chatId, name, model: input.model });
    log("bridge chat ready", input.slotId, chatId, name);
    return this.wrap(chatId, name, input.cwd);
  }

  async resume(
    agentId: string,
    input: { model: string; cwd: string; name?: string }
  ): Promise<CursorAgentHandle> {
    const name = input.name || agentId;
    this.sidebar.ensureChat({ composerId: agentId, name, model: input.model });
    log("bridge chat resumed", agentId, name);
    return this.wrap(agentId, name, input.cwd);
  }

  async listModels(): Promise<string[]> {
    return MODEL_CATALOG.map((m) => m.id);
  }

  private wrap(chatId: string, name: string, cwd: string): CursorAgentHandle {
    const runtime = this;
    return {
      agentId: chatId,
      async send(text: string, options: SendOptions) {
        const conversation = runtime.sidebar.readConversation(chatId);
        const actualModel = conversation?.model;
        // Desktop Bridge cannot set the model in the IDE's in-memory state.
        // Run the selected model through the CLI when the IDE differs, and
        // mirror that run back into the same sidebar conversation.
        if (!actualModel || canonicalModelId(actualModel) !== canonicalModelId(options.model)) {
          if (!runtime.cliFallback) throw new Error("Cursor IDE model differs from the selection; CLI fallback is unavailable");
          const cli = await runtime.cliFallback.resume(chatId, { model: options.model, cwd, name, apiKey: runtime.apiKey });
          const run = await cli.send(text, options);
          log("Cursor model routed through CLI", name, options.model, "IDE model", actualModel);
          return { id: run.id, transcript: runtime.sidebar, supports: (op) => run.supports(op),
            stream: () => run.stream(), wait: () => run.wait(), cancel: () => run.cancel() };
        }
        const baseline = conversation?.headerCount ?? 0;
        const scopedText = `Working directory for this task: ${JSON.stringify(cwd)}. Resolve relative file paths in this folder and run shell commands from it.\n\n${text}`;
        const res = (await runtime.bridge.sendMessage(chatId, scopedText, options.force)) as Record<
          string,
          unknown
        >;
        // The bridge reports success as {status:"submitted"|"queued"} and
        // failures as {outcome|status:"error"|"not-found"|"not-sendable", …}.
        const outcome = String(res.outcome ?? res.status ?? "");
        if (outcome === "not-found") {
          throw new Error(
            `${name}: the Cursor IDE does not know this chat — open the Agents sidebar once, then retry`
          );
        }
        if (outcome === "not-sendable") {
          throw new Error(`${name}: chat cannot accept messages: ${String(res.reason || "")}`);
        }
        if (outcome === "error") {
          throw new Error(`${name}: bridge error: ${String(res.message || "unknown")}`);
        }
        log("bridge message", outcome || "submitted", name, chatId);
        return new BridgeRun(runtime.sidebar, chatId, baseline, outcome === "queued");
      },
      async dispose() {},
    };
  }
}

export class BridgeRun implements CursorRunHandle {
  readonly id = randomUUID();
  private readonly events: unknown[] = [];
  private readonly waiters: Array<() => void> = [];
  private done = false;
  private cancelled = false;
  private readonly finished: Promise<CursorRunResult>;

  constructor(
    private readonly sidebar: ComposerSidebar,
    private readonly chatId: string,
    private readonly baseline: number,
    private readonly queued: boolean,
    private readonly timing = { pollMs: POLL_MS, stallMs: STALL_MS, startTimeoutMs: START_TIMEOUT_MS, runTimeoutMs: RUN_TIMEOUT_MS }
  ) {
    this.finished = this.pump().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.finishStream();
      return { status: "error" as const, error: { message } };
    });
  }

  supports(op: string): boolean {
    return op === "wait" || op === "stream" || op === "cancel";
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
    // The bridge has no cancel; interrupts are delivered as force-sends by
    // the caller. Stop observing so a new run can take over cleanly.
    this.cancelled = true;
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
    const startedAt = Date.now();
    const textChars = new Map<string, number>(); // bubbleId -> assistant chars emitted
    const metaEmitted = new Set<string>(); // bubbleId -> thinking/tool already emitted
    // Bridge-driven runs keep generatingCount=0 and status="aborted" for the
    // whole turn (an artifact of submitChatMaybeAbortCurrent) and only flip to
    // "completed" at the very end — so status "completed" is the sole reliable
    // completion signal. We still stream each bubble as it lands on disk.
    let started = false;
    let lastChangeAt = Date.now();

    while (!this.cancelled) {
      await sleep(this.timing.pollMs);
      const state = this.sidebar.readConversation(this.chatId, this.baseline);
      if (!state) continue;

      let changed = false;
      for (const step of state.assistant) {
        // Tool calls and thinking each arrive as their own bubble; emit once.
        if (!metaEmitted.has(step.bubbleId)) {
          if (step.tool) {
            metaEmitted.add(step.bubbleId);
            this.push(toolEvent(step.tool));
            changed = true;
            started = true;
          } else if (step.thinking) {
            metaEmitted.add(step.bubbleId);
            for (const ev of thinkingEvent(step.thinking)) this.push(ev);
            changed = true;
            started = true;
          }
        }
        // Assistant answer text can grow across polls; emit deltas.
        const emitted = textChars.get(step.bubbleId) ?? 0;
        if (step.text.length > emitted) {
          this.push(assistantEvent(step.text.slice(emitted)));
          textChars.set(step.bubbleId, step.text.length);
          changed = true;
          started = true;
        }
      }
      if (changed) lastChangeAt = Date.now();

      const quietFor = Date.now() - lastChangeAt;
      // Primary, reliable completion signal. status is "aborted" for the whole
      // duration of a bridge-driven turn (submit-with-abort artifact) and flips
      // to "completed" when the turn truly ends, so it is the only trustworthy
      // done marker. Never report "(interrupted)" from here: a real interrupt
      // arrives as a cancel() on this run, and everything else that looks
      // aborted is just a run in progress.
      const completed = state.status === "completed";
      const stalled = started && quietFor >= this.timing.stallMs;

      if (completed) {
        const finalText = state.assistant
          .map((s) => s.text)
          .filter(Boolean)
          .join("\n")
          .trim();
        this.finishStream();
        return { status: "finished", result: finalText || "ok" };
      }
      if (stalled) {
        this.finishStream();
        return { status: "error", error: { message: "Cursor stopped reporting activity without confirming completion. Check the existing chat before retrying." } };
      }
      if (!started && Date.now() - startedAt > this.timing.startTimeoutMs && !this.queued) {
        this.finishStream();
        return {
          status: "error",
          error: {
            message:
              "The IDE did not start the run (is the Cursor app open and the chat visible?)",
          },
        };
      }
      if (Date.now() - startedAt > this.timing.runTimeoutMs) {
        this.finishStream();
        return { status: "error", error: { message: "run timed out" } };
      }
    }

    this.finishStream();
    if (this.cancelled) return { status: "cancelled", result: "cancelled" };
    return { status: "finished", result: "ok" };
  }
}

function assistantEvent(text: string): unknown {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function thinkingEvent(text: string): unknown[] {
  // parseCursorEvent buffers thinking deltas until a thinkingEnd marker.
  return [
    { type: "thinking", text },
    { type: "thinking" },
  ];
}

function toolEvent(tool: { name: string; target?: string; status?: string }): unknown {
  const label = tool.target ? `${tool.name} ${tool.target}` : tool.name;
  return { type: "tool_call", name: label, status: tool.status };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function bridgeRuntimeAvailable(bridge: DesktopBridge): boolean {
  try {
    return bridge.available();
  } catch (err) {
    logError("bridge availability check failed", err);
    return false;
  }
}
