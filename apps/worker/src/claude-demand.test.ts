import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentPool } from "./agent-pool";
import { MockClaudeLauncher, MockCursorRuntime } from "./mock-runtime";
import { testConfig, waitFor } from "./test-util";

describe("claude on demand", () => {
  it("does not spawn Claude unless spawn_claude is received", async () => {
    const runtime = new MockCursorRuntime();
    const claude = new MockClaudeLauncher();
    const pool = new AgentPool({
      config: testConfig(),
      runtime,
      claude,
    });
    await pool.start();

    await pool.dispatch({
      type: "command",
      commandId: "c1",
      agentId: "agent-2",
      mode: "queue",
      text: "do work without claude",
    });
    await waitFor(() => runtime.sends.length === 1);
    assert.equal(claude.spawns.length, 0);
    assert.equal(pool.get("agent-2")!.snapshot().claude, undefined);

    await pool.dispatch({
      type: "set_model",
      commandId: "m1",
      agentId: "agent-2",
      model: "composer-2.5-fast",
    });
    assert.equal(claude.spawns.length, 0);

    await pool.dispatch({
      type: "spawn_agent",
      commandId: "s1",
      name: "Extra",
      model: "composer-2.5",
    });
    assert.equal(claude.spawns.length, 0);

    await pool.dispatch({
      type: "spawn_claude",
      commandId: "cl1",
      agentId: "agent-2",
      text: "review this change",
      mode: "queue",
    });
    await waitFor(() => claude.spawns.length === 1);
    assert.equal(claude.spawns[0].text, "review this change");
    await waitFor(() => pool.get("agent-2")!.snapshot().claude?.attached === true);
    await pool.dispose();
  });
});
