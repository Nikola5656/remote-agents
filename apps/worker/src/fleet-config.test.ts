import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_AGENTS, CORE_AGENTS, CODEX_AGENTS, CLAUDE_MODELS,
  modelProvider, resolveModelId,
} from "@remote-agents/shared";
import { loadConfig, loadFleetFile, portablePath, validateFleet } from "./config";
import { AgentStore } from "./persist";
import { AgentPool } from "./agent-pool";
import { MockClaudeLauncher, MockCursorRuntime } from "./mock-runtime";
import { testConfig } from "./test-util";
import type { CursorRuntime } from "./runtime";

const definition = { id: "review", name: "Review", provider: "claude", defaultModel: "claude-code:claude-opus-5" };
const fleet = (agent: object = definition) => ({ version: 1, agents: [agent] });
function temp(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".fleet-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function configuration(dir: string, extra: Parameters<typeof testConfig>[0] = {}) {
  return testConfig({ dataDir: dir, workspacesRoot: path.join(dir, "workspaces"), controlRoot: path.join(dir, "control"), ...extra });
}
function runtime(models: string[], error?: string): CursorRuntime & { calls: string[] } {
  const calls: string[] = [];
  return {
    kind: "mock", calls,
    listModels: async () => { if (error) throw new Error(error); return models; },
    isResumableId: () => true,
    create: async (input) => { calls.push(`create:${input.model}:${input.cwd}`); return { agentId: "synthetic-session", send: async () => { throw new Error("No model execution in fixture"); }, dispose: async () => {} }; },
    resume: async (id, input) => { calls.push(`resume:${id}:${input.model}`); return { agentId: id, send: async () => { throw new Error("No model execution in fixture"); }, dispose: async () => {} }; },
  };
}

test("defaults retain six original slots, Research, and four distinct Claude models", () => {
  assert.equal(DEFAULT_AGENTS.length, 11);
  assert.equal(new Set(DEFAULT_AGENTS.map(a => a.id)).size, 11);
  for (const old of [...CORE_AGENTS, ...CODEX_AGENTS]) assert.equal(DEFAULT_AGENTS.find(a => a.id === old.id)?.defaultModel, old.defaultModel);
  assert.equal(DEFAULT_AGENTS.find(a => a.id === "extra-1")?.name, "Research");
  assert.deepEqual(CLAUDE_MODELS.map(m => m.id), ["claude-code:claude-fable-5-1", "claude-code:claude-fable-5", "claude-code:claude-opus-5", "claude-code:claude-opus-4-8"]);
  assert.equal(modelProvider("claude-fable-5-1"), "cursor");
  assert.equal(modelProvider("claude-code:claude-fable-5-1"), "claude");
  assert.equal(modelProvider("gpt-6-astra"), "codex");
  assert.equal(validateFleet({version:1, agents:DEFAULT_AGENTS}).length, 11);
});

test("unavailable model never substitutes the supplied fallback", () => {
  assert.throws(() => resolveModelId("composer-2.5", ["auto"], "auto"), /no fallback/);
  assert.equal(resolveModelId("claude-fable-5-1-thinking-high", ["claude-fable-5-1"]), "claude-fable-5-1");
});

for (const [name, value] of Object.entries({
  "unknown provider": fleet({...definition, provider:"other"}),
  "missing provider": fleet({id:"a",name:"A",defaultModel:"auto"}),
  "provider model mismatch": fleet({...definition,provider:"cursor"}),
  "unknown model": fleet({...definition,defaultModel:"claude-code:invented"}),
  "alias in config": fleet({...definition,provider:"cursor",defaultModel:"claude-fable-5-1-thinking-high"}),
  "duplicate ids": {version:1,agents:[definition,definition]},
  "unsafe id": fleet({...definition,id:"../other"}),
  "reserved id": fleet({...definition,id:"constructor"}),
  "invalid kind": fleet({...definition,kind:"robot"}),
  "mismatched kind": fleet({...definition,provider:"cursor",defaultModel:"auto",kind:"claude"}),
  "blank cwd": fleet({...definition,cwd:" "}),
  "NUL cwd": fleet({...definition,cwd:"bad\0path"}),
  "blank name": fleet({...definition,name:" "}),
  "unknown field": fleet({...definition,model:"auto"}),
  "wrong version": {version:2,agents:[definition]},
  "empty fleet": {version:1,agents:[]},
  "not an object": [],
  "null agent": {version:1,agents:[null]},
})) test(`fleet rejects ${name}`, () => assert.throws(() => validateFleet(value)));

test("fleet file paths resolve relative to the file and expand current home", t => {
  const dir = temp(t);const file=path.join(dir,"fleet.json");
  fs.writeFileSync(file,JSON.stringify(fleet({...definition,cwd:"../project"})));
  assert.equal(loadFleetFile(file)[0].cwd,path.resolve(dir,"../project"));
  assert.equal(portablePath("~/project"),path.join(os.homedir(),"project"));
  assert.equal(portablePath("~"),os.homedir());
  assert.throws(()=>portablePath("~someone/project"));
  fs.writeFileSync(file,"{");assert.throws(()=>loadFleetFile(file),/AGENT_FLEET_FILE/);
  assert.throws(()=>loadFleetFile(path.join(dir,"absent")),/AGENT_FLEET_FILE/);
});

test("config defaults keep unrestricted runs and support authoritative fleet file", t => {
  const dir=temp(t);const file=path.join(dir,"fleet.json");fs.writeFileSync(file,JSON.stringify(fleet()));
  const config=loadConfig({AGENT_FLEET_FILE:file,WORKSPACES_ROOT:"./relative",DEFAULT_CWD:"~/project",WORKER_DATA_DIR:"./state"});
  assert.equal(config.fleet?.length,1);assert.equal(config.fleetFile,file);
  assert.equal(config.workspacesRoot,path.resolve("relative"));assert.equal(config.defaultCwd,path.join(os.homedir(),"project"));
  assert.equal(config.sandboxMode,"disabled");assert.equal(config.forceRuns,true);
  assert.equal(loadConfig({}).fleet?.length,11);
  assert.equal(loadConfig({}).workerId,"worker-primary");
  assert.equal(loadConfig({WORKER_ID:" custom-worker "}).workerId,"custom-worker");
});

test("store reads legacy state and roundtrips explicit providers", t => {
  const dir=temp(t);const file=path.join(dir,"agents.json");const store=new AgentStore(file);
  fs.writeFileSync(file,JSON.stringify({agents:{"extra-1":{name:"Old",kind:"extra",model:"gpt-6-astra",cursorAgentId:"codex:keep",cwd:dir},"extra-2":{name:"Claude",kind:"claude",model:"claude-code:claude-opus-5",cursorAgentId:"claude:keep"}}}));
  const state=store.load();assert.equal(state.agents["extra-1"].provider,"codex");assert.equal(state.agents["extra-2"].provider,"claude");
  store.save(state);assert.equal(store.load().agents["extra-1"].cursorAgentId,"codex:keep");assert.equal(JSON.parse(fs.readFileSync(file,"utf8")).version,1);
  assert.deepEqual(fs.readdirSync(dir),["agents.json"]);
});

test("unknown state version is not silently reset", t => {
  const file=path.join(temp(t),"agents.json");fs.writeFileSync(file,'{"version":2,"agents":{}}');
  assert.throws(()=>new AgentStore(file).load(),/Unsupported agent state version/);
  assert.equal(fs.readFileSync(file,"utf8"),'{"version":2,"agents":{}}');
});

test("missing providers stay visible without hiding eleven-slot fleet", async t => {
  const dir=temp(t);const updates: string[]=[];
  const pool=new AgentPool({config:configuration(dir),runtime:new MockCursorRuntime(),claude:new MockClaudeLauncher(),onAgentUpdate:a=>updates.push(a.id)});
  await pool.start();t.after(()=>pool.dispose());
  assert.equal(pool.snapshots().length,11);
  for (const agent of pool.snapshots()) {
    assert.equal(agent.status,agent.provider==="cursor"?"idle":"error");
    assert.ok(agent.availableModels.every(m=>modelProvider(m)===agent.provider));assert.ok(updates.includes(agent.id));
  }
});

test("Claude health failure is isolated from Codex and Cursor", async t => {
  const dir=temp(t);const claude=runtime(CLAUDE_MODELS.map(m=>m.id));
  const pool=new AgentPool({config:configuration(dir),runtime:new MockCursorRuntime(),codexRuntime:runtime(["gpt-6-astra","gpt-5.6-sol"]),claudeRuntime:claude,providerHealth:{claude:()=>({ready:false,detail:"Missing Claude executable"})},claude:new MockClaudeLauncher()});
  await pool.start();t.after(()=>pool.dispose());
  assert.equal(claude.calls.length,0);assert.equal(pool.snapshots().filter(a=>a.status==="idle").length,7);
  assert.ok(pool.snapshots().filter(a=>a.provider==="claude").every(a=>a.headline.includes("Missing Claude")));
});

test("Cursor discovery failure does not hide healthy native-Claude slots", async t => {
  const dir=temp(t);const claude=runtime(CLAUDE_MODELS.map(m=>m.id));
  const pool=new AgentPool({config:configuration(dir),runtime:runtime([],"Cursor missing"),claudeRuntime:claude,claude:new MockClaudeLauncher()});
  await pool.start();t.after(()=>pool.dispose());
  assert.equal(pool.sdkHealth().ready,false);assert.equal(claude.calls.length,4);
  assert.ok(pool.snapshots().filter(a=>a.provider==="claude").every(a=>a.status==="idle"));
});

test("unsupported saved model remains errored, never replaced with a default", async t => {
  const dir=temp(t);const store=new AgentStore(path.join(dir,"agents.json"));store.save({agents:{"agent-1":{name:"Agent 1",kind:"core",model:"removed-model",cursorAgentId:"old:session"}}});
  const cursor=runtime(["auto"]);const pool=new AgentPool({config:configuration(dir),store,runtime:cursor,claude:new MockClaudeLauncher()});
  await pool.start();t.after(()=>pool.dispose());
  assert.equal(pool.get("agent-1")?.model,"removed-model");assert.equal(pool.get("agent-1")?.snapshot().status,"error");assert.equal(cursor.calls.length,0);
  assert.equal(store.load().agents["agent-1"].cursorAgentId,"old:session");
});

test("explicit fleet uses exact provider and workspace; preserves unlisted state", async t => {
  const dir=temp(t);const store=new AgentStore(path.join(dir,"agents.json"));store.save({agents:{"extra-99":{name:"Saved",kind:"extra",model:"auto"}}});
  const claude=runtime(CLAUDE_MODELS.map(m=>m.id));const cwd=path.join(dir,"control");
  const pool=new AgentPool({config:configuration(dir,{fleet:validateFleet(fleet({...definition,cwd})),fleetFile:path.join(dir,"fleet.json")}),store,runtime:new MockCursorRuntime(),claudeRuntime:claude,claude:new MockClaudeLauncher()});
  await pool.start();t.after(()=>pool.dispose());
  assert.equal(pool.snapshots().length,1);assert.equal(pool.snapshots()[0].cwd,cwd);assert.equal(pool.snapshots()[0].provider,"claude");
  assert.ok(claude.calls[0].includes(definition.defaultModel));assert.ok(store.load().agents["extra-99"]);
  await assert.rejects(pool.dispatch({type:"set_model",commandId:"x",agentId:"review",model:"gpt-6-astra"}),/provider/);
  await assert.rejects(pool.dispatch({type:"spawn_agent",commandId:"x",name:"bad",model:"invented"}),/Unsupported model/);
});

test("legacy saved extra Claude resumes on Claude runtime without Cursor substitution", async t => {
  const dir=temp(t);const store=new AgentStore(path.join(dir,"agents.json"));store.save({agents:{"extra-7":{name:"Review",kind:"claude",model:definition.defaultModel,cursorAgentId:"claude:kept"}}});
  const claude=runtime(CLAUDE_MODELS.map(m=>m.id));const pool=new AgentPool({config:configuration(dir),store,runtime:new MockCursorRuntime(),claudeRuntime:claude,claude:new MockClaudeLauncher()});
  await pool.start();t.after(()=>pool.dispose());assert.ok(claude.calls.some(c=>c.startsWith("resume:claude:kept:")));
  await pool.dispatch({type:"spawn_agent",commandId:"x",name:"Another",model:definition.defaultModel});
  assert.equal(pool.get("extra-8")?.snapshot().provider,"claude");
});

test("saved provider conflict does not reassign or resume conversation", async t => {
  const dir=temp(t);const store=new AgentStore(path.join(dir,"agents.json"));store.save({agents:{review:{name:"Review",kind:"extra",provider:"codex",model:"gpt-6-astra",cursorAgentId:"codex:keep"}}});
  const claude=runtime(CLAUDE_MODELS.map(m=>m.id));const pool=new AgentPool({config:configuration(dir,{fleet:validateFleet(fleet()),fleetFile:"custom"}),store,runtime:new MockCursorRuntime(),claudeRuntime:claude,claude:new MockClaudeLauncher()});
  await pool.start();t.after(()=>pool.dispose());assert.equal(pool.snapshots()[0].status,"error");assert.match(pool.snapshots()[0].headline,/conflicts/);assert.equal(claude.calls.length,0);assert.equal(store.load().agents.review.cursorAgentId,"codex:keep");
});

test("one inaccessible workspace does not hide a healthy peer", async t => {
  const dir=temp(t);const blocked=path.join(dir,"file");fs.writeFileSync(blocked,"not a directory");
  const agents=validateFleet({version:1,agents:[{id:"bad",name:"Bad",provider:"cursor",defaultModel:"auto",cwd:path.join(blocked,"child")},{id:"good",name:"Good",provider:"cursor",defaultModel:"auto"}]});
  const pool=new AgentPool({config:configuration(dir,{fleet:agents,fleetFile:"custom"}),runtime:new MockCursorRuntime(),claude:new MockClaudeLauncher()});
  await pool.start();t.after(()=>pool.dispose());assert.equal(pool.get("bad")?.snapshot().status,"error");assert.equal(pool.get("good")?.snapshot().status,"idle");
});

test("native-only fleet does not claim a Cursor health failure", async t => {
  const dir=temp(t);const pool=new AgentPool({config:configuration(dir,{fleet:validateFleet(fleet()),fleetFile:"custom"}),runtime:runtime([],"Cursor missing"),claudeRuntime:runtime(CLAUDE_MODELS.map(m=>m.id)),claude:new MockClaudeLauncher()});
  await pool.start();t.after(()=>pool.dispose());assert.equal(pool.sdkHealth().ready,true);assert.match(pool.sdkHealth().detail,/not configured/);
});

test("example files match the schema and default fleet", () => {
  const examples=path.resolve(__dirname,"../../../examples");
  assert.equal(loadFleetFile(path.join(examples,"fleet.portable.json")).length,3);
  assert.deepEqual(loadFleetFile(path.join(examples,"fleet.defaults.json")),DEFAULT_AGENTS);
});

test("default fleet restores without duplicates and routes messages to exact providers", async t => {
  const dir=temp(t);const cursor=new MockCursorRuntime();const codex=new MockCursorRuntime();const claude=new MockCursorRuntime();
  const options={config:configuration(dir),runtime:cursor,codexRuntime:codex,claudeRuntime:claude,claude:new MockClaudeLauncher()};
  const pool=new AgentPool(options);await pool.start();
  for (const agentId of ["agent-1","codex-astra-1","claude-opus-5"]) await pool.dispatch({type:"command",commandId:agentId,agentId,mode:"queue",text:agentId});
  const {waitFor}=await import("./test-util");
  await waitFor(()=>cursor.sends.length===1 && codex.sends.length===1 && claude.sends.length===1);
  assert.equal(cursor.sends[0].model,"grok-4.6");assert.equal(codex.sends[0].model,"gpt-6-astra");assert.equal(claude.sends[0].model,"claude-code:claude-opus-5");
  await pool.dispose();const restored=new AgentPool(options);await restored.start();t.after(()=>restored.dispose());
  assert.equal(restored.snapshots().length,11);assert.equal(new Set(restored.snapshots().map(a=>a.id)).size,11);
});

test("native model discovery and creation never receive Cursor API credentials", async t => {
  const dir=temp(t);const native=runtime(CLAUDE_MODELS.map(m=>m.id));const original=native.create;
  native.listModels=async key=>{assert.equal(key,undefined);return CLAUDE_MODELS.map(m=>m.id);};
  native.create=async input=>{assert.equal(input.apiKey,undefined);return original(input);};
  const pool=new AgentPool({config:configuration(dir,{fleet:validateFleet(fleet()),fleetFile:"custom"}),runtime:new MockCursorRuntime(),claudeRuntime:native,claude:new MockClaudeLauncher()});
  await pool.start();t.after(()=>pool.dispose());assert.equal(pool.snapshots()[0].status,"idle");
});

test("throwing provider health check leaves peers visible", async t => {
  const dir=temp(t);const pool=new AgentPool({config:configuration(dir),runtime:new MockCursorRuntime(),claudeRuntime:runtime(CLAUDE_MODELS.map(m=>m.id)),providerHealth:{claude:()=>{throw new Error("Synthetic health failure");}},claude:new MockClaudeLauncher()});
  await pool.start();t.after(()=>pool.dispose());assert.equal(pool.snapshots().length,11);assert.equal(pool.get("agent-1")?.snapshot().status,"idle");assert.match(pool.get("claude-opus-5")!.snapshot().headline,/Synthetic health failure/);
});


test("executable and chat-workspace paths expand without shell evaluation or fallback", () => {
  const config=loadConfig({CLAUDE_BIN:"~/tools/claude",CURSOR_BIN:"./bin/cursor",CURSOR_CHAT_WORKSPACE:"./not-created-yet"});
  assert.equal(config.claudeBin,path.join(os.homedir(),"tools/claude"));
  assert.equal(config.cursorBin,path.resolve("bin/cursor"));
  assert.equal(config.chatWorkspace,path.resolve("not-created-yet"));
  assert.equal(loadConfig({CLAUDE_BIN:"claude-custom"}).claudeBin,"claude-custom");
  assert.throws(()=>loadConfig({CLAUDE_BIN:"bad\0bin"}));
});

test("invalid saved provider fails closed and cannot silently reset a configured slot", async t => {
  const dir=temp(t);const file=path.join(dir,"agents.json");fs.writeFileSync(file,JSON.stringify({agents:{review:{name:"Review",kind:"claude",provider:"typo",model:definition.defaultModel,cursorAgentId:"claude:keep"}}}));
  const native=runtime(CLAUDE_MODELS.map(m=>m.id));const pool=new AgentPool({config:configuration(dir,{fleet:validateFleet(fleet()),fleetFile:"custom"}),runtime:new MockCursorRuntime(),claudeRuntime:native,claude:new MockClaudeLauncher()});
  await assert.rejects(pool.start(),/invalid provider/);t.after(()=>pool.dispose());assert.equal(pool.snapshots().length,0);assert.equal(native.calls.length,0);
});
