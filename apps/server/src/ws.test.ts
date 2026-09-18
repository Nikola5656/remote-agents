import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { DEFAULT_AGENTS, emptyAgent, emptyHealth } from "@remote-agents/shared";
import { AgentStore } from "./store";
import { UiHub, WorkerHub } from "./ws";

function socket() {
  const frames: string[] = [];
  const ws = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(data: string, callback?: (error?: Error) => void) { frames.push(data); callback?.(); },
    close() {},
    terminate() { ws.emit("close"); },
  });
  return { ws: ws as unknown as WebSocket, frames };
}

const fleet = () => DEFAULT_AGENTS.map((a) => ({
  ...emptyAgent(a.id, a.name, a.defaultModel, a.kind ?? "extra"),
  status: "idle" as const,
  fullLog: "Agent tool output line.\n".repeat(4000),
}));

test("compact UI frames preserve snapshots and halve transcript bytes; legacy clients retain aliases", () => {
  const ui = new UiHub();
  const legacy = socket();
  const compact = socket();
  const agents = fleet();
  ui.add(legacy.ws);
  ui.add(compact.ws, true);
  ui.broadcast({ type: "agents", payload: agents });
  ui.sendTo(compact.ws, { type: "agent", payload: agents[0] });
  assert.deepEqual(JSON.parse(legacy.frames[0]), { type: "agents", agents, payload: agents });
  assert.deepEqual(JSON.parse(compact.frames[0]), { type: "agents", agents });
  assert.deepEqual(JSON.parse(compact.frames[1]), { type: "agent", agent: agents[0] });
  assert.ok(Buffer.byteLength(compact.frames[0]) < Buffer.byteLength(legacy.frames[0]) * 0.501);
  ui.close();
});

test("health-only heartbeats never replay transcripts; real changes and disconnect remain visible", () => {
  const ui = new UiHub();
  const client = socket();
  const worker = socket();
  const store = new AgentStore();
  const hub = new WorkerHub(store, ui);
  const agents = fleet();
  ui.add(client.ws, true);
  const emit = (data: object) => worker.ws.emit("message", JSON.stringify(data));
  const receivedTypes = () => client.frames.map((frame) => JSON.parse(frame).type);
  hub.attach(worker.ws);
  try {
    emit({ type: "hello", workerId: "test", health: emptyHealth(), agents });
    assert.deepEqual(receivedTypes(), ["health", "agents"]);
    const initialBytes = client.frames.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    client.frames.length = 0;
    emit({ type: "heartbeat", health: emptyHealth(), agents: [] });
    assert.deepEqual(receivedTypes(), ["health"]);
    assert.equal(store.listAgents().length, agents.length);
    assert.equal(store.getAgent(agents[0].id)?.fullLog, agents[0].fullLog);
    assert.ok(Buffer.byteLength(client.frames[0]) < initialBytes * 0.01);

    client.frames.length = 0;
    emit({ type: "agent_update", agent: { ...agents[0], fullLog: "New output" } });
    assert.deepEqual(receivedTypes(), ["agent"]);
    client.frames.length = 0;
    emit({ type: "agent_update", agent: { ...agents[0], status: "running" } });
    assert.deepEqual(receivedTypes(), ["agent", "health"]);
    assert.equal(JSON.parse(client.frames[1]).health.agents.find((a: { id: string }) => a.id === agents[0].id).status, "running");

    client.frames.length = 0;
    emit({ type: "heartbeat", health: emptyHealth(), agents: [agents[0]] });
    assert.deepEqual(receivedTypes(), ["health", "agents"]);
    assert.equal(store.listAgents().length, 1);
    client.frames.length = 0;
    worker.ws.emit("close");
    assert.deepEqual(receivedTypes(), ["agents", "health"]);
    assert.equal(JSON.parse(client.frames[0]).agents[0].status, "offline");
  } finally { hub.close(); ui.close(); }
});

test("broadcast does not serialize snapshots with no viewers and disconnects stalled clients", () => {
  const ui = new UiHub();
  const agents = fleet();
  const poison = Object.assign([...agents], { toJSON() { throw new Error("should not serialize"); } });
  assert.doesNotThrow(() => ui.broadcast({ type: "agents", payload: poison }));
  const stalled = socket();
  Object.defineProperty(stalled.ws, "bufferedAmount", { value: 100 * 1024 * 1024 });
  ui.add(stalled.ws, true);
  ui.broadcast({ type: "agents", payload: agents });
  assert.equal(stalled.frames.length, 0);
  assert.doesNotThrow(() => ui.broadcast({ type: "agents", payload: poison }));
  ui.close();
});
