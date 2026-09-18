import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ClaudeRuntime } from "./claude-runtime";
import { it } from "node:test";
import { ClaudeProcess, ProcessClaudeLauncher, terminateWindowsClaudeTree } from "./claude";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for process-tree condition");
    await sleep(15);
  }
}
function running(pid: number) {
  // A killed orphan may briefly remain a zombie until init reaps it; it cannot
  // execute/write. Check process state, not just kill(pid, 0).
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status === 1 && !result.stdout.trim()) return false;
  assert.equal(result.status, 0, "ps must be available for native process-state verification");
  return Boolean(result.stdout.trim()) && !result.stdout.trim().startsWith("Z");
}

for (const mode of ["cancel-parent-exits", "launcher-kill-inherited-pipes"]) {
  it(`POSIX tree cleanup: ${mode}`, { skip: process.platform === "win32", timeout: 10000 }, async () => {
    const dir = mkdtempSync(path.join(process.cwd(), ".claude-tree-test-"));
    const file = path.join(dir, "tree.cjs");
    writeFileSync(file, `
      const {spawn}=require('node:child_process');
      const fs=require('node:fs'), path=require('node:path');
      const [dir,role,mode]=process.argv.slice(2);
      fs.writeFileSync(path.join(dir,role+'.pid'),String(process.pid));
      process.on('SIGTERM',()=> { if(role==='leader' && mode==='cancel-parent-exits') process.exit(0); });
      if(role!=='grandchild') spawn(process.execPath,[__filename,dir,role==='leader'?'child':'grandchild',mode],{stdio:mode==='cancel-parent-exits'?'ignore':'inherit'});
      setInterval(()=>fs.appendFileSync(path.join(dir,role+'.writes'),'x'),15);
    `);
    let leader = 0;
    let detached: boolean | undefined;
    const options = { killGraceMs: 150, spawn: (_bin: string, _args: string[], opts: any) => {
      detached = opts.detached;
      const child = spawn(process.execPath, [file, dir, "leader", mode], opts);
      leader = child.pid!;
      return child;
    }};
    const input = { bin: "fake-claude", cwd: dir, text: "hold" };
    const proc = mode === "cancel-parent-exits" ? new ClaudeProcess(input, options) : undefined;
    const job = proc ? undefined : new ProcessClaudeLauncher(options).start(input);
    try {
      const roles = ["leader", "child", "grandchild"];
      await until(() => roles.every((role) => existsSync(path.join(dir, role + ".writes"))));
      const pids = roles.map((role) => Number(readFileSync(path.join(dir, role + ".pid"), "utf8")));
      assert.equal(detached, true);
      assert.ok(pids.every(running));
      if (proc) {
        await proc.cancel();
        assert.equal((await proc.wait()).status, "cancelled");
      } else {
        job!.kill("SIGTERM");
        await assert.rejects(job!.wait(), /unsuccessfully/);
      }
      await until(() => pids.every((pid) => !running(pid)));
      const sizes = roles.map((role) => statSync(path.join(dir, role + ".writes")).size);
      await sleep(200);
      assert.deepEqual(roles.map((role) => statSync(path.join(dir, role + ".writes")).size), sizes, "No descendant may keep writing after cancellation completes");
    } finally {
      if (leader) { try { process.kill(-leader, "SIGKILL"); } catch {} }
      await sleep(30);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

it("Windows tree kill uses trusted system utility with argument array and no shell", () => {
  let calls = 0;
  assert.equal(terminateWindowsClaudeTree(1234, { SystemRoot: "C:\\Windows" }, (file, args, options) => {
    calls++;
    assert.equal(file, "C:\\Windows\\System32\\taskkill.exe");
    assert.deepEqual(args, ["/PID", "1234", "/T", "/F"]);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 5000);
    return { status: 0 };
  }), true);
  assert.equal(calls, 1);
  assert.equal(terminateWindowsClaudeTree(-1, { SystemRoot: "C:\\Windows" }), false);
  assert.equal(terminateWindowsClaudeTree(1234, {}), false);
  assert.equal(terminateWindowsClaudeTree(1234, { SystemRoot: "C:\\Windows" }, () => ({ status: 1 })), false);
});


it("failed Windows tree termination stays error and blocks a replacement turn", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 424242, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { throw new Error("Must not kill only the root PID"); },
  });
  let starts = 0;
  const runtime = new ClaudeRuntime("fake-claude", {
    platform: "win32",
    spawn(_bin, _args, options) { starts++; assert.equal(options.detached, false); return child as unknown as ChildProcess; },
    windowsTreeKill(pid) { assert.equal(pid, 424242); return false; },
  });
  const agent = await runtime.create({ cwd: process.cwd(), model: "claude-fable-5-1" });
  const run = await agent.send("hold", { model: "claude-fable-5-1" });
  try {
    await assert.rejects(run.cancel(), /tree could not be terminated/);
    assert.equal((await run.wait()).status, "error");
    await assert.rejects(agent.send("do not overlap", { model: "claude-fable-5-1" }), /tree could not be terminated/);
    assert.equal(starts, 1);
  } finally {
    child.stdout.end(); child.stderr.end(); child.stdin.destroy(); child.emit("close", 1, null);
  }
});
