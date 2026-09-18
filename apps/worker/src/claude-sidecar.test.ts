import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeSidecar } from "./claude-sidecar";
import type { ClaudeJob, ClaudeLauncher } from "./runtime";
import { waitFor } from "./test-util";

function heldJob(code = 0) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const signals: string[] = [];
  const job: ClaudeJob = {
    kill(signal = "SIGTERM") { signals.push(signal); release(); },
    async *output() { yield "Working"; await gate; yield "Final text"; },
    async wait() { await gate; return { code, signal: null }; },
  };
  return { job, release, signals };
}

describe("Claude sidecar lifecycle", () => {
  it("keeps nonzero exits as errors after the queue drains", async () => {
    const held = heldJob(1);
    const sidecar = new ClaudeSidecar({ start: () => held.job }, "claude", process.cwd(), () => {});
    sidecar.spawn("test", "queue"); held.release();
    await waitFor(() => sidecar.snapshot()?.status === "error");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sidecar.snapshot()?.status, "error");
    assert.equal(sidecar.snapshot()?.percent, 0);
  });
  it("keeps launcher and stream failures as errors", async () => {
    for (const launcher of [
      { start() { throw new Error("Could not launch"); } },
      { start(): ClaudeJob { return { kill() {}, async *output() { throw new Error("Stream failed"); }, async wait() { return { code: 0, signal: null }; } }; } },
    ] satisfies ClaudeLauncher[]) {
      const sidecar = new ClaudeSidecar(launcher, "claude", process.cwd(), () => {});
      sidecar.spawn("test", "queue");
      await waitFor(() => sidecar.snapshot()?.status === "error");
      assert.equal(sidecar.snapshot()?.percent, 0);
    }
  });
  it("waits for output to drain and preserves queued order", async () => {
    const first = heldJob(); const second = heldJob(); const prompts: string[] = [];
    const sidecar = new ClaudeSidecar({ start({ text }) { prompts.push(text); return prompts.length === 1 ? first.job : second.job; } }, "claude", process.cwd(), () => {});
    sidecar.spawn("first", "queue"); sidecar.spawn("second", "queue");
    assert.deepEqual(prompts, ["first"]);
    first.release(); await waitFor(() => prompts.length === 2);
    assert.deepEqual(prompts, ["first", "second"]);
    assert.equal(sidecar.snapshot()?.status, "running");
    second.release(); await waitFor(() => sidecar.snapshot()?.percent === 100);
    assert.equal(sidecar.snapshot()?.status, "idle");
    assert.ok(sidecar.snapshot()?.headline.includes("Final text"));
  });
  it("interrupts a stalled run without letting old completion overwrite the replacement", async () => {
    const first = heldJob(); const second = heldJob(); let starts = 0;
    // Ignore SIGTERM and leave the old wait pending until explicit release.
    first.job.kill = (signal = "SIGTERM") => { first.signals.push(signal); };
    const sidecar = new ClaudeSidecar({ start() { return ++starts === 1 ? first.job : second.job; } }, "claude", process.cwd(), () => {});
    sidecar.spawn("first", "queue"); sidecar.spawn("second", "interrupt");
    await waitFor(() => starts === 2);
    assert.ok(first.signals.includes("SIGTERM"));
    first.release(); await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sidecar.snapshot()?.status, "running");
    second.release(); await waitFor(() => sidecar.snapshot()?.percent === 100);
    sidecar.stop("interrupt"); await waitFor(() => sidecar.snapshot() === undefined);
  });
});

describe("Claude sidecar terminal disposal", () => {
  it("awaits active and already interrupted jobs, drops the queue, and cancels escalation timers", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const first = heldJob(); const second = heldJob(); let starts = 0;
    first.job.kill = signal => { first.signals.push(signal!); };
    second.job.kill = signal => { second.signals.push(signal!); };
    const sidecar = new ClaudeSidecar({ start() { return ++starts === 1 ? first.job : second.job; } }, "unused", process.cwd(), () => {});
    sidecar.spawn("first", "queue");
    sidecar.spawn("second", "interrupt");
    // Drain microtasks without relying on timers or wall-clock scheduling.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(starts, 2);
    sidecar.spawn("queued", "queue");
    let finished = false;
    const disposal = sidecar.dispose();
    assert.equal(sidecar.dispose(), disposal);
    void disposal.then(() => { finished = true; });
    sidecar.spawn("too late", "interrupt"); sidecar.stop("interrupt");
    second.release();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(finished, false, "previously interrupted job still owns cleanup");
    first.release();
    await disposal;
    t.mock.timers.tick(2000);
    assert.deepEqual(first.signals, ["SIGTERM"]);
    assert.deepEqual(second.signals, ["SIGTERM"]);
    assert.equal(starts, 2);
    assert.equal(sidecar.snapshot(), undefined);
  });

  it("escalates a stalled job and waits for actual completion", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const held = heldJob();
    held.job.kill = signal => { held.signals.push(signal!); };
    const sidecar = new ClaudeSidecar({ start: () => held.job }, "unused", process.cwd(), () => {});
    sidecar.spawn("first", "queue");
    let finished = false;
    const disposal = sidecar.dispose().then(() => { finished = true; });
    t.mock.timers.tick(1999);
    assert.deepEqual(held.signals, ["SIGTERM"]);
    t.mock.timers.tick(1);
    assert.deepEqual(held.signals, ["SIGTERM", "SIGKILL"]);
    await Promise.resolve();
    assert.equal(finished, false);
    held.release();
    await disposal;
    assert.equal(sidecar.snapshot(), undefined);
  });
});
