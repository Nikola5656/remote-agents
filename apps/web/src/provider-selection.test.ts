import assert from "node:assert/strict";
import test from "node:test";
import { readProviderSelection, saveProviderSelection, type ProviderSelection } from "./provider-selection.js";

test("provider selection survives fresh page instances and an explicit reset to all", () => {
  const values = new Map<string, string>();
  const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  assert.equal(readProviderSelection(storage), "all");
  for (const value of ["claude", "codex", "cursor", "all"] as ProviderSelection[]) {
    saveProviderSelection(value, storage);
    assert.equal(readProviderSelection(storage), value);
  }
  storage().setItem("remote-agents.provider-filter", "removed-provider");
  assert.equal(readProviderSelection(storage), "all");
});

test("unavailable browser storage never prevents filtering", () => {
  const blocked = () => { throw new Error("Storage disabled"); };
  assert.equal(readProviderSelection(blocked), "all");
  assert.doesNotThrow(() => saveProviderSelection("claude", blocked));
});
