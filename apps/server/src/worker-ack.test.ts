import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { emptyHealth } from "@remote-agents/shared";
import { AgentStore } from "./store";
import { UiHub, WorkerHub, WorkerRequestError } from "./ws";

test("ACK deadline is uncertain, late ACK never replays, offline is not sent", async () => {
  const store = new AgentStore();
  const hub = new WorkerHub(store, new UiHub(), 20);
  const message = { type: "command" as const, commandId: randomUUID(), agentId: "agent-1", text: "test", mode: "queue" as const };
  const check = (code: string) => (e: unknown) => e instanceof WorkerRequestError && e.code === code && e.commandId === message.commandId;
  await assert.rejects(hub.request(message), check("WORKER_OFFLINE"));
  let sent = 0;
  const socket = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, bufferedAmount: 0, send() { sent++; }, close() {} });
  hub.attach(socket as unknown as WebSocket);
  socket.emit("message", JSON.stringify({ type: "hello", workerId: "test", health: emptyHealth(), agents: [] }));
  try {
    socket.bufferedAmount = 100 * 1024 * 1024;
    await assert.rejects(hub.request(message), check("WORKER_OFFLINE"));
    assert.equal(sent, 0);
    socket.bufferedAmount = 0;
    const send = socket.send;
    socket.send = () => { throw new Error("private socket diagnostic"); };
    await assert.rejects(hub.request(message), check("ACK_UNKNOWN"));
    socket.send = send;
    await assert.rejects(hub.request(message), check("ACK_TIMEOUT"));
    socket.emit("message", JSON.stringify({ type: "ack", commandId: message.commandId, ok: true }));
    assert.equal(sent, 1);
    assert.equal(store.isWorkerConnected(), true);
    const pending = hub.request(message);
    socket.emit("close");
    await assert.rejects(pending, check("ACK_UNKNOWN"));
    assert.equal(sent, 2);
  } finally { hub.close(); }
});
