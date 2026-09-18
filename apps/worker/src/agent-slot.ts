import { randomUUID } from "node:crypto";
import type {
  AgentKind,
  AgentSnapshot,
  AgentStatus,
  DeliveryMode,
  OutputMode,
  QueuedInstruction,
} from "@remote-agents/shared";
import {
  condenseOutput,
  dequeueInstruction,
  enqueueInstruction,
  MODEL_CATALOG,
  modelProvider,
  type CommandQueueState,
} from "@remote-agents/shared";
import {
  createRunReportPath,
  extractWritePathsFromEvent,
  finalizeRunReports,
  reportHintsEnabled,
  withReportInstruction,
  type RunReportStatus,
} from "./artifact-reports";
import { ClaudeSidecar } from "./claude-sidecar";
import { parseCursorEvent } from "./events";
import { log, logError } from "./log";
import type { AgentStore, PersistedSlot } from "./persist";
import { isComposerChatId } from "./cli-cursor-runtime";
import type {
  ClaudeLauncher,
  CursorAgentHandle,
  CursorRunHandle,
  CursorRuntime,
  TranscriptMirror,
} from "./runtime";

const FULL_LOG_CAP = 160_000;
/** Max characters mirrored into the IDE assistant bubble. */
const MIRROR_TEXT_CAP = 32_000;
/** Minimum ms between streaming updates of the mirrored assistant bubble. */
const MIRROR_INTERVAL_MS = 3_000;

export interface SlotOptions {
  id: string;
  name: string;
  kind: AgentKind;
  model: string;
  cwd: string;
  apiKey: string;
  runtime: CursorRuntime;
  claude: ClaudeLauncher;
  claudeBin: string;
  availableModels: string[];
  store: AgentStore;
  persisted?: PersistedSlot;
  onUpdate: (snapshot: AgentSnapshot) => void;
  /** Optional IDE transcript mirror (composer sidebar); best-effort only. */
  mirror?: TranscriptMirror | null;
}

export class AgentSlot {
  readonly id: string;
  readonly name: string;
  readonly kind: AgentKind;
  cwd: string;
  model: string;
  private outputMode: OutputMode = "condensed";
  private status: AgentStatus = "starting";
  private percent = 0;
  private headline = "Starting…";
  private summary = "";
  private lastActions: string[] = [];
  private condensedLog = "";
  private fullLog = "";
  private actions: string[] = [];
  private toolCount = 0;
  private runStartedAt?: number;
  private lastEventAt?: number;
  private subagents = new Map<string, "running" | "done">();
  private runTranscript = "";
  private producedPaths: string[] = [];
  private lastUserPrompt = "";
  private mirrorBubbleId: string | null = null;
  private lastMirrorAt = 0;
  private runId?: string;
  private cursorAgentId?: string;
  private cursor: CursorAgentHandle | null = null;
  private queueState: CommandQueueState = { items: [] };
  private activeRun: CursorRunHandle | null = null;
  private generation = 0;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private interruptWaiters = new Set<() => void>();
  private throttle: NodeJS.Timeout | null = null;
  private lastError = "";
  private readonly claudeSidecar: ClaudeSidecar;
  private readonly availableModels: string[];
  private readonly apiKey: string;
  private readonly runtime: CursorRuntime;
  private readonly store: AgentStore;
  private readonly onUpdate: (snapshot: AgentSnapshot) => void;
  private mirror: TranscriptMirror | null;
  private readonly defaultMirror: TranscriptMirror | null;
  private workspaceTransitions = 0;
  private workspaceBlocked = false;
  private workspaceTail: Promise<void> = Promise.resolve();
  private releaseDisposed!: () => void;
  private readonly disposedSignal = new Promise<void>(resolve => { this.releaseDisposed = resolve; });
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private cursorPromise: Promise<CursorAgentHandle> | null = null;
  private bootPromise: Promise<void> | null = null;

  constructor(opts: SlotOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.kind = opts.kind;
    this.model = opts.model;
    this.cwd = opts.cwd;
    this.apiKey = opts.apiKey;
    this.runtime = opts.runtime;
    this.store = opts.store;
    this.availableModels = opts.availableModels;
    this.onUpdate = opts.onUpdate;
    this.mirror = opts.mirror ?? null;
    this.defaultMirror = this.mirror;
    this.cursorAgentId = opts.persisted?.cursorAgentId;
    this.claudeSidecar = new ClaudeSidecar(opts.claude, opts.claudeBin, opts.cwd, () =>
      this.emit(true)
    );
  }

  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      model: this.model,
      provider: modelProvider(this.model),
      reasoningEffort: modelProvider(this.model) === "codex" ? "medium" : undefined,
      availableModels: this.availableModels.length
        ? this.availableModels
        : MODEL_CATALOG.map((m) => m.id),
      status: this.status,
      percent: this.percent,
      headline: this.headline,
      summary: this.summary,
      lastActions: this.lastActions.slice(-4),
      outputMode: this.outputMode,
      queueLength: this.queueState.items.length,
      queue: this.queueState.items.slice(),
      condensedLog: this.condensedLog,
      fullLog: this.fullLog,
      lastInstruction: this.lastUserPrompt || undefined,
      claude: this.claudeSidecar.snapshot(),
      updatedAt: Date.now(),
      runId: this.runId,
      cwd: this.cwd,
      runStartedAt: this.runStartedAt,
      toolCount: this.toolCount,
      lastEventAt: this.lastEventAt,
      subagents: this.subagents.size
        ? [...this.subagents.entries()].map(([name, status]) => ({ name, status }))
        : undefined,
    };
  }

  async boot(): Promise<void> {
    if (this.disposed) return;
    if (this.bootPromise) return this.bootPromise;
    this.bootPromise = this.bootInner();
    return this.bootPromise;
  }

  private async bootInner(): Promise<void> {
    this.status = "starting";
    this.headline =
      this.runtime.kind === "degraded"
        ? "Degraded: Cursor chats unavailable"
        : this.runtime.kind === "codex" ? "Connecting Codex…" : "Connecting Cursor chat…";
    this.emit(true);
    try {
      await this.ensureCursor();
      if (this.disposed) return;
      this.status = "idle";
      this.headline = this.runtime.kind === "degraded" ? "Online (degraded)" : "Idle";
      this.percent = 0;
    } catch (err) {
      if (this.disposed) return;
      this.status = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      this.headline = this.lastError;
      logError("agent boot failed", this.id, this.lastError);
    }
    this.emit(true);
  }

  handleInstruction(text: string, mode: DeliveryMode): void {
    if (this.disposed) return;
    const item: QueuedInstruction = {
      id: randomUUID(),
      text,
      mode,
      createdAt: Date.now(),
    };
    const { next, interrupted } = enqueueInstruction(this.queueState, item, mode);
    this.queueState = next;
    if (interrupted) {
      this.generation += 1;
      void this.cancelActive();
      this.tripInterrupt();
    } else if (this.status === "idle") {
      this.status = "queued";
    }
    this.emit(true);
    this.ensureLoop();
  }

  /** Cancel only the observed run; queued instructions continue after it settles. */
  async stopRun(runId: string): Promise<void> {
    if (this.disposed) throw new Error("Agent is offline. Reconnect before stopping a task.");
    const run = this.activeRun;
    if (!runId || !run || this.runId !== runId || run.id !== runId || this.status !== "running") {
      throw new Error("This task is no longer active. Refresh activity before stopping another task.");
    }
    if (this.stopping) throw new Error("A stop request is already in progress. Wait for the task to stop.");
    if (!run.supports("cancel")) throw new Error("This agent runtime cannot stop an active task.");
    this.stopping = true;
    try {
      // Do not clear the handle, change generation or release the scheduler
      // before the provider accepts cancellation. Rejections leave the task intact.
      await run.cancel();
    } catch (error) {
      throw new Error(`Could not stop the task: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.stopping = false;
      this.ensureLoop();
    }
  }

  removeQueuedInstruction(instructionId: string): void {
    if (this.disposed) throw new Error("Agent is offline. Reconnect before changing the queue.");
    const index = this.queueState.items.findIndex((item) => item.id === instructionId);
    if (index < 0) throw new Error("This instruction is no longer queued; it may have started. Refresh the queue.");
    this.queueState = { items: this.queueState.items.filter((_, itemIndex) => itemIndex !== index) };
    if (!this.queueState.items.length && !this.activeRun && this.status === "queued") this.status = "idle";
    this.emit(true);
  }

  setModel(model: string): void {
    if (this.disposed) return;
    this.model = model;
    this.persist();
    this.headline = `Model set to ${model} (applies on next send)`;
    this.emit(true);
  }

  setOutputMode(mode: OutputMode): void {
    if (this.disposed) return;
    this.outputMode = mode;
    this.emit(true);
  }

  setCwd(cwd: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (cwd === this.cwd && !this.workspaceBlocked && this.workspaceTransitions === 0) {
      this.emit(true);
      return Promise.resolve();
    }
    // Close the scheduler synchronously, before waking the interrupted run.
    this.workspaceTransitions++;
    this.workspaceBlocked = true;
    this.generation++;
    this.tripInterrupt();
    const transition = this.workspaceTail.then(() => this.changeWorkspace(cwd)).finally(() => {
      this.workspaceTransitions--;
      if (!this.disposed && !this.workspaceBlocked && this.workspaceTransitions === 0) {
        this.ensureLoop();
      }
    });
    // A failed transition does not poison subsequent explicit recovery requests.
    this.workspaceTail = transition.catch(() => undefined);
    return Promise.race([transition, this.disposedSignal]);
  }

  private async changeWorkspace(cwd: string): Promise<void> {
    if (this.disposed) return;
    try {
      await this.cancelActive();
      await this.loopPromise;
      await this.cursorPromise?.catch(() => undefined);
      if (this.disposed) return;
      // Same-path requests are also an explicit retry after a reconnect failure.
      if (cwd !== this.cwd || !this.cursor) {
        const old = this.cursor;
        this.cursor = null;
        this.cursorAgentId = undefined;
        if (old) await old.dispose();
        if (this.disposed) return;
        this.cwd = cwd;
        this.claudeSidecar.setCwd(cwd);
        this.persist();
        await this.ensureCursor();
      }
      if (this.disposed) return;
      this.workspaceBlocked = false;
      this.lastError = "";
      this.status = "idle";
      this.headline = `Workspace set to ${cwd}`;
      this.emit(true);
    } catch (err) {
      if (this.disposed) return;
      this.workspaceBlocked = true;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.status = "error";
      this.headline = `Workspace change failed: ${this.lastError}`;
      this.emit(true);
      throw err;
    }
  }

  spawnClaude(text: string, mode: DeliveryMode): void {
    if (this.disposed) return;
    this.claudeSidecar.spawn(text, mode);
    this.emit(true);
  }

  stopClaude(mode: DeliveryMode): void {
    if (this.disposed) return;
    this.claudeSidecar.stop(mode);
    this.emit(true);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.releaseDisposed();
    this.generation += 1;
    this.queueState = { items: [] };
    if (this.throttle) {
      clearTimeout(this.throttle);
      this.throttle = null;
    }
    this.tripInterrupt();
    this.disposePromise = this.disposeInner();
    return this.disposePromise;
  }

  private async disposeInner(): Promise<void> {
    // Begin both cancellations immediately; neither provider should delay the other.
    await Promise.all([this.cancelActive(), this.claudeSidecar.dispose()]);
    // A late create/resume disposes its own handle before rejecting.
    await this.cursorPromise?.catch(() => undefined);
    // Also cover a send that had not yet returned its cancellable run handle.
    await this.loopPromise;
    await this.workspaceTail;
    const cursor = this.cursor;
    this.cursor = null;
    if (cursor) await cursor.dispose();
  }

  private ensureLoop(): void {
    if (this.disposed || this.workspaceBlocked || this.workspaceTransitions || this.stopping || this.loopPromise) return;
    this.loopPromise = this.loop().finally(() => {
      this.loopPromise = null;
      if (this.queueState.items.length > 0) this.ensureLoop();
    });
  }

  private async loop(): Promise<void> {
    while (!this.disposed && !this.workspaceBlocked && !this.stopping && this.workspaceTransitions === 0) {
      const { next, item } = dequeueInstruction(this.queueState);
      if (!item) break;
      this.queueState = next;
      this.emit(true);
      await this.execute(item);
    }
    if (!this.disposed && !this.workspaceBlocked && (this.status === "running" || this.status === "queued" || this.status === "starting")) {
      this.status = this.lastError ? "error" : "idle";
      if (!this.lastError) this.headline = this.headline || "Idle";
    }
    this.emit(true);
  }

  private async execute(item: QueuedInstruction): Promise<void> {
    const gen = this.generation;
    const force = item.mode === "interrupt";
    let runReportStatus: RunReportStatus = "finished";
    const requestedReportPath = createRunReportPath(item.text);
    this.status = "running";
    this.headline = "Starting…";
    this.runId = undefined;
    this.lastError = "";
    this.runStartedAt = Date.now();
    this.toolCount = 0;
    this.actions = [];
    this.lastEventAt = undefined;
    this.subagents.clear();
    this.runTranscript = "";
    this.producedPaths = [];
    this.lastUserPrompt = item.text;
    this.mirrorBubbleId = null;
    this.refresh("running");
    this.emit(true);

    try {
      const agent = await this.ensureCursor();
      if (gen !== this.generation) {
        // Initialization yielded before submission: preserve this unsent item for the new workspace.
        if (!this.disposed && this.workspaceTransitions > 0) {
          this.queueState = { items: [item, ...this.queueState.items] };
        }
        return;
      }

      const run = await this.sendWithRecovery(agent, withReportInstruction(item.text, requestedReportPath), force);
      // Machine runtime creates the cloud agent lazily on first send —
      // persist the real id once it exists so restarts resume the same chat.
      if (agent.agentId && agent.agentId !== this.cursorAgentId) {
        this.cursorAgentId = agent.agentId;
        this.persist();
      }
      if (gen !== this.generation) {
        if (run.supports("cancel")) await run.cancel().catch(() => undefined);
        return;
      }

      this.activeRun = run;
      this.mirror = run.transcript ?? this.defaultMirror;
      this.runId = run.id;
      this.appendLog(`> ${item.text}`);
      this.startMirror(item.text);
      this.refresh("running");
      this.emit(true);

      const waitP = run.wait();
      const streamP =
        run.supports("stream")
          ? this.consumeStream(run, gen)
          : Promise.resolve();
      await Promise.race([waitP, this.waitForInterrupt()]);
      if (gen !== this.generation) return;

      const result = await waitP;
      await streamP.catch(() => undefined);
      if (gen !== this.generation) return;

      // result.result repeats the streamed assistant text; only use it when
      // nothing was captured from the stream (e.g. stream unsupported).
      if (result.result && !this.runTranscript.trim()) {
        this.appendLog(result.result);
        this.appendRunTranscript(result.result);
      }
      if (result.error?.message) {
        this.appendLog(result.error.message);
        this.appendRunTranscript(result.error.message);
      }
      const condenseStatus =
        result.status === "finished"
          ? "finished"
          : result.status === "cancelled"
            ? "cancelled"
            : result.status === "error"
              ? "error"
              : "finished";
      this.refresh(condenseStatus);
      runReportStatus =
        result.status === "cancelled"
          ? "cancelled"
          : result.status === "error"
            ? "error"
            : "finished";
      this.status = result.status === "error" ? "error" : "idle";
      if (result.status === "error") {
        this.lastError = result.error?.message || result.result || "Run failed";
        this.headline = this.lastError;
      } else if (result.status === "cancelled") {
        this.headline = "Cancelled";
      } else {
        this.headline = this.headline || "Done";
        this.percent = 100;
      }
    } catch (err) {
      if (gen !== this.generation) return;
      runReportStatus = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      this.status = "error";
      this.appendLog(`Error: ${this.lastError}`);
      this.appendRunTranscript(`Error: ${this.lastError}`);
      this.refresh("error");
      logError("run failed", this.id, this.lastError);
    } finally {
      const reportSnapshot = {
        gen,
        runId: this.runId,
        runTranscript: this.runTranscript,
        headline: this.headline,
        lastUserPrompt: this.lastUserPrompt,
        producedPaths: [...this.producedPaths],
        requestedReportPath,
        status: (gen !== this.generation ? "cancelled" : runReportStatus) as RunReportStatus,
      };
      if (this.cursor?.agentId && this.cursor.agentId !== this.cursorAgentId) {
        this.cursorAgentId = this.cursor.agentId;
        this.persist();
      }
      this.interruptWaiters.clear();
      this.finishMirror();
      if (!this.disposed) this.persistRunReports(reportSnapshot);
      this.runStartedAt = undefined;
      if (this.activeRun && gen === this.generation) this.activeRun = null;
      this.emit(true);
    }
  }

  private async consumeStream(run: CursorRunHandle, gen: number): Promise<void> {
    let thinkingBuf = "";
    const flushThinking = () => {
      const thought = thinkingBuf.replace(/\s+/g, " ").trim();
      thinkingBuf = "";
      if (thought) this.appendLog(`[thinking] ${thought}`);
    };
    try {
      for await (const event of run.stream()) {
        if (gen !== this.generation) break;
        this.lastEventAt = Date.now();
        const parsed = parseCursorEvent(event);
        if (parsed.thinkingDelta) {
          thinkingBuf += parsed.thinkingDelta;
          this.refresh("running");
          this.emit(false);
          continue;
        }
        if (parsed.thinkingEnd) {
          flushThinking();
          this.emit(false);
          continue;
        }
        if (parsed.action || parsed.text) flushThinking();
        if (parsed.subagentStart) this.subagents.set(parsed.subagentStart, "running");
        if (parsed.subagentEnd) this.subagents.set(parsed.subagentEnd, "done");
        if (parsed.action) {
          this.actions.push(parsed.action);
          this.toolCount += 1;
        }
        for (const produced of extractWritePathsFromEvent(event)) {
          this.producedPaths.push(produced);
        }
        if (parsed.text) this.appendLog(parsed.text);
        // Only clean assistant prose goes into the IDE chat bubble.
        if (parsed.assistantText) this.appendRunTranscript(parsed.assistantText);
        this.updateMirrorThrottled();
        this.refresh("running");
        this.emit(false);
      }
    } catch {
      // stream closed
    } finally {
      flushThinking();
    }
  }

  private startMirror(userText: string): void {
    if (!this.mirror || !this.cursorAgentId) return;
    try {
      this.mirrorBubbleId = this.mirror.startExchange(this.cursorAgentId, userText);
    } catch (err) {
      this.mirrorBubbleId = null;
      logError("transcript mirror start failed", this.id, err);
    }
    this.lastMirrorAt = Date.now();
  }

  private updateMirrorThrottled(): void {
    if (!this.mirror || !this.mirrorBubbleId || !this.cursorAgentId) return;
    const now = Date.now();
    if (now - this.lastMirrorAt < MIRROR_INTERVAL_MS) return;
    this.lastMirrorAt = now;
    try {
      this.mirror.updateExchange(this.cursorAgentId, this.mirrorBubbleId, this.runTranscript);
    } catch (err) {
      logError("transcript mirror update failed", this.id, err);
    }
  }

  private finishMirror(): void {
    if (!this.mirror || !this.mirrorBubbleId || !this.cursorAgentId) return;
    const bubbleId = this.mirrorBubbleId;
    this.mirrorBubbleId = null;
    try {
      this.mirror.finishExchange(
        this.cursorAgentId,
        bubbleId,
        this.runTranscript || this.headline,
        this.headline
      );
    } catch (err) {
      logError("transcript mirror finish failed", this.id, err);
    }
  }

  private persistRunReports(snapshot: {
    gen: number;
    runId?: string;
    runTranscript: string;
    headline: string;
    lastUserPrompt: string;
    producedPaths: string[];
    requestedReportPath: string;
    status: RunReportStatus;
  }): void {
    if (!reportHintsEnabled()) return;

    try {
      const result = finalizeRunReports({
        workspaceRoot: this.cwd,
        runId: snapshot.runId,
        status: snapshot.status,
        transcript: snapshot.runTranscript,
        headline: snapshot.headline,
        userPrompt: snapshot.lastUserPrompt,
        producedPaths: snapshot.producedPaths,
        requestedReportPath: snapshot.requestedReportPath,
      });
      const reportPath =
        result.defaultReportPath ||
        result.workspaceMarkdown[0] ||
        result.artifactCopies[0];
      if (reportPath) {
        this.lastActions = [...this.lastActions, `report: ${reportPath}`].slice(-4);
        if (!this.summary) {
          this.summary = `Open ${reportPath} in Files.`;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("report finalization failed", this.id, message);
      this.lastActions = [...this.lastActions, `artifact failed: ${message}`].slice(-4);
    }
  }

  private appendRunTranscript(text: string): void {
    const chunk = text.replace(/\s+$/g, "");
    if (!chunk) return;
    this.runTranscript = this.runTranscript ? `${this.runTranscript}\n${chunk}` : chunk;
    if (this.runTranscript.length > MIRROR_TEXT_CAP) {
      this.runTranscript = this.runTranscript.slice(this.runTranscript.length - MIRROR_TEXT_CAP);
    }
  }

  private isStaleRunError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /already has active run|agent_busy/i.test(msg);
  }

  private async sendWithRecovery(
    agent: CursorAgentHandle,
    text: string,
    force: boolean
  ): Promise<CursorRunHandle> {
    try {
      return await agent.send(text, {
        model: this.model,
        force: force ? true : undefined,
      });
    } catch (err) {
      if (!this.isStaleRunError(err)) throw err;
      log("stale Cursor run, retrying with force", this.id);
      try {
        return await agent.send(text, { model: this.model, force: true });
      } catch (err2) {
        if (!this.isStaleRunError(err2)) throw err2;
        log("stale Cursor run persists, recreating agent", this.id);
        try {
          await agent.dispose();
        } catch {
          // ignore
        }
        this.cursor = null;
        this.cursorAgentId = undefined;
        const fresh = await this.ensureCursor();
        return await fresh.send(text, { model: this.model, force: true });
      }
    }
  }

  private canResume(id: string): boolean {
    if (this.runtime.isResumableId) return this.runtime.isResumableId(id);
    return isComposerChatId(id);
  }

  private ensureCursor(): Promise<CursorAgentHandle> {
    if (this.disposed) return Promise.reject(new Error("Agent slot disposed"));
    if (this.cursor) return Promise.resolve(this.cursor);
    if (!this.cursorPromise) {
      this.cursorPromise = this.openCursor().finally(() => { this.cursorPromise = null; });
    }
    return this.cursorPromise;
  }

  private async openCursor(): Promise<CursorAgentHandle> {
    let handle: CursorAgentHandle | undefined;
    const input = {
      slotId: this.id, name: this.name, model: this.model,
      cwd: this.cwd, apiKey: this.apiKey || undefined,
    };
    if (this.cursorAgentId && this.canResume(this.cursorAgentId)) {
      try {
        handle = await this.runtime.resume(this.cursorAgentId, input);
      } catch (err) {
        // Never start a replacement during teardown, or discard a native Codex session.
        if (this.disposed || this.runtime.kind === "codex") throw err;
        log("resume failed, creating new agent", this.id, err);
      }
    }
    handle ??= await this.runtime.create(input);
    if (this.disposed) {
      await handle.dispose();
      throw new Error("Agent slot disposed");
    }
    this.cursor = handle;
    this.cursorAgentId = handle.agentId;
    this.persist();
    return handle;
  }

  private async cancelActive(): Promise<void> {
    const run = this.activeRun;
    this.activeRun = null;
    if (!run) return;
    try {
      if (run.supports("cancel")) await run.cancel();
    } catch (err) {
      logError("cancel failed", this.id, err);
    }
  }

  private refresh(
    status: "running" | "finished" | "error" | "cancelled" | "idle" | "queued"
  ): void {
    const view = condenseOutput({
      fullText: this.fullLog,
      actions: this.actions,
      status,
      toolCount: this.toolCount,
      elapsedMs: this.runStartedAt ? Date.now() - this.runStartedAt : 0,
    });
    this.percent = view.percent;
    this.headline = view.headline;
    this.summary = view.summary;
    this.lastActions = view.lastActions;
    this.condensedLog = view.condensedLog;
  }

  private appendLog(text: string): void {
    const chunk = text.replace(/\s+$/g, "");
    if (!chunk) return;
    this.fullLog = this.fullLog ? `${this.fullLog}\n${chunk}` : chunk;
    if (this.fullLog.length > FULL_LOG_CAP) {
      this.fullLog = this.fullLog.slice(this.fullLog.length - FULL_LOG_CAP);
    }
  }

  private persist(): void {
    if (this.disposed) return;
    const state = this.store.load();
    state.agents[this.id] = {
      cursorAgentId: this.cursorAgentId,
      model: this.model,
      name: this.name,
      kind: this.kind,
      cwd: this.cwd,
    };
    this.store.save(state);
  }

  private waitForInterrupt(): Promise<void> {
    return new Promise((resolve) => this.interruptWaiters.add(resolve));
  }

  private tripInterrupt(): void {
    for (const w of this.interruptWaiters) w();
    this.interruptWaiters.clear();
  }

  private emit(immediate: boolean): void {
    if (this.disposed) return;
    if (immediate) {
      if (this.throttle) {
        clearTimeout(this.throttle);
        this.throttle = null;
      }
      this.onUpdate(this.snapshot());
      return;
    }
    if (this.throttle) return;
    this.throttle = setTimeout(() => {
      this.throttle = null;
      this.onUpdate(this.snapshot());
    }, 120);
    this.throttle.unref?.();
  }
}
