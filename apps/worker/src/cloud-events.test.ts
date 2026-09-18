import assert from "node:assert/strict";
import { test } from "node:test";
import { SseParser } from "./cloud-api";
import { CloudEventMapper, mapRunStatus } from "./cloud-events";
import { parseCursorEvent } from "./events";

test("SseParser parses split chunks with event, id and data", () => {
  const parser = new SseParser();
  const first = parser.push('event: assistant\ndata: {"text":"Hel');
  assert.equal(first.length, 0);
  const second = parser.push('lo"}\n\nid: 5\nevent: heartbeat\ndata: {}\n\n');
  assert.equal(second.length, 2);
  assert.equal(second[0].event, "assistant");
  assert.deepEqual(second[0].data, { text: "Hello" });
  assert.equal(second[1].event, "heartbeat");
  assert.equal(second[1].id, "5");
});

test("assistant deltas buffer until a paragraph boundary", () => {
  const mapper = new CloudEventMapper();
  assert.equal(mapper.push("assistant", { text: "Working on" }).length, 0);
  assert.equal(mapper.push("assistant", { text: " it." }).length, 0);
  const flushed = mapper.push("assistant", { text: "\n\nNext step" });
  assert.equal(flushed.length, 1);
  const parsed = parseCursorEvent(flushed[0]);
  assert.equal(parsed.assistantText, "Working on it.");
  const rest = mapper.finish();
  assert.equal(parseCursorEvent(rest[0]).assistantText, "Next step");
});

test("tool_call flushes buffered text and maps to CLI shape", () => {
  const mapper = new CloudEventMapper();
  mapper.push("assistant", { text: "Editing now" });
  const events = mapper.push("tool_call", {
    callId: "c1",
    name: "edit_file",
    status: "running",
    args: { path: "/tmp/notes/PLAN.md" },
  });
  assert.equal(events.length, 2);
  assert.equal(parseCursorEvent(events[0]).assistantText, "Editing now");
  const tool = parseCursorEvent(events[1]);
  assert.equal(tool.action, "edit_file PLAN.md");
  const completed = mapper.push("tool_call", { callId: "c1", name: "edit_file", status: "completed" });
  assert.equal(parseCursorEvent(completed[0]).text, "✓ edit_file PLAN.md");
});

test("task tool maps to subagent start/end with cached args", () => {
  const mapper = new CloudEventMapper();
  const start = mapper.push("tool_call", {
    callId: "t1",
    name: "task",
    status: "running",
    args: { description: "fix login bug" },
  });
  assert.equal(parseCursorEvent(start[0]).subagentStart, "fix login bug");
  // Completion without args should still resolve the same subagent name.
  const end = mapper.push("tool_call", { callId: "t1", name: "task", status: "completed" });
  assert.equal(parseCursorEvent(end[0]).subagentEnd, "fix login bug");
});

test("thinking deltas emit thinking events and close on other events", () => {
  const mapper = new CloudEventMapper();
  const think = mapper.push("thinking", { text: "hmm" });
  assert.equal(parseCursorEvent(think[0]).thinkingDelta, "hmm");
  const after = mapper.push("assistant", { text: "ok" });
  assert.equal(parseCursorEvent(after[0]).thinkingEnd, true);
});

test("result event records terminal status and final text", () => {
  const mapper = new CloudEventMapper();
  mapper.push("result", { runId: "r", status: "FINISHED", text: "All done." });
  assert.deepEqual(mapper.result, { status: "FINISHED", text: "All done." });
  assert.equal(mapRunStatus("FINISHED"), "finished");
  assert.equal(mapRunStatus("CANCELLED"), "cancelled");
  assert.equal(mapRunStatus("EXPIRED"), "error");
});
