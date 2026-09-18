import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AgentPool } from "./agent-pool";
import { MockClaudeLauncher, MockCursorRuntime } from "./mock-runtime";
import { testConfig, waitFor } from "./test-util";

const prevDisableReportHints = process.env.REMOTE_AGENTS_DISABLE_REPORT_HINTS;

beforeEach(() => {
  process.env.REMOTE_AGENTS_DISABLE_REPORT_HINTS = "1";
});

afterEach(() => {
  process.env.REMOTE_AGENTS_DISABLE_REPORT_HINTS = prevDisableReportHints;
});

async function makePool(runtime: MockCursorRuntime, claude: MockClaudeLauncher) {
  const pool = new AgentPool({
    config: testConfig(),
    runtime,
    claude,
  });
  await pool.start();
  return pool;
}

describe("queue", () => {
  it("waits until the current job finishes before starting the next", async () => {
    const runtime = new MockCursorRuntime();
    const claude = new MockClaudeLauncher();
    const pool = await makePool(runtime, claude);
    const hold = runtime.holdNext();

    await pool.dispatch({
      type: "command",
      commandId: "c1",
      agentId: "agent-1",
      mode: "queue",
      text: "first",
    });
    await waitFor(() => runtime.sends.length === 1);
    assert.equal(runtime.sends[0].text, "first");

    await pool.dispatch({
      type: "command",
      commandId: "c2",
      agentId: "agent-1",
      mode: "queue",
      text: "second",
    });
    await waitFor(() => pool.get("agent-1")!.snapshot().queueLength === 1);
    assert.equal(runtime.sends.length, 1);
    assert.equal(pool.get("agent-1")!.snapshot().status, "running");

    hold.release();
    await waitFor(() => runtime.sends.length === 2);
    assert.equal(runtime.sends[1].text, "second");
    assert.ok(!runtime.sends[1].force);
    await pool.dispose();
  });
});

describe("interrupt", () => {
  it("cancels the current run and starts the new prompt immediately", async () => {
    const runtime = new MockCursorRuntime();
    const claude = new MockClaudeLauncher();
    const pool = await makePool(runtime, claude);
    const first = runtime.holdNext();
    runtime.holdNext();

    await pool.dispatch({
      type: "command",
      commandId: "c1",
      agentId: "agent-1",
      mode: "queue",
      text: "slow",
    });
    await waitFor(() => runtime.sends.length === 1);

    await pool.dispatch({
      type: "command",
      commandId: "c2",
      agentId: "agent-1",
      mode: "interrupt",
      text: "urgent",
    });

    await waitFor(() => runtime.sends.length === 2);
    assert.equal(runtime.sends[1].text, "urgent");
    assert.equal(runtime.sends[1].force, true);
    assert.equal(runtime.cancels, 1);
    assert.equal(first.cancelled(), true);
    await pool.dispose();
  });
});

describe("telemetry", () => {
  it("reports runStartedAt/toolCount/lastEventAt and mirrors the exchange", async () => {
    const runtime = new MockCursorRuntime();
    const claude = new MockClaudeLauncher();
    const pool = await makePool(runtime, claude);
    const hold = runtime.holdNext();

    const idle = pool.get("agent-1")!.snapshot();
    assert.equal(idle.runStartedAt, undefined);
    assert.equal(idle.percent, 0);

    await pool.dispatch({
      type: "command",
      commandId: "t1",
      agentId: "agent-1",
      mode: "queue",
      text: "telemetry work",
    });
    await waitFor(() => (pool.get("agent-1")!.snapshot().toolCount ?? 0) >= 1);
    const running = pool.get("agent-1")!.snapshot();
    assert.equal(running.status, "running");
    assert.equal(typeof running.runStartedAt, "number");
    assert.equal(typeof running.lastEventAt, "number");
    assert.equal(running.toolCount, 1);
    assert.ok(running.percent >= 3 && running.percent < 100);

    hold.release();
    await waitFor(() => pool.get("agent-1")!.snapshot().status === "idle");
    const done = pool.get("agent-1")!.snapshot();
    assert.equal(done.runStartedAt, undefined);
    assert.equal(done.percent, 100);

    // Transcript mirroring: user bubble at start, final assistant text at end.
    const starts = runtime.exchanges.filter((e) => e.kind === "start");
    const finishes = runtime.exchanges.filter((e) => e.kind === "finish");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].text, "telemetry work");
    assert.equal(finishes.length, 1);
    assert.ok(finishes[0].text.includes("Working on the request."));
    await pool.dispose();
  });
});

describe("stale Cursor run", () => {
  it("retries a queued send with force when the SDK still has an active run", async () => {
    const runtime = new MockCursorRuntime();
    runtime.staleFailuresLeft = 1;
    const claude = new MockClaudeLauncher();
    const pool = await makePool(runtime, claude);

    await pool.dispatch({
      type: "command",
      commandId: "c1",
      agentId: "agent-1",
      mode: "queue",
      text: "recover",
    });
    await waitFor(() => runtime.sends.length === 1);
    assert.equal(runtime.sends[0].text, "recover");
    assert.equal(runtime.sends[0].force, true);
    await waitFor(() => pool.get("agent-1")!.snapshot().status === "idle");
    await pool.dispose();
  });
});

describe("standalone stop and queue removal", () => {
  it("stops the observed run without replacement and preserves queued work in order", async () => {
    const runtime = new MockCursorRuntime();
    const pool = await makePool(runtime, new MockClaudeLauncher());
    const first = runtime.holdNext();
    runtime.holdNext();
    try {
      await pool.dispatch({ type: "command", commandId: "start", agentId: "agent-1", mode: "queue", text: "first" });
      await waitFor(() => Boolean(pool.get("agent-1")!.snapshot().runId));
      await pool.dispatch({ type: "command", commandId: "next", agentId: "agent-1", mode: "queue", text: "second" });
      await pool.dispatch({ type: "command", commandId: "last", agentId: "agent-1", mode: "queue", text: "third" });
      const runId = pool.get("agent-1")!.snapshot().runId!;
      await assert.rejects(pool.dispatch({ type: "stop_agent", commandId: "stale", agentId: "agent-1", runId: "old-run" }), /no longer active/);
      assert.equal(runtime.cancels, 0);
      await pool.dispatch({ type: "stop_agent", commandId: "stop", agentId: "agent-1", runId });
      await waitFor(() => runtime.sends.length === 2);
      assert.equal(first.cancelled(), true);
      assert.equal(runtime.sends[1].text, "second");
      assert.deepEqual(pool.get("agent-1")!.snapshot().queue.map((item) => item.text), ["third"]);
      await assert.rejects(pool.dispatch({ type: "stop_agent", commandId: "stale-again", agentId: "agent-1", runId }), /no longer active/);
      assert.equal(runtime.cancels, 1);
    } finally { await pool.dispose(); }
  });

  it("becomes idle after a standalone stop with no queued work", async () => {
    const runtime = new MockCursorRuntime();
    const pool = await makePool(runtime, new MockClaudeLauncher());
    runtime.holdNext();
    try {
      await pool.dispatch({ type: "command", commandId: "start", agentId: "agent-1", mode: "queue", text: "first" });
      await waitFor(() => Boolean(pool.get("agent-1")!.snapshot().runId));
      const runId = pool.get("agent-1")!.snapshot().runId!;
      await pool.dispatch({ type: "stop_agent", commandId: "stop", agentId: "agent-1", runId });
      await waitFor(() => pool.get("agent-1")!.snapshot().status === "idle");
      assert.equal(pool.get("agent-1")!.snapshot().headline, "Cancelled");
      assert.equal(runtime.sends.length, 1);
      assert.equal(pool.get("agent-1")!.snapshot().queueLength, 0);
    } finally { await pool.dispose(); }
  });

  it("removes only the requested queued instruction without interrupting current work", async () => {
    const runtime = new MockCursorRuntime();
    const pool = await makePool(runtime, new MockClaudeLauncher());
    const first = runtime.holdNext();
    runtime.holdNext();
    try {
      for (const text of ["first", "remove me", "keep me"]) {
        await pool.dispatch({ type: "command", commandId: text, agentId: "agent-1", mode: "queue", text });
      }
      await waitFor(() => Boolean(pool.get("agent-1")!.snapshot().runId));
      const [removed, retained] = pool.get("agent-1")!.snapshot().queue;
      await pool.dispatch({ type: "remove_queued_instruction", commandId: "remove", agentId: "agent-1", instructionId: removed.id });
      assert.deepEqual(pool.get("agent-1")!.snapshot().queue.map((item) => item.id), [retained.id]);
      assert.equal(runtime.cancels, 0);
      await assert.rejects(pool.dispatch({ type: "remove_queued_instruction", commandId: "repeat", agentId: "agent-1", instructionId: removed.id }), /no longer queued/);
      first.release();
      await waitFor(() => runtime.sends.length === 2);
      assert.equal(runtime.sends[1].text, "keep me");
      await assert.rejects(pool.dispatch({ type: "remove_queued_instruction", commandId: "too-late", agentId: "agent-1", instructionId: retained.id }), /may have started/);
      assert.equal(runtime.cancels, 0);
    } finally { await pool.dispose(); }
  });

  it("keeps the scheduler paused until cancellation settles and propagates cancellation failures", async () => {
    const runtime = new MockCursorRuntime();
    const create = runtime.create.bind(runtime);
    let fail = true;
    let cancelSupported = false;
    let releaseCancel!: () => void;
    const cancelSettled = new Promise<void>((resolve) => { releaseCancel = resolve; });
    runtime.create = async (input) => {
      const agent = await create(input);
      return { ...agent, send: async (text, options) => {
        const run = await agent.send(text, options);
        return { id: run.id, supports: (op) => op === "cancel" ? cancelSupported : run.supports(op), stream: () => run.stream(), wait: () => run.wait(), cancel: async () => {
          if (fail) throw new Error("Provider refused cancellation");
          await run.cancel();
          await cancelSettled;
        } };
      } };
    };
    const pool = await makePool(runtime, new MockClaudeLauncher());
    runtime.holdNext();
    runtime.holdNext();
    try {
      await pool.dispatch({ type: "command", commandId: "start", agentId: "agent-1", mode: "queue", text: "first" });
      await waitFor(() => Boolean(pool.get("agent-1")!.snapshot().runId));
      await pool.dispatch({ type: "command", commandId: "next", agentId: "agent-1", mode: "queue", text: "second" });
      const runId = pool.get("agent-1")!.snapshot().runId!;
      await assert.rejects(pool.dispatch({ type: "stop_agent", commandId: "unsupported", agentId: "agent-1", runId }), /cannot stop/);
      cancelSupported = true;
      await assert.rejects(pool.dispatch({ type: "stop_agent", commandId: "failed", agentId: "agent-1", runId }), /Provider refused/);
      assert.equal(pool.get("agent-1")!.snapshot().status, "running");
      assert.equal(runtime.cancels, 0);
      fail = false;
      const stop = pool.dispatch({ type: "stop_agent", commandId: "accepted", agentId: "agent-1", runId });
      await waitFor(() => pool.get("agent-1")!.snapshot().status === "idle");
      assert.equal(runtime.sends.length, 1);
      assert.equal(pool.get("agent-1")!.snapshot().queueLength, 1);
      releaseCancel();
      await stop;
      await waitFor(() => runtime.sends.length === 2);
    } finally { fail = false; cancelSupported = true; releaseCancel(); await pool.dispose(); }
  });
});
