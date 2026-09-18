import type { AgentStatus, DeliveryMode, QueuedInstruction } from "@remote-agents/shared";
import {
  condenseOutput,
  dequeueInstruction,
  enqueueInstruction,
  type CommandQueueState,
} from "@remote-agents/shared";
import { randomUUID } from "node:crypto";
import type { ClaudeJob, ClaudeLauncher } from "./runtime";

export interface ClaudeView {
  attached: boolean;
  status: AgentStatus;
  headline: string;
  percent: number;
}

const STOP_TOKEN = "__STOP_CLAUDE__";

export class ClaudeSidecar {
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  // Keep interrupted jobs until their process completion, even after a new job starts.
  private jobs = new Map<ClaudeJob, { done: Promise<void>; timer?: NodeJS.Timeout }>();
  private attached = false;
  private status: AgentStatus = "idle";
  private headline = "";
  private percent = 0;
  private queueState: CommandQueueState = { items: [] };
  private job: ClaudeJob | null = null;
  private generation = 0;
  private loopPromise: Promise<void> | null = null;
  private fullText = "";
  private actions: string[] = [];
  private interruptWaiters = new Set<() => void>();
  private onChange: () => void;

  constructor(
    private readonly launcher: ClaudeLauncher,
    private readonly bin: string,
    private cwd: string,
    onChange: () => void
  ) {
    this.onChange = onChange;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  snapshot(): ClaudeView | undefined {
    if (!this.attached && this.status === "idle" && this.queueState.items.length === 0) {
      return undefined;
    }
    return {
      attached: this.attached,
      status: this.status,
      headline: this.headline || (this.attached ? "Claude attached" : "Claude idle"),
      percent: this.percent,
    };
  }

  spawn(text: string, mode: DeliveryMode): void {
    if (this.disposed) return;
    this.attached = true;
    this.enqueue(text, mode);
  }

  stop(mode: DeliveryMode): void {
    this.enqueue(STOP_TOKEN, mode);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.generation += 1;
    this.queueState = { items: [] };
    this.attached = false;
    this.status = "idle";
    this.percent = 0;
    this.job = null;
    this.tripInterrupt();
    const pending = [...this.jobs.entries()];
    for (const [job] of pending) this.terminate(job);
    this.disposePromise = Promise.all([this.loopPromise, ...pending.map(([, state]) => state.done)]).then(() => undefined);
    return this.disposePromise;
  }

  private enqueue(text: string, mode: DeliveryMode): void {
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
      this.killJob();
      this.tripInterrupt();
    }
    this.emit();
    this.ensureLoop();
  }

  private ensureLoop(): void {
    if (this.disposed || this.loopPromise) return;
    this.loopPromise = this.loop().finally(() => {
      this.loopPromise = null;
      if (this.queueState.items.length > 0) this.ensureLoop();
    });
  }

  private async loop(): Promise<void> {
    while (!this.disposed) {
      const { next, item } = dequeueInstruction(this.queueState);
      if (!item) break;
      this.queueState = next;
      if (item.text === STOP_TOKEN) {
        this.killJob();
        this.attached = false;
        this.status = "idle";
        this.headline = "Claude stopped";
        this.percent = 0;
        this.emit();
        continue;
      }
      await this.execute(item);
    }
    if (this.attached && this.status !== "error") {
      this.status = "idle";
      if (!this.headline) this.headline = "Claude idle";
      this.emit();
    }
  }

  private async execute(item: QueuedInstruction): Promise<void> {
    const gen = this.generation;
    this.attached = true;
    this.status = "running";
    this.headline = "Claude starting…";
    this.percent = 5;
    this.fullText = "";
    this.actions = [];
    this.emit();

    try {
      const job = this.launcher.start({
        bin: this.bin,
        text: item.text,
        cwd: this.cwd,
      });
      if (gen !== this.generation) {
        job.kill("SIGTERM");
        return;
      }
      const wait = job.wait();
      const state: { done: Promise<void>; timer?: NodeJS.Timeout } = { done: Promise.resolve() };
      state.done = wait.then(() => undefined, () => undefined).finally(() => {
        clearTimeout(state.timer);
        this.jobs.delete(job);
      });
      this.jobs.set(job, state);
      this.job = job;
      let interrupt!: () => void;
      const gate = new Promise<void>((resolve) => { interrupt = resolve; this.interruptWaiters.add(resolve); });
      try {
        const completion = Promise.all([wait, this.consume(job, gen)]).then(([exit]) => {
          if (exit.code !== 0 || exit.signal) throw new Error("Claude Code exited unsuccessfully");
        });
        await Promise.race([completion, gate]);
      } finally {
        this.interruptWaiters.delete(interrupt);
      }
      if (gen !== this.generation) return;
      this.status = "idle";
      this.refresh("finished");
      this.headline = this.headline || "Claude finished";
      this.percent = 100;
    } catch (err) {
      if (gen !== this.generation) return;
      this.killJob();
      this.status = "error";
      this.headline = err instanceof Error ? err.message : String(err);
      this.percent = 0;
    } finally {
      if (this.job && gen === this.generation) this.job = null;
      this.emit();
    }
  }

  private async consume(job: ClaudeJob, gen: number): Promise<void> {
    for await (const chunk of job.output()) {
      if (gen !== this.generation || this.status !== "running") break;
      if (!chunk) continue;
      this.fullText = appendCapped(this.fullText, chunk);
      this.refresh("running");
      this.emit();
    }
  }

  private refresh(status: "running" | "finished" | "error" | "cancelled" | "idle"): void {
    const view = condenseOutput({
      fullText: this.fullText,
      actions: this.actions,
      status,
    });
    this.percent = view.percent;
    this.headline = view.headline;
  }

  private killJob(): void {
    const job = this.job;
    this.job = null;
    if (job) this.terminate(job);
  }

  private terminate(job: ClaudeJob): void {
    const state = this.jobs.get(job);
    if (!state || state.timer) return;
    try { job.kill("SIGTERM"); } catch { /* Still attempt escalation. */ }
    state.timer = setTimeout(() => {
      try { job.kill("SIGKILL"); } catch { /* Wait for provider completion. */ }
    }, 2000);
    // Deliberately referenced: shutdown must not exit before escalation/cleanup.
  }

  private tripInterrupt(): void {
    for (const w of this.interruptWaiters) w();
    this.interruptWaiters.clear();
  }

  private emit(): void {
    if (!this.disposed) this.onChange();
  }
}

function appendCapped(current: string, next: string, max = 80_000): string {
  const joined = current ? `${current}\n${next}` : next;
  return joined.length <= max ? joined : joined.slice(joined.length - max);
}
