import path from "node:path";

export interface ParsedEvent {
  /** Clean text for the activity log. */
  text?: string;
  /** Assistant message text (mirrored into the IDE chat bubble). */
  assistantText?: string;
  /** Tool action label, e.g. "edit PONG.md" (counted as a tool call). */
  action?: string;
  /** Partial thinking delta; accumulate until thinkingEnd. */
  thinkingDelta?: string;
  /** Marks the end of a thinking block. */
  thinkingEnd?: boolean;
  /** A parallel subagent (Task tool) started with this name. */
  subagentStart?: string;
  /** A parallel subagent finished. */
  subagentEnd?: string;
}

interface ToolCallShape {
  [key: string]: { args?: Record<string, unknown> } | unknown;
}

/** "editToolCall" -> "edit", "shellToolCall" -> "shell" */
function toolLabel(toolCall: ToolCallShape): string {
  const key = Object.keys(toolCall).find((k) => k.endsWith("ToolCall"));
  if (!key) return "tool";
  const name = key.slice(0, -"ToolCall".length) || "tool";
  const entry = toolCall[key] as { args?: Record<string, unknown> } | undefined;
  const args = entry?.args || {};
  const target =
    typeof args.path === "string"
      ? path.basename(args.path)
      : typeof args.command === "string"
        ? String(args.command).slice(0, 40)
        : typeof args.pattern === "string"
          ? String(args.pattern).slice(0, 40)
          : "";
  return target ? `${name} ${target}` : name;
}

export function parseCursorEvent(event: unknown): ParsedEvent {
  if (!event || typeof event !== "object") return {};
  const ev = event as {
    type?: string;
    subtype?: string;
    text?: string;
    name?: string;
    model?: string;
    detail?: string;
    status?: string;
    tool_call?: ToolCallShape;
    message?: { content?: Array<{ type?: string; text?: string }> };
  };

  if (ev.type === "system" && ev.subtype === "api_retry") return { text: typeof ev.detail === "string" ? ev.detail.slice(0, 240) : "Claude Code is retrying an API request" };

  if (ev.type === "system" && ev.subtype === "init" && ev.model) return { text: `Model: ${ev.model}` };

  if (ev.type === "assistant" && ev.message?.content) {
    const text = ev.message.content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text as string)
      .join("");
    return { text, assistantText: text };
  }

  if (ev.type === "thinking") {
    if (typeof ev.text === "string" && ev.text) return { thinkingDelta: ev.text };
    return { thinkingEnd: true };
  }

  if (ev.type === "tool_call") {
    // Parallel subagents arrive as taskToolCall with a description arg.
    const task = ev.tool_call?.taskToolCall as
      | { args?: { description?: string } }
      | undefined;
    if (task) {
      const name = task.args?.description || "subagent";
      if (ev.subtype === "completed" || ev.status === "completed") {
        return { subagentEnd: name, text: `⧉ subagent ${name} finished` };
      }
      return {
        subagentStart: name,
        action: `subagent ${name}`,
        text: `⧉ subagent ${name} started`,
      };
    }
    const label = ev.tool_call ? toolLabel(ev.tool_call) : ev.name || "tool";
    if (ev.subtype === "completed" || ev.status === "completed") {
      return { text: `✓ ${label}` };
    }
    return { action: label, text: `→ ${label}` };
  }

  if (ev.type === "task" && ev.text) {
    return { text: ev.text };
  }

  return {};
}
