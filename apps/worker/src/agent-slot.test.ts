import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AgentSlot } from "./agent-slot";
import { AgentStore } from "./persist";
import type { CursorAgentHandle, CursorRunHandle, CursorRunResult, SendOptions } from "./runtime";
import { MockClaudeLauncher, MockCursorRuntime } from "./mock-runtime";
import { testConfig, waitFor } from "./test-util";

class StreamMockRuntime extends MockCursorRuntime {
  constructor(private readonly textBySend: (string | ((prompt: string) => string))[]) {
    super();
  }

  private makeStreamingAgent(agentId: string): CursorAgentHandle {
    const runtime = this;
    return {
      agentId,
      async send(text: string, options: SendOptions): Promise<CursorRunHandle> {
        runtime.sends.push({ text, model: options.model, force: options.force, agentId });
        const nextReply = runtime.textBySend[runtime.sends.length - 1] ?? "fallback";
        const reply = typeof nextReply === "function" ? nextReply(text) : nextReply;
        return {
          id: `run-${runtime.sends.length}`,
          supports: (op: string) => op === "cancel" || op === "wait" || op === "stream",
          async *stream() {
            yield {
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text: reply }],
              },
            };
          },
          wait: async (): Promise<CursorRunResult> => ({
            status: "finished",
            result: "",
          }),
          cancel: async () => undefined,
        };
      },
      async dispose() {},
    };
  }

  override async create(input: {
    slotId: string;
    model: string;
    cwd: string;
    apiKey?: string;
  }): Promise<CursorAgentHandle> {
    this.creates += 1;
    return this.makeStreamingAgent(`mock-${input.slotId}`);
  }

  override async resume(agentId: string): Promise<CursorAgentHandle> {
    return this.makeStreamingAgent(agentId);
  }
}

function makeSlot(runtime: MockCursorRuntime, cwd: string): AgentSlot {
  const cfg = testConfig();
  const store = new AgentStore(path.join(cfg.dataDir, "agents.json"));
  return new AgentSlot({
    id: "agent-1",
    name: "Agent 1",
    kind: "core",
    model: "composer-2.5",
    cwd,
    apiKey: "key",
    runtime,
    claude: new MockClaudeLauncher(),
    claudeBin: "claude",
    availableModels: ["composer-2.5"],
    store,
    onUpdate: () => undefined,
  });
}

describe("agent slot reports", () => {
  it("recognizes the exact per-run report written through Bash without a typed write event", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ra-slot-bash-report-"));
    const runtime = new StreamMockRuntime([(prompt) => {
      const reportPath = prompt.match(/For this run, save the report to `([^`]+)`/)?.[1];
      assert.ok(reportPath);
      fs.mkdirSync(path.join(cwd, "reports"), { recursive: true });
      fs.writeFileSync(path.join(cwd, reportPath), "# Authored report\nVerified.");
      return `Done: ${reportPath}`;
    }]);
    const slot = makeSlot(runtime, cwd);
    try {
      await slot.boot();
      slot.handleInstruction("Inspect the document folder", "queue");
      await waitFor(() => slot.snapshot().status === "idle");
      const names = fs.readdirSync(path.join(cwd, "reports"));
      assert.equal(names.length, 1);
      assert.match(names[0], /^report-inspect-the-document-folder-/);
      assert.equal(slot.snapshot().lastInstruction, "Inspect the document folder");
      assert.match(slot.snapshot().lastActions.join(" "), /report: reports\/report-inspect/);
    } finally { await slot.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it("prepends the report instruction to provider prompts", async () => {
    const runtime = new MockCursorRuntime();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ra-slot-"));
    const slot = makeSlot(runtime, cwd);
    await slot.boot();
    slot.handleInstruction("ship it", "queue");
    await waitFor(() => runtime.sends.length === 1);
    assert.match(runtime.sends[0].text, /reports\//);
    assert.match(runtime.sends[0].text, /ship it/);
    await slot.dispose();
  });

  it("materializes a default report when the run ends without a markdown file", async () => {
    const runtime = new StreamMockRuntime(["A".repeat(120)]);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ra-slot-report-"));
    const slot = makeSlot(runtime, cwd);
    await slot.boot();
    slot.handleInstruction("write a long status update", "queue");
    await waitFor(() => slot.snapshot().status === "idle");
    const reportsDir = path.join(cwd, "reports");
    assert.ok(fs.existsSync(reportsDir));
    const files = fs.readdirSync(reportsDir).filter((name) => name.endsWith(".md"));
    assert.ok(files.length >= 1);
    const content = fs.readFileSync(path.join(reportsDir, files[0]), "utf8");
    assert.match(content, /auto-generated/);
    assert.match(slot.snapshot().lastActions.join(" "), /report:/);
    await slot.dispose();
  });

  it("materializes short finished responses instead of skipping them", async () => {
    const runtime = new StreamMockRuntime(["ok"]);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ra-slot-short-"));
    const slot = makeSlot(runtime, cwd);
    await slot.boot();
    slot.handleInstruction("quick ack", "queue");
    await waitFor(() => slot.snapshot().status === "idle");
    const reportsDir = path.join(cwd, "reports");
    const files = fs.readdirSync(reportsDir).filter((name) => name.endsWith(".md"));
    assert.equal(files.length, 1);
    const content = fs.readFileSync(path.join(reportsDir, files[0]), "utf8");
    assert.match(content, /ok/);
    await slot.dispose();
  });

  it("uses only the current run transcript for each report", async () => {
    const runtime = new StreamMockRuntime(["RUN_ONE_UNIQUE_MARKER", "RUN_TWO_UNIQUE_MARKER"]);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ra-slot-runs-"));
    const slot = makeSlot(runtime, cwd);
    await slot.boot();
    slot.handleInstruction("first task", "queue");
    await waitFor(() => slot.snapshot().status === "idle");
    slot.handleInstruction("second task", "queue");
    await waitFor(() => runtime.sends.length === 2);
    await waitFor(() => slot.snapshot().status === "idle");

    const reportsDir = path.join(cwd, "reports");
    const files = fs
      .readdirSync(reportsDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => ({
        name,
        mtime: fs.statSync(path.join(reportsDir, name)).mtimeMs,
        content: fs.readFileSync(path.join(reportsDir, name), "utf8"),
      }))
      .sort((a, b) => a.mtime - b.mtime);
    assert.equal(files.length, 2);
    assert.match(files[0].content, /RUN_ONE_UNIQUE_MARKER/);
    assert.doesNotMatch(files[0].content, /RUN_TWO_UNIQUE_MARKER/);
    assert.match(files[1].content, /RUN_TWO_UNIQUE_MARKER/);
    await slot.dispose();
  });

  it("surfaces artifact failures without changing the run status", async () => {
    const runtime = new StreamMockRuntime(["done"]);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ra-slot-artifact-fail-"));
    fs.writeFileSync(path.join(cwd, "reports"), "not a directory", "utf8");
    const slot = makeSlot(runtime, cwd);
    await slot.boot();
    slot.handleInstruction("finish", "queue");
    await waitFor(() => slot.snapshot().status === "idle");
    const snap = slot.snapshot();
    assert.equal(snap.status, "idle");
    assert.match(snap.lastActions.join(" "), /artifact failed:/);
    assert.doesNotMatch(snap.lastActions.join(" "), /report:/);
    await slot.dispose();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function lifecycleSlot(runtime: import("./runtime").CursorRuntime, claude = new MockClaudeLauncher() as import("./runtime").ClaudeLauncher, persisted?: import("./persist").PersistedSlot) {
  let saves = 0;
  let updates = 0;
  const store = { load: () => ({ agents: {} }), save: () => { saves++; } } as unknown as AgentStore;
  const slot = new AgentSlot({ id: "probe", name: "Probe", kind: "core", model: "composer-2.5", cwd: os.tmpdir(), apiKey: "synthetic", runtime, claude, claudeBin: "unused", availableModels: [], store, persisted, onUpdate: () => { updates++; } });
  return { slot, counts: () => ({ saves, updates }) };
}

function fakeHandle(onDispose: () => Promise<void>): CursorAgentHandle {
  return { agentId: "synthetic-session", send: async () => { throw new Error("Unexpected send"); }, dispose: onDispose };
}

describe("agent slot terminal disposal", () => {
  for (const mode of ["create", "resume"] as const) {
    it(`waits for late ${mode}, disposes the handle, and suppresses persistence/updates`, async () => {
      const opened = deferred<CursorAgentHandle>();
      const cleaned = deferred<void>();
      let disposals = 0;
      let creates = 0;
      const runtime = new MockCursorRuntime();
      runtime.create = () => { creates++; return opened.promise; };
      runtime.resume = () => opened.promise;
      (runtime as import("./runtime").CursorRuntime).isResumableId = () => true;
      const { slot, counts } = lifecycleSlot(runtime, undefined, mode === "resume" ? { cursorAgentId: "saved-session", name: "Probe", kind: "core", model: "composer-2.5" } : undefined);
      const boot = slot.boot();
      const before = counts();
      let finished = false;
      const disposal = slot.dispose().then(() => { finished = true; });
      opened.resolve(fakeHandle(async () => { disposals++; await cleaned.promise; }));
      await waitFor(() => disposals === 1);
      assert.equal(finished, false);
      assert.deepEqual(counts(), before);
      cleaned.resolve();
      await Promise.all([boot, disposal]);
      assert.equal(disposals, 1);
      assert.equal(creates, mode === "create" ? 1 : 0);
      assert.deepEqual(counts(), before);
      assert.notEqual(slot.snapshot().status, "idle");
      slot.handleInstruction("must not start", "queue");
      slot.setModel("changed");
      await slot.setCwd("/must-not-use");
      await slot.boot();
      await slot.dispose();
      assert.equal(slot.snapshot().queueLength, 0);
      assert.equal(disposals, 1);
      assert.deepEqual(counts(), before);
    });
  }

  it("does not fall back to create if resume fails during disposal", async () => {
    const resumed = deferred<CursorAgentHandle>();
    const runtime = new MockCursorRuntime();
    (runtime as import("./runtime").CursorRuntime).isResumableId = () => true;
    runtime.resume = () => resumed.promise;
    const { slot } = lifecycleSlot(runtime, undefined, { cursorAgentId: "saved", name: "Probe", kind: "core", model: "composer-2.5" });
    const boot = slot.boot();
    const disposal = slot.dispose();
    resumed.reject(new Error("synthetic resume failure"));
    await Promise.all([boot, disposal]);
    assert.equal(runtime.creates, 0);
  });

  it("shares initialization between boot and a queued instruction", async () => {
    const opened = deferred<CursorAgentHandle>();
    const runtime = new MockCursorRuntime();
    let creates = 0, disposals = 0;
    runtime.create = () => { creates++; return opened.promise; };
    const { slot } = lifecycleSlot(runtime);
    const boot = slot.boot();
    slot.handleInstruction("queued during boot", "queue");
    assert.equal(creates, 1);
    const disposal = slot.dispose();
    opened.resolve(fakeHandle(async () => { disposals++; }));
    await Promise.all([boot, disposal]);
    assert.equal(disposals, 1);
    assert.equal(creates, 1);
  });

  it("finishes old-workspace initialization before reconnecting to a new workspace", async () => {
    const opened = deferred<CursorAgentHandle>();
    const runtime = new MockCursorRuntime();
    const folders: string[] = [];
    let disposals = 0;
    runtime.create = input => {
      folders.push(input.cwd);
      return folders.length === 1 ? opened.promise : Promise.resolve(fakeHandle(async () => { disposals++; }));
    };
    const { slot } = lifecycleSlot(runtime);
    const boot = slot.boot();
    const changed = slot.setCwd(path.join(os.tmpdir(), "synthetic-next-workspace"));
    opened.resolve(fakeHandle(async () => { disposals++; }));
    await Promise.all([boot, changed]);
    assert.deepEqual(folders, [os.tmpdir(), path.join(os.tmpdir(), "synthetic-next-workspace")]);
    assert.equal(disposals, 1);
    await slot.dispose();
    assert.equal(disposals, 2);
  });

  it("waits for a late send handle and cancels it before disposing its session", async () => {
    const sent = deferred<CursorRunHandle>();
    const cancelled = deferred<void>();
    const events: string[] = [];
    const runtime = new MockCursorRuntime();
    runtime.create = async () => ({ agentId: "synthetic", send: () => { events.push("send"); return sent.promise; }, dispose: async () => { events.push("dispose"); } });
    const { slot, counts } = lifecycleSlot(runtime);
    await slot.boot();
    slot.handleInstruction("delayed send", "queue");
    await waitFor(() => events.includes("send"));
    const before = counts();
    const disposal = slot.dispose();
    sent.resolve({ id: "late", supports: op => op === "cancel", async *stream() {}, wait: async () => ({ status: "cancelled" }), cancel: async () => { events.push("cancel"); await cancelled.promise; } });
    await waitFor(() => events.includes("cancel"));
    assert.deepEqual(events, ["send", "cancel"]);
    cancelled.resolve();
    await disposal;
    assert.deepEqual(events, ["send", "cancel", "dispose"]);
    assert.deepEqual(counts(), before);
  });

  it("disposes its active sidecar and drops queued and future sidecar jobs", async () => {
    const done = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
    const signals: string[] = [];
    let starts = 0;
    const { slot } = lifecycleSlot(new MockCursorRuntime(), { start() { starts++; return { kill: signal => { signals.push(signal!); }, async *output() { await done.promise; }, wait: () => done.promise }; } });
    await slot.boot();
    slot.spawnClaude("first", "queue");
    slot.spawnClaude("queued", "queue");
    let finished = false;
    const disposal = slot.dispose().then(() => { finished = true; });
    assert.deepEqual(signals, ["SIGTERM"]);
    await Promise.resolve();
    assert.equal(finished, false);
    slot.spawnClaude("after dispose", "interrupt");
    done.resolve({ code: null, signal: "SIGTERM" });
    await disposal;
    await slot.dispose();
    assert.equal(starts, 1);
    assert.equal(slot.snapshot().claude, undefined);
  });
});

async function drainMicrotasks() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

function workspaceFixture() {
  const cancelled = deferred<void>();
  const sends: { cwd: string; text: string }[] = [];
  const creates: string[] = [];
  const disposals: string[] = [];
  let onCreate = async (_cwd: string) => {};
  let cancellations = 0;
  const runtime = new MockCursorRuntime();
  runtime.create = async ({ cwd }) => {
    creates.push(cwd);
    await onCreate(cwd);
    return {
      agentId: `session-${creates.length}`,
      dispose: async () => { disposals.push(cwd); },
      send: async (text: string) => {
        const index = sends.length;
        sends.push({ cwd, text });
        const done = deferred<CursorRunResult>();
        return {
          id: `run-${index}`, supports: op => op === "cancel", async *stream() {},
          wait: () => done.promise,
          cancel: async () => {
            cancellations++;
            if (index === 0) await cancelled.promise;
            done.resolve({ status: "cancelled" });
          },
        };
      },
    };
  };
  const { slot } = lifecycleSlot(runtime);
  return { slot, sends, creates, disposals, cancelled, cancellations: () => cancellations, onCreate: (hook: typeof onCreate) => { onCreate = hook; } };
}

describe("workspace transition barrier", () => {
  for (const schedule of ["queued before switch", "queued during switch"] as const) {
    it(`holds ${schedule} through cancellation and reconnect`, async () => {
      const f = workspaceFixture();
      const next = path.join(os.tmpdir(), "workspace-next");
      const connected = deferred<void>();
      await f.slot.boot();
      f.slot.handleInstruction("FIRST", "queue");
      await drainMicrotasks();
      assert.equal(f.slot.snapshot().runId, "run-0");
      if (schedule === "queued before switch") f.slot.handleInstruction("SECOND", "queue");
      f.onCreate(async () => { await connected.promise; });
      const switching = f.slot.setCwd(next);
      if (schedule === "queued during switch") f.slot.handleInstruction("SECOND", "queue");
      await drainMicrotasks();
      assert.equal(f.sends.length, 1);
      assert.equal(f.slot.snapshot().queueLength, 1);
      f.cancelled.resolve();
      await drainMicrotasks();
      assert.deepEqual(f.creates, [os.tmpdir(), next]);
      assert.equal(f.sends.length, 1, "reconnect must finish before sending");
      connected.resolve();
      await switching;
      await drainMicrotasks();
      assert.equal(f.sends.length, 2);
      assert.equal(f.sends[1].cwd, next);
      assert.match(f.sends[1].text, /SECOND/);
      assert.equal(f.slot.snapshot().queueLength, 0);
      await f.slot.dispose();
    });
  }

  it("sends directly to the new workspace after an awaited switch (control)", async () => {
    const f = workspaceFixture();
    await f.slot.boot();
    const next = path.join(os.tmpdir(), "workspace-control");
    await f.slot.setCwd(next);
    f.slot.handleInstruction("CONTROL", "queue");
    await drainMicrotasks();
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].cwd, next);
    f.cancelled.resolve();
    await f.slot.dispose();
  });

  it("keeps the queue closed on reconnect failure until an explicit same-path retry", async () => {
    const f = workspaceFixture();
    await f.slot.boot();
    const next = path.join(os.tmpdir(), "workspace-failure");
    f.onCreate(async () => { throw new Error("synthetic reconnect failure"); });
    const switching = f.slot.setCwd(next);
    f.slot.handleInstruction("RETAINED", "queue");
    await assert.rejects(switching, /synthetic reconnect failure/);
    f.slot.handleInstruction("ALSO RETAINED", "queue");
    await drainMicrotasks();
    assert.equal(f.slot.snapshot().status, "error");
    assert.equal(f.slot.snapshot().queueLength, 2);
    assert.equal(f.sends.length, 0);
    assert.equal(f.creates.length, 2, "queued work must not retry connection implicitly");
    f.onCreate(async () => {});
    await f.slot.setCwd(next);
    await drainMicrotasks();
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].cwd, next);
    assert.match(f.sends[0].text, /RETAINED/);
    assert.equal(f.slot.snapshot().queueLength, 1);
    f.cancelled.resolve();
    await f.slot.dispose();
  });

  it("serializes overlapping switches and sends only after the last one connects", async () => {
    const f = workspaceFixture();
    await f.slot.boot();
    const a = path.join(os.tmpdir(), "workspace-a"), b = path.join(os.tmpdir(), "workspace-b");
    const first = deferred<void>(), second = deferred<void>();
    f.onCreate(async cwd => { await (cwd === a ? first.promise : second.promise); });
    const switchA = f.slot.setCwd(a);
    const switchB = f.slot.setCwd(b);
    f.slot.handleInstruction("FINAL WORKSPACE", "queue");
    await drainMicrotasks();
    assert.deepEqual(f.creates, [os.tmpdir(), a]);
    assert.equal(f.sends.length, 0);
    first.resolve();
    await switchA;
    await drainMicrotasks();
    assert.deepEqual(f.creates, [os.tmpdir(), a, b]);
    assert.equal(f.sends.length, 0);
    second.resolve();
    await switchB;
    await drainMicrotasks();
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].cwd, b);
    assert.deepEqual(f.disposals, [os.tmpdir(), a]);
    f.cancelled.resolve();
    await f.slot.dispose();
  });

  it("disposal releases switch callers and discards queued work while late cleanup drains", async () => {
    const f = workspaceFixture();
    await f.slot.boot();
    const connected = deferred<void>();
    f.onCreate(async () => { await connected.promise; });
    const switching = f.slot.setCwd(path.join(os.tmpdir(), "workspace-disposed"));
    const later = f.slot.setCwd(path.join(os.tmpdir(), "workspace-never-started"));
    f.slot.handleInstruction("NEVER SEND", "queue");
    await drainMicrotasks();
    assert.equal(f.creates.length, 2);
    let disposed = false;
    const disposal = f.slot.dispose().then(() => { disposed = true; });
    await Promise.all([switching, later]);
    assert.equal(disposed, false, "provider cleanup is still awaited");
    assert.equal(f.slot.snapshot().queueLength, 0);
    connected.resolve();
    await disposal;
    assert.equal(f.creates.length, 2);
    assert.equal(f.sends.length, 0);
    assert.equal(f.disposals.length, 2);
  });

  it("preserves an instruction awaiting initialization but not yet submitted", async () => {
    const f = workspaceFixture();
    const connected = deferred<void>();
    f.onCreate(async cwd => { if (cwd === os.tmpdir()) await connected.promise; });
    const boot = f.slot.boot();
    f.slot.handleInstruction("UNSENT", "queue");
    const next = path.join(os.tmpdir(), "workspace-unsent");
    const switching = f.slot.setCwd(next);
    connected.resolve();
    await Promise.all([boot, switching]);
    await drainMicrotasks();
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].cwd, next);
    assert.match(f.sends[0].text, /UNSENT/);
    f.cancelled.resolve();
    await f.slot.dispose();
  });
});
