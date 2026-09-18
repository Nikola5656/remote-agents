import { MODEL_CATALOG } from "@remote-agents/shared";
import { log, logError } from "./log";
import type {
  CursorAgentHandle,
  CursorRunHandle,
  CursorRunResult,
  CursorRuntime,
  SendOptions,
} from "./runtime";

function wrapRun(run: {
  id: string;
  supports?: (op: never) => boolean;
  stream?: () => AsyncIterable<unknown>;
  wait: () => Promise<CursorRunResult>;
  cancel?: () => Promise<void>;
}): CursorRunHandle {
  return {
    id: run.id,
    supports(op: string) {
      if (typeof run.supports === "function") {
        return (run.supports as (operation: string) => boolean)(op);
      }
      if (op === "cancel") return typeof run.cancel === "function";
      if (op === "stream") return typeof run.stream === "function";
      if (op === "wait") return true;
      return false;
    },
    stream() {
      if (typeof run.stream === "function") return run.stream();
      return (async function* () {})();
    },
    wait: () => run.wait(),
    async cancel() {
      if (typeof run.cancel === "function") await run.cancel();
    },
  };
}

async function disposeAgent(agent: object): Promise<void> {
  const dispose = (agent as { [Symbol.asyncDispose]?: () => Promise<void> })[
    Symbol.asyncDispose
  ];
  if (typeof dispose === "function") await dispose.call(agent);
}

export class SdkCursorRuntime implements CursorRuntime {
  readonly kind = "sdk" as const;

  async create(input: {
    slotId: string;
    model: string;
    cwd: string;
    apiKey?: string;
  }): Promise<CursorAgentHandle> {
    const { Agent } = await import("@cursor/sdk");
    const agent = await Agent.create({
      apiKey: input.apiKey,
      model: { id: input.model },
      local: { cwd: input.cwd },
    });
    log("created Cursor agent", input.slotId, agent.agentId);
    return this.wrapAgent(agent);
  }

  async resume(
    agentId: string,
    input: { model: string; cwd: string; apiKey?: string }
  ): Promise<CursorAgentHandle> {
    const { Agent } = await import("@cursor/sdk");
    const agent = await Agent.resume(agentId, {
      apiKey: input.apiKey,
      model: { id: input.model },
      local: { cwd: input.cwd },
    });
    log("resumed Cursor agent", agent.agentId);
    return this.wrapAgent(agent);
  }

  async listModels(apiKey?: string): Promise<string[]> {
    try {
      const { Cursor } = await import("@cursor/sdk");
      const listed = await Cursor.models.list({ apiKey: apiKey! });
      const ids = Array.isArray(listed)
        ? listed.map((m: { id?: string }) => m.id).filter((id): id is string => Boolean(id))
        : [];
      if (ids.length) return ids;
    } catch (err) {
      logError("Cursor.models.list failed", err);
    }
    return MODEL_CATALOG.map((m) => m.id);
  }

  private wrapAgent(agent: {
    agentId: string;
    send: (message: string, options?: object) => Promise<Parameters<typeof wrapRun>[0]>;
  }): CursorAgentHandle {
    return {
      agentId: agent.agentId,
      async send(text: string, options: SendOptions) {
        const run = await agent.send(text, {
          model: { id: options.model },
          local: options.force ? { force: true } : undefined,
        });
        return wrapRun(run);
      },
      dispose: () => disposeAgent(agent),
    };
  }
}

export class DegradedCursorRuntime implements CursorRuntime {
  readonly kind = "degraded" as const;

  async create(input: {
    slotId: string;
    model: string;
    cwd: string;
    apiKey?: string;
  }): Promise<CursorAgentHandle> {
    return new DegradedAgent(input.slotId);
  }

  async resume(
    agentId: string,
    _input: { model: string; cwd: string; apiKey?: string }
  ): Promise<CursorAgentHandle> {
    return new DegradedAgent(agentId);
  }

  async listModels(): Promise<string[]> {
    return MODEL_CATALOG.map((m) => m.id);
  }
}

class DegradedAgent implements CursorAgentHandle {
  constructor(public readonly agentId: string) {}

  async send(text: string, _options: SendOptions): Promise<CursorRunHandle> {
    const message =
      "Cursor chats unavailable. Agent slot is online in degraded mode.";
    return {
      id: `degraded-${Date.now()}`,
      supports: (op) => op === "wait" || op === "stream" || op === "cancel",
      async *stream() {
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `${message}\nPrompt was: ${text}` }],
          },
        };
      },
      async wait() {
        return { status: "error", result: message, error: { message } };
      },
      async cancel() {},
    };
  }

  async dispose() {}
}
