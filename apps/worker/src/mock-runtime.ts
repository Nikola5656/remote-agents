import { randomUUID } from "node:crypto";
import { MODEL_CATALOG } from "@remote-agents/shared";
import type {
  ClaudeJob,
  ClaudeLauncher,
  CursorAgentHandle,
  CursorRunHandle,
  CursorRunResult,
  CursorRuntime,
  SendOptions,
} from "./runtime";

export interface MockHold {
  release: () => void;
  cancelled: () => boolean;
}

interface InternalHold {
  promise: Promise<void>;
  release: () => void;
  wasCancelled: boolean;
}

export class MockCursorRuntime implements CursorRuntime {
  readonly kind = "mock" as const;
  readonly sends: Array<{ text: string; model: string; force?: boolean; agentId: string }> = [];
  readonly exchanges: Array<{
    composerId: string;
    kind: "start" | "update" | "finish";
    text: string;
  }> = [];
  cancels = 0;
  creates = 0;
  staleFailuresLeft = 0;
  private pendingHolds: InternalHold[] = [];
  private bubbleSeq = 0;

  readonly transcript = {
    startExchange: (composerId: string, userText: string): string | null => {
      this.exchanges.push({ composerId, kind: "start", text: userText });
      this.bubbleSeq += 1;
      return `bubble-${this.bubbleSeq}`;
    },
    updateExchange: (composerId: string, _bubbleId: string, text: string): void => {
      this.exchanges.push({ composerId, kind: "update", text });
    },
    finishExchange: (composerId: string, _bubbleId: string, text: string): void => {
      this.exchanges.push({ composerId, kind: "finish", text });
    },
  };

  holdNext(): MockHold {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold: InternalHold = { promise, release, wasCancelled: false };
    this.pendingHolds.push(hold);
    return {
      release: () => hold.release(),
      cancelled: () => hold.wasCancelled,
    };
  }

  async create(input: {
    slotId: string;
    model: string;
    cwd: string;
    apiKey?: string;
  }): Promise<CursorAgentHandle> {
    this.creates += 1;
    return this.makeAgent(`mock-${input.slotId}`);
  }

  async resume(agentId: string): Promise<CursorAgentHandle> {
    return this.makeAgent(agentId);
  }

  async listModels(): Promise<string[]> {
    return MODEL_CATALOG.map((m) => m.id);
  }

  private makeAgent(agentId: string): CursorAgentHandle {
    const runtime = this;
    return {
      agentId,
      async send(text: string, options: SendOptions): Promise<CursorRunHandle> {
        if (runtime.staleFailuresLeft > 0) {
          runtime.staleFailuresLeft -= 1;
          throw new Error(`Agent ${agentId} already has active run`);
        }
        runtime.sends.push({ text, model: options.model, force: options.force, agentId });
        const hold = runtime.pendingHolds.shift() ?? immediateHold();
        return new MockRun(hold, () => {
          runtime.cancels += 1;
        });
      },
      async dispose() {},
    };
  }
}

function immediateHold(): InternalHold {
  return { promise: Promise.resolve(), release: () => undefined, wasCancelled: false };
}

class MockRun implements CursorRunHandle {
  readonly id = randomUUID();
  private cancelled = false;
  private finished: Promise<CursorRunResult>;

  constructor(
    private readonly hold: InternalHold,
    private readonly onCancel: () => void
  ) {
    this.finished = this.hold.promise.then(() => ({
      status: this.cancelled ? "cancelled" : "finished",
      result: this.cancelled ? "cancelled" : "ok",
    }));
  }

  supports(op: string): boolean {
    return op === "cancel" || op === "wait" || op === "stream";
  }

  async *stream(): AsyncIterable<unknown> {
    yield {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Working on the request." }],
      },
    };
    yield { type: "tool_call", name: "read", call_id: "1", status: "running" };
    await this.hold.promise;
  }

  wait(): Promise<CursorRunResult> {
    return this.finished;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.hold.wasCancelled = true;
    this.onCancel();
    this.hold.release();
  }
}

export class MockClaudeLauncher implements ClaudeLauncher {
  readonly spawns: Array<{ text: string; cwd: string; bin: string }> = [];
  readonly kills: number[] = [];

  start(input: { bin: string; text: string; cwd: string }): ClaudeJob {
    this.spawns.push({ ...input });
    const launcher = this;
    return {
      kill() {
        launcher.kills.push(1);
      },
      async *output() {
        yield `claude: ${input.text}`;
      },
      async wait() {
        return { code: 0, signal: null };
      },
    };
  }
}
