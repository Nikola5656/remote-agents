import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRunArgs,
  cursorCliModel,
  parseCliModelList,
  CliCursorRuntime,
  isComposerChatId,
  type CliRun,
  type CursorCli,
  type StartRunInput,
} from "./cli-cursor-runtime";
import type { ComposerSidebar } from "./composer-sidebar";

class FakeRun implements CliRun {
  readonly id = "run-1";
  cancelled = false;
  constructor(private readonly text: string) {}
  async *stream(): AsyncIterable<unknown> {
    yield {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: this.text }] },
    };
  }
  async wait() {
    return { status: this.cancelled ? "cancelled" : "finished", result: this.text };
  }
  async cancel() {
    this.cancelled = true;
  }
}

class FakeCli implements CursorCli {
  creates = 0;
  runs: FakeRun[] = [];
  runInputs: StartRunInput[] = [];
  async createChat(): Promise<string> {
    this.creates += 1;
    return "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  }
  async listModels(): Promise<string[]> {
    return ["composer-2.5"];
  }
  startRun(input: StartRunInput): CliRun {
    const run = new FakeRun(input.text);
    this.runs.push(run);
    this.runInputs.push(input);
    return run;
  }
}

function fakeSidebar(named?: Record<string, string>): ComposerSidebar {
  const names = { ...(named || {}) };
  const ensured: string[] = [];
  return {
    findNamedChat(name: string) {
      return names[name];
    },
    hasChat() {
      return false;
    },
    ensureChat(input: { composerId: string; name: string }) {
      names[input.name] = input.composerId;
      ensured.push(input.composerId);
      return true;
    },
    touchChat() {},
  } as unknown as ComposerSidebar;
}

describe("cli cursor runtime", () => {
  it("parses both bare and labeled CLI model listings", () => {
    assert.deepEqual(parseCliModelList("Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5 (current)\ngrok-test\n"), ["auto", "composer-2.5", "grok-test"]);
  });
  it("resolves stable dashboard aliases for every resumed CLI turn", async () => {
    const cli = new FakeCli();
    const runtime = new CliCursorRuntime({chatWorkspace: "/tmp/ws", cli});
    const agent = await runtime.resume("11111111-2222-4333-8444-555555555555", {model: "grok-4.6", cwd: "/tmp/ws"});
    await agent.send("first", {model: "grok-4.6"});
    await agent.send("second", {model: "claude-fable-5-1"});
    assert.deepEqual(cli.runInputs.map(x => x.model), ["cursor-grok-4.6-high-fast", "claude-fable-5-1-thinking-high"]);
    assert.equal(cursorCliModel("composer-2.5"), "composer-2.5");
  });
  it("recognizes composer chat ids and rejects SDK agent ids", () => {
    assert.equal(isComposerChatId("2d5841e7-5cb9-4123-8175-26b4a92cbc5d"), true);
    assert.equal(isComposerChatId("agent-8e60adf5-cd28-44e8-9a4a-fb790fe9a36b"), false);
  });

  it("reuses a sidebar-visible chat titled Agent 1 instead of create-chat", async () => {
    const cli = new FakeCli();
    const existing = "11111111-2222-4333-8444-555555555555";
    const runtime = new CliCursorRuntime({
      chatWorkspace: "/tmp/ws",
      cli,
      sidebar: fakeSidebar({ "Agent 1": existing }),
    });
    const handle = await runtime.create({
      slotId: "agent-1",
      name: "Agent 1",
      model: "claude-fable-5-1",
      cwd: "/tmp/agent-1",
    });
    assert.equal(handle.agentId, existing);
    assert.equal(cli.creates, 0);
  });

  it("creates a chat and drives resume/send/cancel on that same id", async () => {
    const cli = new FakeCli();
    const runtime = new CliCursorRuntime({
      chatWorkspace: "/tmp/ws",
      cli,
      sidebar: fakeSidebar(),
    });
    const created = await runtime.create({
      slotId: "agent-2",
      name: "Agent 2",
      model: "grok-4.6",
      cwd: "/tmp/agent-2",
    });
    assert.equal(isComposerChatId(created.agentId), true);
    assert.equal(cli.creates, 0);

    await assert.rejects(
      () => runtime.resume("agent-deadbeef", { model: "grok-4.6", cwd: "/tmp/agent-2" }),
      /not a visible Cursor chat id/
    );

    const resumed = await runtime.resume(created.agentId, {
      model: "grok-4.6",
      cwd: "/tmp/agent-2",
      name: "Agent 2",
    });
    const run = await resumed.send("hello", { model: "grok-4.6" });
    assert.equal(cli.runs.length, 1);
    await run.cancel();
    assert.equal(cli.runs[0].cancelled, true);
    const result = await run.wait();
    assert.equal(result.status, "cancelled");
  });

  it("disables the sandbox and forces every run by default", async () => {
    const cli = new FakeCli();
    const runtime = new CliCursorRuntime({
      chatWorkspace: "/tmp/ws",
      cli,
      sidebar: fakeSidebar(),
    });
    const agent = await runtime.create({
      slotId: "agent-2",
      name: "Agent 2",
      model: "grok-4.6",
      cwd: "/tmp/agent-2",
    });
    await agent.send("write anywhere", { model: "grok-4.6" });
    assert.equal(cli.runInputs.length, 1);
    assert.equal(cli.runInputs[0].sandbox, "disabled");
    assert.equal(cli.runInputs[0].force, true);
  });

  it("respects sandbox/force overrides from config", async () => {
    const cli = new FakeCli();
    const runtime = new CliCursorRuntime({
      chatWorkspace: "/tmp/ws",
      cli,
      sidebar: fakeSidebar(),
      sandbox: "enabled",
      forceRuns: false,
    });
    const agent = await runtime.create({
      slotId: "agent-2",
      name: "Agent 2",
      model: "grok-4.6",
      cwd: "/tmp/agent-2",
    });
    await agent.send("careful", { model: "grok-4.6" });
    assert.equal(cli.runInputs[0].sandbox, "enabled");
    assert.equal(cli.runInputs[0].force, undefined);
    await agent.send("urgent", { model: "grok-4.6", force: true });
    assert.equal(cli.runInputs[1].force, true);
  });

  it("builds run args with --sandbox disabled and --force", () => {
    const args = buildRunArgs({
      chatId: "11111111-2222-4333-8444-555555555555",
      text: "do the thing",
      model: "grok-4.6",
      workspace: "/tmp/agent-2",
      force: true,
      sandbox: "disabled",
    });
    assert.deepEqual(args, [
      "agent",
      "--resume",
      "11111111-2222-4333-8444-555555555555",
      "--print",
      "--trust",
      "--output-format",
      "stream-json",
      "--model",
      "grok-4.6",
      "--workspace",
      "/tmp/agent-2",
      "--sandbox",
      "disabled",
      "--force",
      "do the thing",
    ]);
  });
});
