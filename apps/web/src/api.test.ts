import test from "node:test";
import assert from "node:assert/strict";
import { api, ApiError, stopAgent, removeQueuedInstruction } from "./api.js";

test("uncertain ACK feedback is bounded, actionable, and never auto-retries", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    for (const commandId of ["12345678-1234-1234-1234-123456789abc", "unsafe\n".repeat(1000)]) {
      globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ code: "ACK_TIMEOUT", commandId, error: "untrusted".repeat(1000) }), { status: 503 }); };
      await assert.rejects(api("/api/test"), (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.match(e.message, /may already be queued or running.*Check the agent before retrying/);
        assert.ok(e.message.length < 220);
        assert.equal(e.message.includes("Command ID:"), commandId.startsWith("1234"));
        return true;
      });
    }
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test("run controls target exact run and queued instruction IDs without sending replacement text", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  try {
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await stopAgent("agent/id", "observed-run");
    await removeQueuedInstruction("agent/id", "queued/id");
    assert.equal(requests[0].url, "/api/agents/agent%2Fid/stop");
    assert.equal(requests[0].init?.method, "POST");
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { runId: "observed-run" });
    assert.equal(requests[1].url, "/api/agents/agent%2Fid/queue/queued%2Fid");
    assert.equal(requests[1].init?.method, "DELETE");
    assert.equal(requests[1].init?.body, undefined);
  } finally { globalThis.fetch = original; }
});
