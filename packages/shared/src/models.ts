import type { AgentKind } from "./protocol";

export type ModelProvider = "cursor" | "codex" | "claude";

export const CORE_AGENT_IDS = ["agent-1", "agent-2", "agent-3"] as const;
export type CoreAgentId = (typeof CORE_AGENT_IDS)[number];

export interface ModelOption {
  id: string;
  label: string;
  short: string;
  provider?: ModelProvider;
  reasoningEffort?: "medium";
}

export const CODEX_MODELS: ModelOption[] = [
  { id: "gpt-6-astra", label: "GPT-6 Astra · Medium", short: "Astra · Medium", provider: "codex", reasoningEffort: "medium" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol · Medium", short: "Sol · Medium", provider: "codex", reasoningEffort: "medium" },
];

export const CODEX_AGENTS = [
  { id: "codex-astra-1", name: "Astra 1", defaultModel: "gpt-6-astra" },
  { id: "codex-astra-2", name: "Astra 2", defaultModel: "gpt-6-astra" },
  { id: "codex-sol-1", name: "Sol", defaultModel: "gpt-5.6-sol" },
];

/** Namespaced native-Claude ids never collide with Cursor's Claude offerings. */
export const CLAUDE_MODELS: ModelOption[] = [
  { id: "claude-code:claude-fable-5-1", label: "Claude Code · Fable 5.1", short: "Fable 5.1", provider: "claude" },
  { id: "claude-code:claude-fable-5", label: "Claude Code · Fable 5", short: "Fable 5", provider: "claude" },
  { id: "claude-code:claude-opus-5", label: "Claude Code · Opus 5", short: "Opus 5", provider: "claude" },
  { id: "claude-code:claude-opus-4-8", label: "Claude Code · Opus 4.8", short: "Opus 4.8", provider: "claude" },
];

/** Bare, non-Codex IDs retain the legacy Cursor namespace. Fleet validation
 * separately rejects unknown models; this helper does not choose a fallback. */
export function modelProvider(id: string): ModelProvider {
  if (id.startsWith("claude-code:")) return "claude";
  return CODEX_MODELS.some((m) => m.id === id) ? "codex" : "cursor";
}

export const MODEL_CATALOG: ModelOption[] = [
  ...CODEX_MODELS,
  ...CLAUDE_MODELS,
  { id: "claude-fable-5-1", label: "Fable", short: "Fable", provider: "cursor" },
  { id: "grok-4.6", label: "Cursor Grok 4.6", short: "Grok 4.6", provider: "cursor" },
  { id: "composer-2.5", label: "Composer 2.5", short: "Composer 2.5", provider: "cursor" },
  { id: "composer-2", label: "Composer 2", short: "Composer 2", provider: "cursor" },
  { id: "claude-opus-4-8", label: "Opus 4.8", short: "Opus", provider: "cursor" },
  { id: "auto", label: "Auto", short: "Auto", provider: "cursor" },
];

/** Older dashboard / persist IDs → current Cursor SDK ids */
export const MODEL_ALIASES: Record<string, string> = {
  "claude-fable-5-1-thinking-high": "claude-fable-5-1",
  "cursor-grok-4.6-high-fast": "grok-4.6",
  "claude-opus-4-8-thinking-high": "claude-opus-4-8",
  "composer-2.5-fast": "composer-2",
};

export const DEFAULT_MODELS: Record<CoreAgentId, string> = {
  "agent-1": "grok-4.6",
  "agent-2": "grok-4.6",
  "agent-3": "composer-2.5",
};

export const CORE_AGENTS: Array<{
  id: CoreAgentId;
  name: string;
  defaultModel: string;
}> = [
  { id: "agent-1", name: "Agent 1", defaultModel: DEFAULT_MODELS["agent-1"] },
  { id: "agent-2", name: "Agent 2", defaultModel: DEFAULT_MODELS["agent-2"] },
  { id: "agent-3", name: "Agent 3", defaultModel: DEFAULT_MODELS["agent-3"] },
];

export function canonicalModelId(id: string): string {
  return MODEL_ALIASES[id] || id;
}

export function modelLabel(id: string): string {
  const canonical = canonicalModelId(id);
  return (
    MODEL_CATALOG.find((m) => m.id === canonical || m.id === id)?.short || canonical
  );
}

export function resolveModelId(
  requested: string,
  available: string[],
  _fallback = DEFAULT_MODELS["agent-1"]
): string {
  const id = canonicalModelId(requested);
  if (!available.length) return id;
  if (available.includes(id)) return id;
  throw new Error(`Requested model ${id} is unavailable; no fallback was selected`);
}

export interface AgentDefinition {
  id: string;
  name: string;
  provider: ModelProvider;
  defaultModel: string;
  kind?: AgentKind;
}

export const DEFAULT_AGENTS: AgentDefinition[] = [
  ...CORE_AGENTS.map((agent) => ({ ...agent, provider: "cursor" as const, kind: "core" as const })),
  ...CODEX_AGENTS.map((agent) => ({ ...agent, provider: "codex" as const, kind: "extra" as const })),
  { id: "extra-1", name: "Research", provider: "cursor", defaultModel: "composer-2.5", kind: "extra" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "claude", defaultModel: "claude-code:claude-fable-5-1", kind: "claude" },
  { id: "claude-fable-5", name: "Claude Fable 5", provider: "claude", defaultModel: "claude-code:claude-fable-5", kind: "claude" },
  { id: "claude-opus-5", name: "Claude Opus 5", provider: "claude", defaultModel: "claude-code:claude-opus-5", kind: "claude" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "claude", defaultModel: "claude-code:claude-opus-4-8", kind: "claude" },
];
