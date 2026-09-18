export interface SendOptions {
  model: string;
  force?: boolean;
}

/**
 * Best-effort mirror of a conversation exchange into the Cursor IDE store so
 * the agent chats show a real transcript. Implemented by ComposerSidebar.
 */
export interface TranscriptMirror {
  /** Writes the user bubble + an empty assistant bubble; returns the assistant bubbleId. */
  startExchange(composerId: string, userText: string): string | null;
  /** Replaces the assistant bubble text while the run streams. */
  updateExchange(composerId: string, assistantBubbleId: string, text: string): void;
  /** Final assistant text + header/subtitle refresh at run end. */
  finishExchange(
    composerId: string,
    assistantBubbleId: string,
    text: string,
    subtitle?: string
  ): void;
}

export interface CursorRunResult {
  status: "running" | "finished" | "error" | "cancelled" | string;
  result?: string;
  error?: { message?: string };
}

export interface CursorRunHandle {
  id: string;
  /** Per-run mirror for a CLI fallback from an IDE runtime. */
  transcript?: TranscriptMirror;
  supports(op: string): boolean;
  stream(): AsyncIterable<unknown>;
  wait(): Promise<CursorRunResult>;
  cancel(): Promise<void>;
}

export interface CursorAgentHandle {
  agentId: string;
  send(text: string, options: SendOptions): Promise<CursorRunHandle>;
  dispose(): Promise<void>;
}

export type CursorRuntimeKind = "claude" | "codex" | "cli" | "sdk" | "machine" | "bridge" | "degraded" | "mock";

export interface CursorRuntime {
  readonly kind: CursorRuntimeKind;
  /** Optional IDE transcript mirror (CLI runtime exposes the composer sidebar). */
  readonly transcript?: TranscriptMirror | null;
  /** Whether a persisted agent id belongs to this runtime and can be resumed. */
  isResumableId?(id: string): boolean;
  create(input: {
    slotId: string;
    name?: string;
    model: string;
    cwd: string;
    apiKey?: string;
  }): Promise<CursorAgentHandle>;
  resume(
    agentId: string,
    input: { model: string; cwd: string; apiKey?: string; name?: string; slotId?: string }
  ): Promise<CursorAgentHandle>;
  listModels(apiKey?: string): Promise<string[]>;
}

export interface ClaudeJob {
  kill(signal?: NodeJS.Signals): void;
  output(): AsyncIterable<string>;
  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface ClaudeLauncher {
  start(input: { bin: string; text: string; cwd: string }): ClaudeJob;
}
