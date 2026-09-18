import type { AgentSnapshot } from "@remote-agents/shared";
import { resolveAgentProvider } from "../execution";

import type { ProviderSelection } from "../provider-selection";
export type { ProviderSelection } from "../provider-selection";

const OPTIONS: Array<{ value: ProviderSelection; label: string }> = [
  { value: "all", label: "All agents" },
  { value: "cursor", label: "Cursor" },
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude Code" },
];

export function ProviderFilter({ agents, value, onChange }: {
  agents: AgentSnapshot[];
  value: ProviderSelection;
  onChange: (value: ProviderSelection) => void;
}) {
  return (
    <div className="fleet-filters" role="group" aria-label="Filter agents by provider">
      {OPTIONS.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}>
          {option.label} ({agents.filter(agent => option.value === "all" || resolveAgentProvider(agent) === option.value).length})
        </button>
      ))}
    </div>
  );
}
