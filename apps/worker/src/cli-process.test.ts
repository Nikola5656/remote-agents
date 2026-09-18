import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CANCEL_KILL_MS,
  CANCEL_TERM_MS,
  CliProcessRun,
  StreamLineBuffer,
  appendBounded,
  cancelProcessGroup,
  terminalResultFromEvent,
} from "./cli-cursor-runtime";

async function writeFixture(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cli-process-"));
  const file = join(dir, name);
  await writeFile(file, body, "utf8");
  return file;
}

describe("cli process helpers", () => {
  it("detects terminal stream errors even when the CLI exits 0", () => {
    const result = terminalResultFromEvent({
      type: "result",
      is_error: true,
      result: "permission denied",
    });
    assert.deepEqual(result, {
      status: "error",
      error: { message: "permission denied" },
      result: "permission denied",
    });
  });

  it("drains a trailing partial JSON line from the stdout buffer", () => {
    const buffer = new StreamLineBuffer();
    const partial = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "tail" }],
      },
    });
    assert.deepEqual(buffer.feed(`${partial.slice(0, 8)}`), []);
    assert.deepEqual(buffer.feed(partial.slice(8)), []);
    assert.equal(buffer.drain().length, 1);
  });

  it("bounds capture buffers by keeping the most recent tail", () => {
    const bounded = appendBounded("aaaa", "bbbbbbbb", 6);
    assert.equal(bounded, "bbbbbb");
  });
});

describe("CliProcessRun fixtures", () => {
  it("reports stream is_error on exit 0", async () => {
    const fixture = await writeFixture(
      "err.js",
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:"result",is_error:true,result:"boom"}) + "\\n");
process.exit(0);
`
    );
    const run = new CliProcessRun(process.execPath, [fixture], {
      cwd: process.cwd(),
      env: process.env,
    });
    const events: unknown[] = [];
    for await (const event of run.stream()) events.push(event);
    const result = await run.wait();
    assert.equal(result.status, "error");
    assert.match(result.error?.message || "", /boom/);
    assert.equal(events.some((event) => (event as { type?: string }).type === "result"), true);
  });

  it("parses a final JSON line without a trailing newline", async () => {
    const fixture = await writeFixture(
      "tail.js",
      `#!/usr/bin/env node
const line = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "tail" }] },
});
process.stdout.write(line);
process.exit(0);
`
    );
    const run = new CliProcessRun(process.execPath, [fixture], {
      cwd: process.cwd(),
      env: process.env,
    });
    const events: unknown[] = [];
    for await (const event of run.stream()) events.push(event);
    const result = await run.wait();
    assert.equal(result.status, "finished");
    assert.equal(
      events.some(
        (event) =>
          (event as { message?: { content?: Array<{ text?: string }> } }).message
            ?.content?.[0]?.text === "tail"
      ),
      true
    );
  });

  it("cancels with bounded TERM then KILL when the child ignores SIGTERM", async () => {
    const fixture = await writeFixture(
      "slow.js",
      `#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdout.write("READY\\n");
setInterval(() => {}, 60_000);
`
    );
    const run = new CliProcessRun(process.execPath, [fixture], {
      cwd: process.cwd(),
      env: process.env,
    });
    for await (const event of run.stream()) { if (event) break; }
    const started = Date.now();
    await run.cancel();
    const result = await run.wait();
    const elapsed = Date.now() - started;
    assert.equal(result.status, "cancelled");
    assert.ok(elapsed < CANCEL_TERM_MS + CANCEL_KILL_MS + 1_500);
    assert.ok(elapsed >= CANCEL_TERM_MS - 250);
  });

  it("escalates cancelProcessGroup to SIGKILL for a stubborn child", async () => {
    const fixture = await writeFixture(
      "stubborn.js",
      `#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdout.write("READY\\n");
setInterval(() => {}, 60_000);
`
    );
    const child = spawn(process.execPath, [fixture], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); });
    const started = Date.now();
    await cancelProcessGroup(child, { termMs: 80, killMs: 80 });
    const elapsed = Date.now() - started;
    assert.equal(child.signalCode, "SIGKILL");
    assert.ok(elapsed >= 80);
    assert.ok(elapsed < 500);
  });
});

it("a successful stream record does not mask an unsuccessful process exit", async () => {
  const fixture = await writeFixture("false-success.js", 'console.log(JSON.stringify({type:"result",is_error:false,result:"done"})); process.exitCode=2;');
  const run = new CliProcessRun(process.execPath, [fixture], {cwd:process.cwd(),env:process.env});
  assert.equal((await run.wait()).status, "error");
});
