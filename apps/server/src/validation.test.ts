import test from "node:test";
import assert from "node:assert/strict";
import { emptyAgent, emptyHealth } from "@remote-agents/shared";
import {
  MAX_AGENT_LOG_CHARS,
  MAX_AGENT_COUNT,
  MAX_WS_MESSAGE_BYTES,
  parseWorkerMessage,
  redactSensitive,
} from "./validation";

function hello(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "hello",
    workerId: "worker-1",
    health: emptyHealth(),
    agents: [emptyAgent("agent-1", "Agent 1", "model")],
    ...overrides,
  });
}

test("worker schema accepts a complete hello and redacts secret-shaped logs", () => {
  const agent = {
    ...emptyAgent("agent-1", "Agent 1", "model"),
    headline: "token=do-not-return-this",
    summary: "the literal very-secret-token appeared",
    fullLog: "Authorization: Bearer very-secret-token",
  };
  const parsed = parseWorkerMessage(hello({ agents: [agent] }), ["very-secret-token"]);
  assert.equal(parsed.type, "hello");
  if (parsed.type === "hello") {
    assert.equal(parsed.agents[0].headline, "token=[REDACTED]");
    assert.equal(parsed.agents[0].summary, "the literal [REDACTED] appeared");
    assert.equal(parsed.agents[0].fullLog, "Authorization: [REDACTED]");
  }
  assert.equal(redactSensitive("https://x.test/?token=secret-value"), "https://x.test/?token=[REDACTED]");
});

test("worker schema accepts the incoming claude provider and provider defaults", () => {
  const claude = {
    ...emptyAgent(
      "claude-fable-5-1",
      "Claude Fable 5.1",
      "claude-code:claude-fable-5-1",
      "claude"
    ),
    provider: "claude",
  };
  const parsed = parseWorkerMessage(hello({ agents: [claude] }));
  assert.equal(parsed.type, "hello");
  if (parsed.type === "hello") {
    assert.equal(
      (parsed.agents[0] as AgentSnapshotWithProvider).provider,
      "claude"
    );
  }

  const withoutProvider = parseWorkerMessage(hello());
  assert.equal(withoutProvider.type, "hello");
  if (withoutProvider.type === "hello") {
    assert.equal(withoutProvider.agents[0].provider, undefined);
  }
});

type AgentSnapshotWithProvider = { provider?: "cursor" | "codex" | "claude" };

test("worker schema rejects malformed nested values and oversized fields", () => {
  const invalid = JSON.parse(hello()) as {
    agents: Array<Record<string, unknown>>;
  };
  invalid.agents[0].percent = 101;
  assert.throws(() => parseWorkerMessage(JSON.stringify(invalid)));

  const tooMany = JSON.parse(hello()) as { agents: unknown[] };
  tooMany.agents = Array.from({ length: MAX_AGENT_COUNT + 1 }, (_, i) => emptyAgent(`agent-${i}`, "x", "x"));
  assert.throws(() => parseWorkerMessage(JSON.stringify(tooMany)));

  const longLog = JSON.parse(hello()) as {
    agents: Array<Record<string, unknown>>;
  };
  longLog.agents[0].fullLog = "x".repeat(MAX_AGENT_LOG_CHARS + 1);
  assert.throws(() => parseWorkerMessage(JSON.stringify(longLog)));
  assert.throws(() => parseWorkerMessage("x".repeat(MAX_WS_MESSAGE_BYTES + 1)));
});

test("ack schema bounds file lists and content", () => {
  const valid = parseWorkerMessage(
    JSON.stringify({
      type: "ack",
      commandId: "command-1",
      ok: false,
      error: "password=hunter2",
      files: [{ path: "README.md", bytes: 4, mtime: 1 }],
    })
  );
  assert.equal(valid.type, "ack");
  if (valid.type === "ack") assert.equal(valid.error, "password=[REDACTED]");

  assert.throws(() =>
    parseWorkerMessage(
      JSON.stringify({
        type: "ack",
        commandId: "command-1",
        ok: true,
        files: Array.from({ length: 2001 }, () => ({ path: "x", bytes: 1, mtime: 1 })),
      })
    )
  );
});

test("a verbose tool description cannot disconnect the entire fleet", () => {
  const agent = {...emptyAgent("agent-1", "Agent 1", "model"),lastActions:["shell "+"x".repeat(6000)]};
  const parsed = parseWorkerMessage(hello({agents:[agent]}));
  assert.equal(parsed.type,"hello");
  if (parsed.type === "hello") assert.equal(parsed.agents[0].lastActions[0].length,512);
});


test("worker schema preserves the last instruction in initial and live snapshots", () => {
  const agent = {
    ...emptyAgent("agent-1", "Agent 1", "model"),
    lastInstruction: "Review the project.\nWrite reports/result.md with the findings.",
  };
  for (const message of [
    hello({ agents: [agent] }),
    JSON.stringify({ type: "agent_update", agent }),
    JSON.stringify({ type: "heartbeat", health: emptyHealth(), agents: [agent] }),
  ]) {
    const parsed = parseWorkerMessage(message);
    const snapshot = parsed.type === "agent_update" ? parsed.agent : parsed.type === "hello" || parsed.type === "heartbeat" ? parsed.agents[0] : undefined;
    assert.equal(snapshot?.lastInstruction, agent.lastInstruction);
  }
});

test("last instruction receives the same shaped and known-secret redaction as its transcript", () => {
  const instruction = "Review this configuration:\npassword=private-password\nUse literal private-known-value safely.";
  const agent = {
    ...emptyAgent("agent-1", "Agent 1", "model"),
    lastInstruction: instruction,
    fullLog: `> ${instruction}\nReady to review.`,
  };
  const parsed = parseWorkerMessage(JSON.stringify({ type: "agent_update", agent }), ["private-known-value"]);
  assert.equal(parsed.type, "agent_update");
  if (parsed.type !== "agent_update") return;
  assert.equal(parsed.agent.lastInstruction, "Review this configuration:\npassword=[REDACTED]\nUse literal [REDACTED] safely.");
  assert.equal(parsed.agent.fullLog, `> ${parsed.agent.lastInstruction}\nReady to review.`);
});

test("last instruction is optional for older workers and bounded like queued instructions", () => {
  const base = emptyAgent("agent-1", "Agent 1", "model");
  for (const instruction of [undefined, "", "x".repeat(64 * 1024)]) {
    const parsed = parseWorkerMessage(JSON.stringify({ type: "agent_update", agent: { ...base, lastInstruction: instruction } }));
    assert.equal(parsed.type, "agent_update");
    if (parsed.type === "agent_update") assert.equal(parsed.agent.lastInstruction, instruction);
  }
  for (const instruction of ["x".repeat(64 * 1024 + 1), "bad\u0000instruction", 42, null, {}]) {
    assert.throws(() => parseWorkerMessage(JSON.stringify({ type: "agent_update", agent: { ...base, lastInstruction: instruction } })));
  }
});
