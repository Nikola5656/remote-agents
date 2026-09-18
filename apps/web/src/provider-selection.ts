import { useState } from "react";

export type ProviderSelection = "all" | "cursor" | "codex" | "claude";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
const KEY = "remote-agents.provider-filter";
const browserStorage = () => window.localStorage;

export function readProviderSelection(storage: () => PreferenceStorage = browserStorage): ProviderSelection {
  try {
    const value = storage().getItem(KEY);
    return value === "cursor" || value === "codex" || value === "claude" ? value : "all";
  } catch { return "all"; }
}

export function saveProviderSelection(value: ProviderSelection, storage: () => PreferenceStorage = browserStorage): void {
  try { storage().setItem(KEY, value); } catch { /* Filtering still works when storage is blocked. */ }
}

/** Share the same preference across Overview, Agents, navigation and reloads. */
export function useProviderSelection() {
  const [value, setValue] = useState<ProviderSelection>(() => readProviderSelection());
  return [value, (next: ProviderSelection) => {
    setValue(next);
    saveProviderSelection(next);
  }] as const;
}
