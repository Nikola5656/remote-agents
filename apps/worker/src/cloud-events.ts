/**
 * Maps Cloud Agents SSE events into the CLI stream-json shapes that
 * `parseCursorEvent` (events.ts) already understands, so the machine runtime
 * plugs into AgentSlot without changing the consumption pipeline.
 *
 * SSE `assistant` events are character deltas; we buffer them and flush at
 * paragraph boundaries or when a non-assistant event interrupts, so the
 * activity log gets readable prose instead of fragments.
 */

const ASSISTANT_FLUSH_CHARS = 4000;

interface ToolCallData {
  callId?: string;
  name?: string;
  status?: string;
  args?: Record<string, unknown>;
  result?: unknown;
}

export class CloudEventMapper {
  private assistantBuf = "";
  private thinkingOpen = false;
  /** args seen on tool start, re-attached on completion (SSE may omit them). */
  private readonly toolArgs = new Map<string, Record<string, unknown>>();
  private finalResult: { status: string; text?: string } | null = null;
  private errorMessage: string | null = null;

  /** Terminal payload from the `result` event, when seen. */
  get result(): { status: string; text?: string } | null {
    return this.finalResult;
  }

  get error(): string | null {
    return this.errorMessage;
  }

  push(event: string, data: unknown): unknown[] {
    const d = (data || {}) as Record<string, unknown>;
    switch (event) {
      case "assistant": {
        const out = this.closeThinking();
        this.assistantBuf += String(d.text || "");
        const flushed = this.flushAssistantAtBoundary();
        if (flushed) out.push(flushed);
        return out;
      }
      case "thinking": {
        const out = this.flushAssistant();
        this.thinkingOpen = true;
        const text = String(d.text || "");
        if (text) out.push({ type: "thinking", text });
        return out;
      }
      case "tool_call": {
        const out = [...this.flushAssistant(), ...this.closeThinking()];
        const mapped = this.mapToolCall(d as ToolCallData);
        if (mapped) out.push(mapped);
        return out;
      }
      case "result": {
        const out = [...this.flushAssistant(), ...this.closeThinking()];
        this.finalResult = {
          status: String(d.status || "FINISHED"),
          text: typeof d.text === "string" ? d.text : undefined,
        };
        return out;
      }
      case "error": {
        this.errorMessage = String(d.message || "stream error");
        return [...this.flushAssistant(), ...this.closeThinking()];
      }
      case "status":
      case "heartbeat":
      case "interaction_update":
      case "done":
      default:
        return [];
    }
  }

  /** Flush any buffered text at end of stream. */
  finish(): unknown[] {
    return [...this.flushAssistant(), ...this.closeThinking()];
  }

  private mapToolCall(data: ToolCallData): unknown | null {
    const name = data.name || "tool";
    const callId = data.callId || "";
    const completed = data.status === "completed";
    let args = data.args;
    if (callId) {
      if (args && !completed) this.toolArgs.set(callId, args);
      if (!args) args = this.toolArgs.get(callId);
      if (completed) this.toolArgs.delete(callId);
    }
    // Subagents (Task tool) → taskToolCall so parseCursorEvent tracks them.
    const key = name === "task" ? "taskToolCall" : `${name}ToolCall`;
    return {
      type: "tool_call",
      subtype: completed ? "completed" : "started",
      tool_call: { [key]: { args: args || {} } },
    };
  }

  private flushAssistant(): unknown[] {
    const text = this.assistantBuf.trim();
    this.assistantBuf = "";
    if (!text) return [];
    return [assistantEvent(text)];
  }

  /** Flush only up to the last paragraph break (keeps deltas coherent). */
  private flushAssistantAtBoundary(): unknown | null {
    const idx = this.assistantBuf.lastIndexOf("\n\n");
    if (idx === -1 && this.assistantBuf.length < ASSISTANT_FLUSH_CHARS) return null;
    const cut = idx !== -1 ? idx : this.assistantBuf.length;
    const text = this.assistantBuf.slice(0, cut).trim();
    this.assistantBuf = this.assistantBuf.slice(cut);
    if (!text) return null;
    return assistantEvent(text);
  }

  private closeThinking(): unknown[] {
    if (!this.thinkingOpen) return [];
    this.thinkingOpen = false;
    // A thinking event without text is parsed as thinkingEnd.
    return [{ type: "thinking" }];
  }
}

function assistantEvent(text: string): unknown {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

/** FINISHED/ERROR/CANCELLED/EXPIRED → runtime result status. */
export function mapRunStatus(status: string): "finished" | "error" | "cancelled" {
  const s = status.toUpperCase();
  if (s === "FINISHED") return "finished";
  if (s === "CANCELLED") return "cancelled";
  return "error";
}
