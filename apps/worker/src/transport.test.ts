import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WebSocketServer } from "ws";
import { emptyAgent, emptyHealth } from "@remote-agents/shared";
import { WorkerTransport } from "./transport";
import { testConfig, waitFor, delay } from "./test-util";

test("heartbeats stay small, updates coalesce, and reconnect restores the latest state", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as {port:number};
  const config = testConfig({serverUrl:`http://127.0.0.1:${address.port}`,heartbeatMs:30});
  let agent = {...emptyAgent("a","A","auto"),status:"idle" as const, fullLog:"x".repeat(160000)};
  const messages: any[] = [];
  const headers: string[] = [];
  server.on("connection", (socket, request) => {
    headers.push(request.headers.authorization || "");
    socket.on("message", raw => messages.push(JSON.parse(raw.toString())));
  });
  const transport = new WorkerTransport(config, {health:emptyHealth,agents:()=>[agent],onCommand:async()=>{}});
  try {
    transport.start();
    await waitFor(()=>messages.some(m=>m.type==="heartbeat"));
    assert.equal(headers[0],"Bearer test-token");
    assert.equal(messages[0].agents[0].fullLog.length,160000);
    for(let i=0;i<100;i++){agent={...agent,headline:`update ${i}`};transport.sendAgentUpdate(agent)}
    await waitFor(()=>messages.some(m=>m.type==="agent_update"));
    const updates=messages.filter(m=>m.type==="agent_update");
    assert.equal(updates.length,1);
    assert.equal(updates[0].agent.headline,"update 99");
    assert.ok(messages.filter(m=>m.type==="heartbeat").every(m=>m.agents.length===0&&JSON.stringify(m).length<2000));
    for(const socket of server.clients)socket.close();
    await waitFor(()=>!transport.connected);
    agent={...agent,headline:"changed while disconnected"};
    transport.sendAgentUpdate(agent);
    await waitFor(()=>messages.filter(m=>m.type==="hello").length===2,4000);
    assert.equal(messages.filter(m=>m.type==="hello").at(-1).agents[0].headline,"changed while disconnected");
    transport.stop();
    await delay(80);
    const count=messages.length;
    await delay(100);
    assert.equal(messages.length,count,"no heartbeats after stop");
  } finally {
    transport.stop();
    for(const socket of server.clients)socket.terminate();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    fs.rmSync(config.dataDir,{recursive:true,force:true});
  }
});

test("stop and queue removal acknowledgements reflect worker acceptance", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  const config = testConfig({ serverUrl: `http://127.0.0.1:${port}`, heartbeatMs: 60_000 });
  const messages: Array<{ type: string; commandId?: string; ok?: boolean; error?: string }> = [];
  let releaseStop!: () => void;
  const stopAccepted = new Promise<void>((resolve) => { releaseStop = resolve; });
  let stopReceived = false;
  server.on("connection", (socket) => socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()))));
  const transport = new WorkerTransport(config, {
    health: emptyHealth,
    agents: () => [],
    onCommand: async (command) => {
      if (command.type === "stop_agent") { stopReceived = true; await stopAccepted; return; }
      if (command.type === "remove_queued_instruction") throw new Error("This instruction is no longer queued; it may have started.");
      throw new Error("Unexpected command");
    },
  });
  try {
    transport.start();
    await waitFor(() => messages.some((message) => message.type === "hello"));
    const socket = [...server.clients][0];
    socket.send(JSON.stringify({ type: "stop_agent", commandId: "stop", agentId: "agent-1", runId: "observed-run" }));
    await waitFor(() => stopReceived);
    assert.equal(messages.some((message) => message.commandId === "stop"), false);
    releaseStop();
    await waitFor(() => messages.some((message) => message.commandId === "stop"));
    assert.equal(messages.find((message) => message.commandId === "stop")?.ok, true);
    socket.send(JSON.stringify({ type: "remove_queued_instruction", commandId: "remove", agentId: "agent-1", instructionId: "started-item" }));
    await waitFor(() => messages.some((message) => message.commandId === "remove"));
    const rejected = messages.find((message) => message.commandId === "remove");
    assert.equal(rejected?.ok, false);
    assert.match(rejected?.error ?? "", /no longer queued/);
  } finally {
    releaseStop();
    transport.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  }
});
