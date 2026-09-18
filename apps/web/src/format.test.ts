import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSnapshot } from "@remote-agents/shared";
import {
  isClaudeSidecar,
  mergeAgentLists,
  usesLegacyCoreSlots,
} from "./format.js";

function snap(
  partial: Partial<AgentSnapshot> & Pick<AgentSnapshot, "id" | "name">
): AgentSnapshot {
  const { id, name, ...rest } = partial;
  return {
    kind: "extra",
    model: "claude-fable-5-1",
    availableModels: [],
    status: "idle",
    percent: 0,
    headline: "",
    summary: "",
    lastActions: [],
    outputMode: "condensed",
    queueLength: 0,
    queue: [],
    condensedLog: "",
    fullLog: "",
    updatedAt: Date.now(),
    ...rest,
    id,
    name,
  };
}

describe("mergeAgentLists", () => {
  it("keeps native Claude fleet slots and drops parentId sidecars", () => {
    const merged = mergeAgentLists([
      snap({
        id: "claude-fable-5-1",
        name: "Claude Fable 5.1",
        kind: "claude",
        model: "claude-code:claude-fable-5-1",
      }),
      snap({
        id: "sidecar",
        name: "Sidecar",
        kind: "claude",
        parentId: "agent-1",
        model: "claude-code:claude-fable-5-1",
      }),
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.id, "claude-fable-5-1");
    assert.equal(
      isClaudeSidecar({ id: "x", name: "x", parentId: "agent-1" } as AgentSnapshot),
      true
    );
  });

  it("does not inject legacy core placeholders for custom fleet ids", () => {
    const merged = mergeAgentLists([
      snap({ id: "research", name: "Research", model: "claude-fable-5-1" }),
      snap({ id: "codex-astra-1", name: "Astra 1", model: "gpt-6-astra" }),
    ]);
    assert.equal(usesLegacyCoreSlots(merged), false);
    assert.deepEqual(
      merged.map((agent) => agent.id),
      ["research", "codex-astra-1"]
    );
    assert.ok(
      !merged.some((agent) => agent.id === "agent-1" && agent.status === "offline")
    );
  });

  it("pads missing legacy core slots when worker still reports them", () => {
    const merged = mergeAgentLists([
      snap({
        id: "agent-1",
        name: "Agent 1",
        kind: "core",
        model: "claude-fable-5-1",
      }),
      snap({ id: "research", name: "Research", model: "claude-fable-5-1" }),
    ]);
    assert.equal(merged.length, 4);
    assert.equal(merged[0]?.id, "agent-1");
    assert.equal(merged[1]?.id, "agent-2");
    assert.equal(merged[1]?.status, "offline");
    assert.equal(merged[3]?.id, "research");
  });
});
