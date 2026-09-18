import test from "node:test";
import assert from "node:assert/strict";
import { emptyAgent, emptyHealth, MODEL_CATALOG } from "@remote-agents/shared";
import { AgentStore } from "./store";

test("seeds provider metadata and preserves incremental fleet state", () => {
  const store = new AgentStore();
  assert.equal(store.getAgent("codex-sol-1")?.provider, "codex");
  assert.equal(store.getAgent("agent-1")?.provider, "cursor");

  const dynamic = {
    ...emptyAgent("dynamic-1", "Dynamic", "new-provider-model", "extra"),
    provider: "cursor" as const,
    availableModels: ["new-provider-model"],
    status: "idle" as const,
  };
  store.applySnapshot(emptyHealth(), [dynamic]);
  assert.equal(store.getAgent("dynamic-1")?.model, "new-provider-model");
  assert.ok(store.listModels(MODEL_CATALOG).some((model) => model.id === "new-provider-model"));

  store.applyAgent({ ...dynamic, headline: "Incremental update" });
  store.applyHeartbeat({ ...emptyHealth(), ok: true, issues: [] }, []);
  assert.equal(store.isWorkerConnected(), true);
  assert.equal(store.getAgent("dynamic-1")?.headline, "Incremental update");
  assert.equal(store.getAgent("dynamic-1")?.status, "idle");

  // A later full inventory still owns pruning semantics.
  store.applySnapshot(emptyHealth(), []);
  assert.equal(store.getAgent("dynamic-1"), undefined);
  assert.equal(store.listAgents().length, 0);
});
