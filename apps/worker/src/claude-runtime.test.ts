import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { ClaudeProcess, ProcessClaudeLauncher, resolveClaudeBin, type ClaudeProcessOptions } from "./claude";
import { ClaudeRuntime } from "./claude-runtime";
import { parseCursorEvent } from "./events";
import { extractWritePathsFromEvent } from "./artifact-reports";
import * as shared from "@remote-agents/shared";

const model = "claude-code:claude-fable-5-1";
const session = "claude:12345678-1234-1234-1234-123456789abc";
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: string[] = [];
  prompt = "";
  ignoreTerm = false;
  constructor() { super(); this.stdin.on("data", (b) => { this.prompt += b.toString(); }); }
  emitJson(value: unknown) { this.stdout.write(JSON.stringify(value) + "\n"); }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    if (this.ignoreTerm && signal === "SIGTERM") return true;
    this.end(null, signal); return true;
  }
  end(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    this.exitCode = code; this.signalCode = signal;
    this.stdout.end(); this.stderr.end(); this.emit("exit", code, signal);
    setImmediate(() => this.emit("close", code, signal));
  }
}
function fake(handler: (child: FakeChild, args: string[]) => void) {
  const calls: { child: FakeChild; bin: string; args: string[]; options: SpawnOptions }[] = [];
  const options: ClaudeProcessOptions = {
    killGraceMs: 20,
    spawn(bin, args, options) {
      const child = new FakeChild();
      calls.push({ child, bin, args, options });
      child.stdin.once("finish", () => setImmediate(() => handler(child, args)));
      return child as unknown as ChildProcess;
    },
  };
  return { calls, options };
}
function success(child: FakeChild, args: string[], text = "Done") {
  const id = args[args.indexOf(args.includes("--resume") ? "--resume" : "--session-id") + 1];
  child.emitJson({ type: "system", subtype: "init", session_id: id });
  child.emitJson({ type: "assistant", message: { content: [{ type: "text", text }] } });
  child.emitJson({ type: "result", subtype: "success", is_error: false, session_id: id, result: text });
  child.end();
}
async function collect(stream: AsyncIterable<unknown>) { const items: any[] = []; for await (const ev of stream) items.push(ev); return items; }
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("ClaudeRuntime", () => {
  it("tracks successful Write/Edit paths through matching tool results, excluding reads and failed writes", async () => {
    const f = fake((child, args) => {
      for (const [id, name, failed] of [["w", "Write", false], ["e", "Edit", false], ["r", "Read", false], ["f", "Write", true]] as const) {
        child.emitJson({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id, name } } });
        child.emitJson({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: { file_path: `reports/${id}.md`, content: "Do not copy this body into events" } }] } });
        child.emitJson({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: failed, content: "result" }] } });
      }
      success(child, args);
    });
    const runtime = new ClaudeRuntime("claude", f.options);
    const agent = await runtime.create({ cwd: process.cwd(), model });
    try {
      const run = await agent.send("Write reports", { model });
      const events = await collect(run.stream());
      assert.deepEqual(events.flatMap(extractWritePathsFromEvent), ["reports/w.md", "reports/e.md"]);
      assert.doesNotMatch(JSON.stringify(events), /Do not copy this body/);
      assert.equal((await run.wait()).status, "finished");
    } finally { await agent.dispose(); }
  });

  it("creates stable IDs, sends prompts over stdin without a shell, strips model prefix, resumes subsequent turns", async () => {
    const f = fake(success);
    const runtime = new ClaudeRuntime("missing-test-claude", f.options);
    const agent = await runtime.create({ slotId: "s", cwd: process.cwd(), model });
    assert.match(agent.agentId, /^claude:[0-9a-f-]{36}$/);
    assert.equal(runtime.kind, "claude");
    const prompt = "Do not execute $(touch SECRET); 'quoted'\nsecond line";
    const run = await agent.send(prompt, { model });
    const events = collect(run.stream());
    assert.equal((await run.wait()).status, "finished");
    assert.equal((await events).filter((ev) => ev.type === "result").length, 1);
    const first = f.calls[0];
    assert.equal(first.child.prompt, prompt);
    assert.equal(first.options.shell, false);
    assert.deepEqual(first.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.ok(!first.args.includes(prompt));
    for (const flag of ["--print", "--dangerously-skip-permissions", "--verbose", "--output-format", "stream-json", "--include-partial-messages"]) assert.ok(first.args.includes(flag));
    assert.equal(first.args[first.args.indexOf("--model") + 1], "claude-fable-5-1");
    assert.equal(first.args[first.args.indexOf("--session-id") + 1], agent.agentId.slice(7));
    const second = await agent.send("next", { model: "claude-opus-4-8" });
    assert.equal((await second.wait()).status, "finished");
    assert.equal(f.calls[1].args[f.calls[1].args.indexOf("--resume") + 1], agent.agentId.slice(7));
    await agent.dispose();
    await assert.rejects(agent.send("after dispose", { model }), /disposed/);
  });

  it("resumes only valid Claude UUIDs and lists the four provider-prefixed models", async () => {
    const f = fake(success); const runtime = new ClaudeRuntime("claude", f.options);
    for (const id of ["codex:" + session.slice(7), "claude:" + "-".repeat(36), "claude:../secret", "claude:123"]) {
      assert.equal(runtime.isResumableId(id), false);
      await assert.rejects(runtime.resume(id, { cwd: process.cwd(), model }), /Invalid/);
    }
    const agent = await runtime.resume(session, { cwd: process.cwd(), model });
    assert.equal(agent.agentId, session);
    await (await agent.send("next", { model })).wait();
    assert.ok(f.calls[0].args.includes("--resume"));
    const expectedModels = ["claude-code:claude-fable-5-1", "claude-code:claude-fable-5", "claude-code:claude-opus-5", "claude-code:claude-opus-4-8"];
    const isolatedBase = !("CLAUDE_MODELS" in shared);
    if (isolatedBase) Object.defineProperty(shared, "CLAUDE_MODELS", { configurable: true, value: expectedModels.map((id) => ({ id })) });
    try { assert.deepEqual(await runtime.listModels(), expectedModels); }
    finally { if (isolatedBase) Reflect.deleteProperty(shared, "CLAUDE_MODELS"); }
    await assert.rejects(agent.send("bad model", { model: "--api-key=secret" }), /Invalid/);
    assert.equal(f.calls.length, 1);
  });

  it("streams partial text and tool lifecycle without replaying full assistant text", async () => {
    const f = fake((child) => {
      child.emitJson({ type: "stream_event", event: { type: "message_start", message: { id: "m" } } });
      child.emitJson({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } });
      child.emitJson({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } } });
      child.emitJson({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "Read" } } });
      child.emitJson({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "Hello world" }, { type: "tool_use", id: "t", name: "Read" }] } });
      child.emitJson({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "file" }] } });
      child.emitJson({ type: "result", subtype: "success", result: "Hello world" }); child.end();
    });
    const agent = await new ClaudeRuntime("claude", f.options).create({ cwd: process.cwd(), model });
    const run = await agent.send("hello", { model });
    const events = await collect(run.stream());
    assert.equal(events.map((ev) => parseCursorEvent(ev).assistantText || "").join(""), "Hello world");
    assert.equal(events.filter((ev) => ev.type === "text_delta").map((ev) => ev.text).join(""), "Hello world");
    assert.equal(events.filter((ev) => ev.type === "tool_call" && ev.subtype === "started").length, 1);
    assert.equal(events.filter((ev) => ev.type === "tool_call" && ev.subtype === "completed").length, 1);
    assert.deepEqual(await run.wait(), { status: "finished", result: "Hello world" });
  });

  for (const scenario of ["nonzero", "result-error", "missing-result", "malformed", "stream-error", "wrong-session", "duplicate-result"]) {
    it(`never succeeds on ${scenario}`, async () => {
      const f = fake((child) => {
        if (scenario === "malformed") child.stdout.write("NOT JSON secret-token\n");
        else if (scenario === "stream-error") child.emitJson({ type: "error", error: "secret-token" });
        else if (scenario === "wrong-session") child.emitJson({ type: "system", session_id: "other" });
        else if (scenario !== "missing-result") {
          const ev = { type: "result", subtype: scenario === "result-error" ? "error_during_execution" : "success", is_error: scenario === "result-error", result: "secret-token" };
          child.emitJson(ev); if (scenario === "duplicate-result") child.emitJson(ev);
        }
        child.end(scenario === "nonzero" ? 1 : 0);
      });
      const run = await (await new ClaudeRuntime("claude", f.options).resume(session, { cwd: process.cwd(), model })).send("test", { model });
      assert.equal((await run.wait()).status, "error");
      const events = await collect(run.stream());
      assert.ok(events.every((ev) => ev.type !== "result" || ev.subtype !== "success"));
      assert.ok(!JSON.stringify(await run.wait()).includes("secret-token"));
    });
  }

  it("lets Claude retry observed request_retry ECONNRESET events after tool work without replay", async () => {
    const f = fake((child) => {
      child.emitJson({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Read" }] } });
      child.emitJson({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", is_error: true, content: "failed tool" }] } });
      for (const retryAttempt of [1, 2, 10]) child.emitJson({ type: "system", subtype: "api_error", source: "request_retry",
        retryAttempt, maxRetries: 10, retryInMs: 535,
        error: { message: "secret-token", connection: { code: "ECONNRESET", message: "secret-token" } } });
      child.emitJson({ type: "result", subtype: "success", result: "Recovered" }); child.end();
    });
    const run = await (await new ClaudeRuntime("claude", f.options).create({ cwd: process.cwd(), model })).send("test", { model });
    const events = await collect(run.stream());
    assert.deepEqual(await run.wait(), { status: "finished", result: "Recovered" });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].child.signals, []);
    assert.equal(events.filter((e) => e.subtype === "api_retry").length, 3);
    assert.ok(events.some((e) => e.type === "tool_call" && e.is_error === true));
    assert.ok(!JSON.stringify(events).includes("secret-token"));
  });

  for (const ending of ["terminal-error", "nonzero", "missing-result"]) {
    it(`never succeeds after retry followed by ${ending}`, async () => {
      const f = fake((child) => {
        child.emitJson({ type: "system", subtype: "api_error", source: "request_retry", retryAttempt: 1,
          maxRetries: 10, retryInMs: 500, error: { connection: { code: "ECONNRESET" }, message: "secret-token" } });
        if (ending === "terminal-error") child.emitJson({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["secret-token"] });
        child.end(ending === "nonzero" ? 1 : 0);
      });
      const run = await (await new ClaudeRuntime("claude", f.options).create({ cwd: process.cwd(), model })).send("test", { model });
      const result = await run.wait();
      assert.equal(result.status, "error");
      assert.match(result.error!.message ?? "", /connection reset/);
      assert.ok(!JSON.stringify(result).includes("secret-token"));
      assert.equal(f.calls.length, 1);
    });
  }

  for (const overrides of [{ source: "unknown" }, { retryAttempt: 11 }, { retryAttempt: 0 },
    { retryInMs: -1 }, { retryAttempt: "1" }, { maxRetries: null }, { type: "error" },
    { subtype: "other" }, { type: "assistant" }]) {
    it(`keeps unconfirmed retry/error fatal: ${JSON.stringify(overrides)}`, async () => {
      const f = fake((child) => child.emitJson({ type: "system", subtype: "api_error", source: "request_retry",
        retryAttempt: 1, maxRetries: 10, retryInMs: 500, error: { type: "rate_limit_error", message: "secret-token" }, ...overrides }));
      const run = await (await new ClaudeRuntime("claude", f.options).create({ cwd: process.cwd(), model })).send("test", { model });
      const result = await run.wait();
      assert.equal(result.status, "error");
      assert.match(result.error!.message ?? "", /provider rate limit/);
      assert.ok(!JSON.stringify(result).includes("secret-token"));
    });
  }

  it("remains cancellable while the CLI owns a scheduled retry", async () => {
    const f = fake((child) => child.emitJson({ type: "system", subtype: "api_error", source: "request_retry",
      retryAttempt: 1, maxRetries: 10, retryInMs: 500, error: { connection: { code: "ECONNRESET" } } }));
    const run = await (await new ClaudeRuntime("claude", f.options).create({ cwd: process.cwd(), model })).send("test", { model });
    await tick(); await tick();
    await run.cancel();
    assert.equal((await run.wait()).status, "cancelled");
    assert.equal(f.calls.length, 1);
  });

  it("settles synchronous spawn exceptions and actual ENOENT errors", async () => {
    for (const options of [{ spawn: () => { throw new Error("secret env"); } }, {}] as ClaudeProcessOptions[]) {
      const agent = await new ClaudeRuntime(path.join(process.cwd(), "absent-claude-binary"), options).create({ cwd: process.cwd(), model });
      const run = await agent.send("test", { model });
      assert.equal((await run.wait()).status, "error");
      assert.ok(!JSON.stringify(await run.wait()).includes("secret env"));
    }
  });

  it("does not claim success before close and captures output after exit", async () => {
    const f = fake((child) => {
      child.emitJson({ type: "result", subtype: "success", result: "last" });
      child.emit("exit", 0, null);
    });
    const process = new ClaudeProcess({ bin: "claude", cwd: processCwd(), text: "x" }, f.options);
    let settled = false; void process.wait().then(() => { settled = true; });
    await tick(); await tick(); assert.equal(settled, false);
    f.calls[0].child.emitJson({ type: "error", error: "late error" });
    f.calls[0].child.end();
    assert.equal((await process.wait()).status, "error");
  });

  it("cancels, escalates SIGTERM to SIGKILL, and serializes a replacement run", async () => {
    const f = fake((child, args) => {
      if (f.calls.length === 1) {
        child.ignoreTerm = true;
        child.emitJson({ type: "system", subtype: "init", session_id: args[args.indexOf("--session-id") + 1] });
      } else success(child, args);
    });
    const agent = await new ClaudeRuntime("claude", f.options).create({ cwd: process.cwd(), model });
    const first = await agent.send("hold", { model });
    while (!f.calls[0].child.ignoreTerm) await tick();
    const keepAlive = setTimeout(() => {}, 1000);
    const next = await agent.send("replace", { model, force: true });
    clearTimeout(keepAlive);
    assert.equal((await first.wait()).status, "cancelled");
    assert.deepEqual(f.calls[0].child.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal((await next.wait()).status, "finished");
    await first.cancel();
    assert.equal(f.calls[0].child.signals.length, 2);
  });

  it("drains more than a pipe buffer of stderr concurrently using a real fake process", async () => {
    const code = `process.stdin.resume(); process.stdin.on('end',()=> { process.stderr.write('x'.repeat(4*1024*1024),()=> { process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'ok'})+'\\n'); }); });`;
    const options: ClaudeProcessOptions = { spawn: (_bin, _args, options) => spawn(process.execPath, ["-e", code], options) };
    const job = new ProcessClaudeLauncher(options).start({ bin: "claude", cwd: process.cwd(), text: "x" });
    const timeout = setTimeout(() => job.kill("SIGKILL"), 5000);
    try { assert.equal((await job.wait()).code, 0); } finally { clearTimeout(timeout); }
    assert.ok(!(await collect(job.output())).join("").includes("xxx"));
  });
});
function processCwd() { return process.cwd(); }

describe("Claude CLI resolution and health", () => {
  it("resolves Unix PATH and home installs and rejects non-executable paths", () => {
    const opts = { platform: "linux" as const, env: { PATH: "/a:/b", HOME: "/home/user" }, usable: (p: string, executable: boolean) => executable && p === "/b/claude" };
    assert.equal(resolveClaudeBin("claude", opts).path, "/b/claude");
    assert.equal(resolveClaudeBin("/missing/claude", opts).available, false);
    assert.equal(resolveClaudeBin("claude", { ...opts, usable: (p) => p === "/home/user/.local/bin/claude" }).available, true);
    assert.equal(resolveClaudeBin("claude", { ...opts, usable: () => false }).available, false);
  });
  it("resolves Windows native executables and npm JS entrypoints without cmd.exe", () => {
    const opts = { platform: "win32" as const, env: { PATH: "C:\\Tools;C:\\Other", USERPROFILE: "C:\\Users\\test" }, usable: (p: string) => p === "C:\\Tools\\claude.exe" };
    assert.equal(resolveClaudeBin("claude", opts).path, "C:\\Tools\\claude.exe");
    const resolved = resolveClaudeBin("claude", { ...opts, usable: (p) => ["C:\\Tools\\claude.cmd", "C:\\Tools\\node_modules\\@anthropic-ai\\claude-code\\cli.js"].includes(p) });
    assert.equal(resolved.path, process.execPath);
    assert.deepEqual(resolved.args, ["C:\\Tools\\node_modules\\@anthropic-ai\\claude-code\\cli.js"]);
    assert.equal(resolveClaudeBin("claude", { ...opts, usable: (p) => p.endsWith(".cmd") }).available, false);
  });
  it("returns sanitized health on missing CLI and a fake authenticated CLI", { skip: process.platform === "win32" }, () => {
    assert.equal(new ClaudeRuntime("/does-not-exist-secret").health().ready, false);
    assert.ok(!new ClaudeRuntime("/does-not-exist-secret").health().detail.includes("secret"));
    const directory = mkdtempSync(path.join(process.cwd(), ".claude-health-test-"));
    try {
      const bin = path.join(directory, "claude");
      writeFileSync(bin, `#!${process.execPath}\nconsole.log(JSON.stringify({loggedIn:true, token:'secret-token'}));`); chmodSync(bin, 0o700);
      assert.deepEqual(new ClaudeRuntime(bin).health(), { ready: true, detail: "Claude Code signed in" });
      writeFileSync(bin, `#!${process.execPath}\nconsole.error('secret-token'); process.exit(1);`);
      assert.equal(new ClaudeRuntime(bin).health().ready, false);
      assert.ok(!new ClaudeRuntime(bin).health().detail.includes("secret-token"));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});


function missingSession(id: string) {
  return {
    type: "result", subtype: "error_during_execution", is_error: true,
    session_id: id, num_turns: 0, duration_api_ms: 0, total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {}, errors: [`No conversation found with session ID: ${id}`],
  };
}

describe("Claude session materialization", () => {
  it("recovers restart-before-first-send with the same allocated ID and one visible result", async () => {
    const f = fake((child, args) => {
      if (args.includes("--resume") && f.calls.length === 1) {
        child.emitJson(missingSession(args[args.indexOf("--resume") + 1])); child.end(1);
      } else success(child, args);
    });
    const allocated = await new ClaudeRuntime("claude", f.options).create({ cwd: process.cwd(), model });
    assert.equal(f.calls.length, 0);
    const resumed = await new ClaudeRuntime("claude", f.options).resume(allocated.agentId, { cwd: process.cwd(), model });
    const run = await resumed.send("the first real turn", { model });
    const events = await collect(run.stream());
    assert.equal((await run.wait()).status, "finished");
    assert.equal(resumed.agentId, allocated.agentId);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].args[f.calls[0].args.indexOf("--resume") + 1], allocated.agentId.slice(7));
    assert.equal(f.calls[1].args[f.calls[1].args.indexOf("--session-id") + 1], allocated.agentId.slice(7));
    assert.ok(!f.calls[1].args.includes("--resume"));
    assert.deepEqual(f.calls.map((call) => call.child.prompt), ["the first real turn", "the first real turn"]);
    assert.equal(events.filter((ev) => ev.type === "result").length, 1);
    assert.equal(events[events.length - 1].subtype, "success");
    // Following turn must resume the materialized conversation, not allocate again.
    const following = await resumed.send("second real turn", { model });
    assert.equal((await following.wait()).status, "finished");
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[2].args[f.calls[2].args.indexOf("--resume") + 1], allocated.agentId.slice(7));
    await resumed.dispose();
  });

  for (const scenario of ["prior-init", "prior-assistant", "prior-tool", "turns", "api-time", "cost", "input-tokens", "output-tokens", "cache-tokens", "model-usage", "missing-usage", "different-error", "stderr-only", "wrong-id", "zero-exit", "duplicate-result"]) {
    it(`does not replay a missing-session lookalike with ${scenario}`, async () => {
      const f = fake((child) => {
        const ev = missingSession(session.slice(7));
        if (scenario === "prior-init") child.emitJson({ type: "system", subtype: "init", session_id: session.slice(7) });
        if (scenario === "prior-assistant") child.emitJson({ type: "assistant", message: { content: [{ type: "text", text: "Already working" }] } });
        if (scenario === "prior-tool") child.emitJson({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Write" }] } });
        if (scenario === "turns") ev.num_turns = 1;
        if (scenario === "api-time") ev.duration_api_ms = 1;
        if (scenario === "cost") ev.total_cost_usd = 0.001;
        if (scenario === "input-tokens") ev.usage.input_tokens = 1;
        if (scenario === "output-tokens") ev.usage.output_tokens = 1;
        if (scenario === "cache-tokens") ev.usage.cache_read_input_tokens = 1;
        if (scenario === "model-usage") ev.modelUsage = { model: {} };
        if (scenario === "missing-usage") Reflect.deleteProperty(ev, "usage");
        if (scenario === "different-error") ev.errors = ["Authentication failed"];
        if (scenario === "wrong-id") ev.session_id = "other";
        if (scenario === "stderr-only") child.stderr.write(ev.errors[0]);
        else child.emitJson(ev);
        if (scenario === "duplicate-result") child.emitJson(ev);
        child.end(scenario === "zero-exit" ? 0 : 1);
      });
      const run = await (await new ClaudeRuntime("claude", f.options).resume(session, { cwd: process.cwd(), model })).send("do not replay", { model });
      assert.equal((await run.wait()).status, "error");
      assert.equal(f.calls.length, 1);
    });
  }

  it("never retries a second failed materialization", async () => {
    const f = fake((child) => { child.emitJson(missingSession(session.slice(7))); child.end(1); });
    const run = await (await new ClaudeRuntime("claude", f.options).resume(session, { cwd: process.cwd(), model })).send("one retry maximum", { model });
    assert.equal((await run.wait()).status, "error");
    assert.equal(f.calls.length, 2);
  });
  it("cancellation while the missing-session process is pending prevents retry", async () => {
    let emitted = false;
    const f = fake((child) => { child.emitJson(missingSession(session.slice(7))); emitted = true; });
    const run = await (await new ClaudeRuntime("claude", f.options).resume(session, { cwd: process.cwd(), model })).send("cancel before retry", { model });
    while (!emitted) await tick();
    await run.cancel();
    assert.equal((await run.wait()).status, "cancelled");
    assert.equal(f.calls.length, 1);
  });
  it("advertises no guessed model catalog on a pre-integration shared build", async () => {
    if (!("CLAUDE_MODELS" in shared)) assert.deepEqual(await new ClaudeRuntime().listModels(), []);
  });
});


describe("Claude numbered turn results", () => {
  function result(index: number, text = "completed") {
    return { type: "result", subtype: "success", is_error: false,
      session_id: session.slice(7), result_index: index, result: text };
  }

  it("accepts consecutive background follow-up results but publishes success only after close", async () => {
    let release!: () => void;
    const f = fake(child => {
      child.emitJson({ type: "system", subtype: "init", session_id: session.slice(7) });
      child.emitJson(result(0, "Initial turn complete"));
      child.emitJson({ type: "system", subtype: "task_notification", session_id: session.slice(7), task_id: "synthetic-background", status: "completed" });
      child.emitJson({ type: "assistant", session_id: session.slice(7), message: { content: [{ type: "text", text: "Follow-up complete" }] } });
      child.emitJson(result(1, "Follow-up complete"));
      release = () => child.end();
    });
    const run = await (await new ClaudeRuntime("claude", f.options).resume(session, { cwd: process.cwd(), model })).send("synthetic", { model });
    let settled = false;
    const waiting = run.wait().then(value => { settled = true; return value; });
    while (!release) await tick();
    await tick();
    assert.equal(settled, false);
    assert.deepEqual(f.calls[0].child.signals, []);
    release();
    const ended = await waiting;
    assert.equal(ended.status, "finished");
    assert.equal(ended.result, "Follow-up complete");
    const events = await collect(run.stream());
    assert.equal(events.filter(ev => ev.type === "result" && ev.subtype === "success").length, 1);
    assert.equal(f.calls.length, 1, "no prompt replay or process restart");
  });

  it("allows informational task notifications after the last numbered result", async () => {
    const f = fake(child => {
      child.emitJson(result(0, "Final answer"));
      child.emitJson({ type: "system", subtype: "task_notification", session_id: session.slice(7), task_id: "done", status: "completed" });
      child.end();
    });
    const run = await (await new ClaudeRuntime("claude", f.options).resume(session, { cwd: process.cwd(), model })).send("synthetic", { model });
    assert.equal((await run.wait()).status, "finished");
  });

  for (const scenario of ["repeated-index", "gap", "negative", "fractional", "string", "missing-index", "missing-session", "wrong-session", "first-not-zero", "missing-followup-result", "malformed-result", "terminal-error", "error-then-success", "nonzero", "stream-error"] as const) {
    it(`keeps numbered ${scenario} as an error`, async () => {
      const f = fake(child => {
        const first: any = result(0);
        const second: any = result(1);
        if (scenario === "first-not-zero") first.result_index = 1;
        if (scenario === "error-then-success") { first.subtype = "error_during_execution"; first.is_error = true; first.errors = ["secret-token"]; }
        child.emitJson(first);
        if (scenario === "first-not-zero") return; // Parser terminates the fake child immediately.
        if (scenario === "missing-followup-result") {
          child.emitJson({ type: "assistant", message: { content: [{ type: "text", text: "new turn" }] } });
          child.end(); return;
        }
        if (scenario === "repeated-index") second.result_index = 0;
        if (scenario === "gap") second.result_index = 2;
        if (scenario === "negative") second.result_index = -1;
        if (scenario === "fractional") second.result_index = 1.5;
        if (scenario === "string") second.result_index = "1";
        if (scenario === "missing-index") delete second.result_index;
        if (scenario === "missing-session") delete second.session_id;
        if (scenario === "wrong-session") second.session_id = "other";
        if (scenario === "malformed-result") second.result = { token: "secret-token" };
        if (scenario === "terminal-error") { second.subtype = "error_max_turns"; second.is_error = true; second.errors = ["secret-token"]; }
        child.emitJson(second);
        if (scenario === "stream-error") child.emitJson({ type: "error", error: "secret-token" });
        child.end(scenario === "nonzero" ? 1 : 0);
      });
      const run = await (await new ClaudeRuntime("claude", f.options).resume(session, { cwd: process.cwd(), model })).send("synthetic", { model });
      const ended = await run.wait();
      assert.equal(ended.status, "error");
      assert.ok(!JSON.stringify(ended).includes("secret-token"));
      const events = await collect(run.stream());
      assert.equal(events.filter(ev => ev.type === "result" && ev.subtype === "success").length, 0);
      assert.equal(f.calls.length, 1);
    });
  }
});


describe("Claude stream-json api_retry wire events", () => {
  const retry = { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10,
    retry_delay_ms: 609, error_status: null,
    error: { message: "secret-token", connection: { code: "ECONNRESET" } } };
  it("lets the native wire retry complete without cancelling or replaying", async () => {
    const f = fake((child, args) => { child.emitJson(retry); success(child, args); });
    const run = await (await new ClaudeRuntime("claude", f.options).create({ slotId: "wire", cwd: process.cwd(), model })).send("synthetic", { model });
    assert.equal((await run.wait()).status, "finished");
    const events = await collect(run.stream());
    assert.ok(events.some(ev => ev.subtype === "api_retry" && ev.retryAttempt === 1 && ev.maxRetries === 10 && ev.retryInMs === 609));
    assert.ok(!JSON.stringify(events).includes("secret-token"));
    assert.deepEqual(f.calls[0].child.signals, []);
    assert.equal(f.calls.length, 1);
  });
  for (const ending of ["exhausted", "missing-delay", "negative-delay", "wrong-type", "terminal-error", "nonzero", "missing-result"] as const) {
    it(`does not turn ${ending} into success`, async () => {
      const f = fake(child => {
        const ev: any = { ...retry };
        if (ending === "exhausted") ev.attempt = 11;
        if (ending === "missing-delay") delete ev.retry_delay_ms;
        if (ending === "negative-delay") ev.retry_delay_ms = -1;
        if (ending === "wrong-type") ev.type = "error";
        child.emitJson(ev);
        if (["exhausted", "missing-delay", "negative-delay", "wrong-type"].includes(ending)) return;
        if (ending !== "missing-result") child.emitJson({ type: "result", subtype: ending === "terminal-error" ? "error_during_execution" : "success", is_error: ending === "terminal-error", result: "synthetic" });
        child.end(ending === "nonzero" ? 1 : 0);
      });
      const run = await (await new ClaudeRuntime("claude", f.options).create({ slotId: "wire", cwd: process.cwd(), model })).send("synthetic", { model });
      assert.equal((await run.wait()).status, "error");
      assert.ok(!JSON.stringify(await run.wait()).includes("secret-token"));
      assert.equal(f.calls.length, 1);
    });
  }
});


describe("bounded Claude provider feedback", () => {
  for (const [error, expected] of [
    [{ code: "ECONNRESET", message: "secret-token" }, "connection reset; ECONNRESET"],
    [{ error: { type: "authentication_error", message: "secret-token" } }, "authentication_error"],
    [{ message: "Connection error." }, "Connection error."],
    [{ status: 429, message: "secret-token" }, "HTTP 429"],
    [{ message: "Connection error. secret-token", code: "secret-token" }, "Claude Code reported a stream error"],
  ] as const) {
    it(`preserves only safe feedback: ${expected}`, async () => {
      const f = fake(child => child.emitJson({ type: "error", error }));
      const run = await (await new ClaudeRuntime("claude", f.options).create({ slotId: "feedback", cwd: process.cwd(), model })).send("synthetic", { model });
      const result = await run.wait();
      assert.equal(result.status, "error");
      assert.ok(result.error!.message!.includes(expected));
      assert.ok(result.error!.message!.length < 180);
      assert.ok(!JSON.stringify(result).includes("secret-token"));
    });
  }
});
