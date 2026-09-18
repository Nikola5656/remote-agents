import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  STALE_RUN_MS,
  buildExecutionView,
  executionPhase,
  executionStatusLabel,
  fleetCounts,
  resolveAgentProvider,
  type ExecutionAgent,
} from "./execution.js";

function agent(partial: Partial<ExecutionAgent> = {}): ExecutionAgent {
  return {
    model: "claude-fable-5-1",
    status: "idle",
    headline: "Idle",
    queueLength: 0,
    updatedAt: Date.now(),
    ...partial,
  };
}

describe("execution", () => {
  it("maps lifecycle statuses to execution phases", () => {
    assert.equal(executionPhase("starting"), "connecting");
    assert.equal(executionPhase("queued"), "queued");
    assert.equal(executionPhase("running"), "running");
    assert.equal(executionPhase("idle"), "ready");
    assert.equal(executionPhase("error"), "error");
    assert.equal(executionPhase("offline"), "offline");
    assert.equal(executionStatusLabel("connecting"), "Connecting");
  });

  it("detects Claude Code providers from model id or snapshot provider", () => {
    assert.equal(
      resolveAgentProvider({ ...agent(), model: "claude-code:claude-fable-5-1" }),
      "claude"
    );
    assert.equal(
      resolveAgentProvider({
        ...agent(),
        model: "claude-fable-5-1",
        provider: "claude",
      }),
      "claude"
    );
    assert.equal(resolveAgentProvider({ ...agent(), model: "gpt-6-astra" }), "codex");
  });

  it("does not surface numeric activity estimates in the execution view", () => {
    const view = buildExecutionView(
      agent({ status: "running", toolCount: 4, runStartedAt: Date.now() - 30_000 }),
      Date.now()
    );
    assert.equal(view.toolCount, 4);
    assert.equal(view.elapsedMs !== null, true);
    assert.equal("activityEstimate" in view, false);
  });

  it("flags stale runs with no recent stream events", () => {
    const now = 1_000_000;
    const view = buildExecutionView(
      agent({
        status: "running",
        runStartedAt: now - 120_000,
        lastEventAt: now - STALE_RUN_MS - 1_000,
        headline: "Working…",
      }),
      now
    );
    assert.equal(view.isStale, true);
    assert.match(view.headline, /no stream updates/);
  });

  it("summarizes fleet counts including provider totals", () => {
    const counts = fleetCounts([
      agent({ status: "starting", model: "claude-code:claude-fable-5-1" }),
      agent({ status: "queued", queueLength: 2, model: "gpt-6-astra" }),
      agent({ status: "error" }),
    ]);
    assert.equal(counts.connecting, 1);
    assert.equal(counts.queued, 1);
    assert.equal(counts.attention, 1);
    assert.equal(counts.instructionsQueued, 2);
    assert.equal(counts.claude, 1);
    assert.equal(counts.codex, 1);
  });
});
