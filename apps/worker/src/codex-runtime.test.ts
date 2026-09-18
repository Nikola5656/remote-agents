import test from "node:test";
import { DEFAULT_AGENTS } from "@remote-agents/shared";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { CodexRuntime } from "./codex-runtime";
import { AgentPool } from "./agent-pool";
import { MockCursorRuntime, MockClaudeLauncher } from "./mock-runtime";
import { testConfig, waitFor } from "./test-util";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-codex-test-"));
  const bin = path.join(dir, "codex");
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'login') process.exit(0);
const id = '11111111-1111-4111-8111-111111111111';
const thread = {id,source:'vscode',path:require('path').join(process.cwd(),'rollout.jsonl')};
let active = null;
let holdsWriter = false;
function releaseWriter() { if (holdsWriter && fs.existsSync('writer-lock')) fs.unlinkSync('writer-lock'); }
process.on('exit', releaseWriter);
process.on('SIGTERM', () => setTimeout(() => process.exit(0), fs.existsSync('slow-close') ? 300 : 0));
function emit(method,params) { console.log(JSON.stringify({method,params})); }
require('readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (!m.id) return;
  fs.appendFileSync('requests.jsonl', line+'\\n');
  let result = {};
  if (m.method === 'threadSection/list') result = {data:[{id:'section',name:'Remote Agents'}]};
  if (m.method === 'thread/resume' && fs.existsSync('remaining-locks')) {
    const count = Number(fs.readFileSync('remaining-locks','utf8'));
    if (count > 0) {
      fs.writeFileSync('remaining-locks', String(count - 1));
      console.log(JSON.stringify({id:m.id,error:{message:'thread '+id+' already has an active writer'}}));
      return;
    }
  }
  if (m.method === 'thread/resume') {
    if (fs.existsSync('writer-lock')) {
      console.log(JSON.stringify({id:m.id,error:{message:'thread '+id+' already has an active writer'}})); return;
    }
    holdsWriter = true; fs.writeFileSync('writer-lock',String(process.pid));
  }
  if (m.method === 'thread/start' || m.method === 'thread/resume') result = {thread};
  if (m.method === 'thread/read') result = {thread:{...thread,source:m.params.threadId.startsWith('2222')?'exec':'vscode'}};
  if (m.method === 'thread/fork') result = {thread};
  if (m.method === 'turn/start') {
    const text = m.params.input[0].text;
    if (text === 'uncertain') {
      console.log(JSON.stringify({id:m.id,error:{message:'Response timed out after submission'}}));
      return;
    }
    active = 'turn-' + m.id;
    result = {turn:{id:active,status:'inProgress'}};
    if (text !== 'hold') setTimeout(() => {
      if (text === 'silent') { process.exit(0); return; }
      emit('item/completed',{threadId:id,item:{id:'tool',type:'commandExecution',status:'completed',command:'pwd'}});
      emit('item/completed',{threadId:id,item:{id:'message',type:'agentMessage',text:'native '+text}});
      emit('turn/completed',{threadId:id,turn:{id:active,status:text==='fail'?'failed':'completed',error:{message:'Model unavailable'}}});
    }, 10);
  }
  if (m.method === 'turn/interrupt') emit('turn/completed',{threadId:id,turn:{id:active,status:'interrupted'}});
  console.log(JSON.stringify({id:m.id,result}));
});
`);
  fs.chmodSync(bin, 0o755);
  return { dir, bin, runtime: new CodexRuntime(bin, false) };
}

test("Codex streams tools and responses, persists session identity, resumes and reports failures", async () => {
  const {dir, runtime} = fixture();
  try {
    const agent = await runtime.create({cwd:dir});
    const run = await agent.send("first", {model:"gpt-6-astra"});
    const events = [];
    for await (const event of run.stream()) events.push(event);
    assert.equal((await run.wait()).status, "finished");
    assert.ok(events.some((e: any) => e.type === "tool_call"));
    assert.equal(agent.agentId, "codex:11111111-1111-4111-8111-111111111111");
    const resumed = await runtime.resume(agent.agentId, {cwd:dir});
    const next = await resumed.send("followup", {model:"gpt-5.6-sol"});
    assert.equal((await next.wait()).result, "native followup");
    const failure = await resumed.send("fail", {model:"gpt-6-astra"});
    assert.equal((await failure.wait()).error?.message, "Model unavailable");
    const silent = await resumed.send("silent", {model:"gpt-6-astra"});
    assert.equal((await silent.wait()).status, "error", "exit 0 without turn completion must not be success");
    await assert.rejects(resumed.send("hi", {model:"auto"}), /Unsupported Codex/);
    const requests = fs.readFileSync(path.join(dir, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.filter((r) => r.method === "thread/fork").length, 0);
    assert.ok(requests.filter((r) => r.method === "turn/start").every((r) => r.params.effort === "medium"));
    for (const r of requests.filter((r) => ["thread/start", "thread/resume"].includes(r.method))) {
      assert.equal(r.params.sandbox, "danger-full-access");
      assert.equal(r.params.approvalPolicy, "never");
    }
    for (const r of requests.filter((r) => r.method === "turn/start")) {
      assert.deepEqual(r.params.sandboxPolicy, {type:"dangerFullAccess"});
      assert.equal(r.params.approvalPolicy, "never");
    }
    assert.ok(requests.some((r) => r.method === "thread/name/set"));
    await resumed.dispose();
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
});

test("Codex cancellation acknowledges the old turn before a replacement run", async () => {
  const {dir, runtime} = fixture();
  try {
    const agent = await runtime.create({cwd:dir});
    const run = await agent.send("hold", {model:"gpt-6-astra"});
    await waitFor(() => Boolean(agent.agentId));
    const next = await agent.send("replace", {model:"gpt-6-astra",force:true});
    assert.equal((await run.wait()).status, "cancelled");
    assert.equal((await next.wait()).status, "finished");
    await agent.dispose();
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
});

test("writer handoffs retry only resume and send the prompt exactly once", async () => {
  const {dir, bin} = fixture();
  const runtime = new CodexRuntime(bin, false, undefined, {timeoutMs:5000});
  try {
    const agent = await runtime.create({cwd:dir});
    fs.writeFileSync(path.join(dir,"remaining-locks"),"3");
    const run = await agent.send("handoff", {model:"gpt-6-astra"});
    assert.equal((await run.wait()).result,"native handoff");
    const requests = () => fs.readFileSync(path.join(dir,"requests.jsonl"),"utf8").trim().split("\n").map(l=>JSON.parse(l));
    assert.equal(requests().filter(r=>r.method === "thread/resume").length,4);
    assert.equal(requests().filter(r=>r.method === "turn/start").length,1);
    await assert.rejects(agent.send("uncertain", {model:"gpt-6-astra"}), /timed out after submission/);
    assert.equal(requests().filter(r=>r.method === "turn/start").length,2,"uncertain submission is not replayed");
    assert.equal(requests().filter(r=>r.method === "thread/start").length,1,"no replacement conversation");
    await agent.dispose();
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("completed runs release their writer process before an immediate follow-up", async () => {
  const {dir, bin} = fixture();
  try {
    fs.writeFileSync(path.join(dir,"slow-close"),"1");
    const runtime = new CodexRuntime(bin,false,undefined,{timeoutMs:0});
    const agent = await runtime.create({cwd:dir});
    const first = await agent.send("one",{model:"gpt-6-astra"});
    assert.equal((await first.wait()).status,"finished");
    assert.ok(!fs.existsSync(path.join(dir,"writer-lock")),"wait includes writer teardown");
    const second = await agent.send("two",{model:"gpt-6-astra"});
    assert.equal((await second.wait()).result,"native two");
    await agent.dispose();
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("persistent writers preserve the task and never receive a duplicate prompt", async () => {
  const {dir, bin} = fixture();
  try {
    const runtime = new CodexRuntime(bin, false, undefined, {timeoutMs:0});
    const agent = await runtime.create({cwd:dir});
    fs.writeFileSync(path.join(dir,"remaining-locks"),"100");
    await assert.rejects(agent.send("held",{model:"gpt-6-astra"}), /history is preserved/);
    const requests = fs.readFileSync(path.join(dir,"requests.jsonl"),"utf8").trim().split("\n").map(l=>JSON.parse(l));
    assert.equal(requests.filter(r=>r.method === "turn/start").length,0);
    assert.equal(agent.agentId,"codex:11111111-1111-4111-8111-111111111111");
    await agent.dispose();
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("legacy exec history migrates once into a named native conversation", async () => {
  const {dir, runtime} = fixture();
  try {
    const migrated = await runtime.resume("codex:22222222-2222-4222-8222-222222222222", {cwd:dir,name:"Astra 1",model:"gpt-6-astra"});
    assert.equal(migrated.agentId, "codex:11111111-1111-4111-8111-111111111111");
    await runtime.resume(migrated.agentId, {cwd:dir,name:"Astra 1",model:"gpt-6-astra"});
    const requests = fs.readFileSync(path.join(dir, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.filter((r) => r.method === "thread/fork").length, 1);
    assert.ok(requests.some((r) => r.method === "thread/name/set" && r.params.name === "Astra 1 · Remote Agents"));
    assert.ok(requests.some((r) => r.method === "thread/section/move" && r.params.sectionId === "section"));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("desktop-owned tasks stream the real log and await completion without taking a second writer", async () => {
  const {dir, bin} = fixture();
  const socketPath = path.join(dir, "desktop.sock");
  const rollout = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(rollout, "");
  const methods: string[] = [];
  let ownerReady = false;
  let discoveries = 0;
  let wakeCount = 0;
  fs.writeFileSync(path.join(dir,"remaining-locks"),"1");
  let finishLog: (() => void) | undefined;
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const m = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        methods.push(m.method);
        if (m.method === "thread-owner-discovery" && !ownerReady) {
          if (++discoveries === 1) continue; // A loading desktop may not answer discovery at all.
          const body = Buffer.from(JSON.stringify({type:"response",requestId:m.requestId,resultType:"error",error:"no-client-found"}));
          const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
          socket.write(Buffer.concat([header,body]));
          continue;
        }
        let result: any = {};
        if (m.method === "initialize") result = {clientId:"test-desktop-client"};
        if (m.method === "thread-follower-update-thread-settings") {
          assert.deepEqual(m.params.threadSettings.sandboxPolicy, {type:"dangerFullAccess"});
          assert.equal(m.params.threadSettings.approvalPolicy, "never");
        }
        if (m.method === "thread-follower-start-turn") {
          assert.equal(m.params.turnStart.request.model, "gpt-6-astra");
          assert.equal(m.params.turnStart.request.effort, "medium");
          assert.deepEqual(m.params.turnStart.request.sandboxPolicy, {type:"dangerFullAccess"});
          assert.equal(m.params.turnStart.request.approvalPolicy, "never");
          result = {result:{turn:{id:"native-turn",status:"inProgress"}}};
          const append = (payload: any) => fs.appendFileSync(rollout, JSON.stringify({type:"event_msg",payload:{turn_id:"native-turn",...payload}}) + "\n");
          append({type:"task_started"});
          append({type:"item_completed",item:{id:"cmd",type:"CommandExecution",command:["pwd"],status:"completed"}});
          finishLog = () => {
            append({type:"item_completed",item:{id:"answer",type:"AgentMessage",content:[{text:"Native result ✓"}]}});
            append({type:"task_complete",last_agent_message:"Native result ✓"});
          };
        }
        let responseDelay = 0;
        if (m.method === "thread-follower-interrupt-turn") {
          fs.appendFileSync(rollout, JSON.stringify({type:"event_msg",payload:{type:"turn_aborted",turn_id:"native-turn"}}) + "\n");
          responseDelay = 1500; // The log reports abort before the desktop acknowledges it.
        }
        const body = Buffer.from(JSON.stringify({type:"response",requestId:m.requestId,resultType:"success",result}));
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        // Exercise the stream framing rather than relying on one data callback per message.
        setTimeout(() => { socket.write(header.subarray(0,2)); socket.write(Buffer.concat([header.subarray(2),body])); }, responseDelay);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const rt = new CodexRuntime(bin, true, socketPath, {wakeDesktop:async (id) => {
      assert.equal(id,"11111111-1111-4111-8111-111111111111"); wakeCount++; ownerReady = true;
    }});
    const agent = await rt.resume("codex:11111111-1111-4111-8111-111111111111", {cwd:dir,name:"Astra 1",model:"gpt-6-astra"});
    const run = await agent.send("real desktop test", {model:"gpt-6-astra"});
    let completed = false;
    void run.wait().then(() => { completed = true; });
    const events: any[] = [];
    const stream = (async () => { for await (const event of run.stream()) events.push(event); })();
    await waitFor(() => events.some((e) => e.type === "tool_call" && e.subtype === "started"));
    assert.equal(completed, false, "an active disk-only turn must not be mistaken for an interruption");
    finishLog!();
    assert.deepEqual(await run.wait(), {status:"finished",result:"Native result ✓"});
    await stream;
    assert.equal(events.filter((e) => e.type === "tool_call" && e.subtype === "started").length, 1);
    assert.ok(events.some((e) => e.type === "assistant"));
    assert.ok(methods.includes("thread-follower-start-turn"));
    const held = await agent.send("hold", {model:"gpt-6-astra"});
    const cancellation = held.cancel();
    assert.equal(held.cancel(), cancellation, "simultaneous cancellation calls share one acknowledgement");
    await cancellation;
    assert.equal((await held.wait()).status, "cancelled");
    assert.equal(methods.filter((m) => m === "thread-follower-interrupt-turn").length, 1);
    const requests = fs.readFileSync(path.join(dir, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.filter((r) => r.method === "thread/resume").length,1);
    assert.ok(!requests.some((r) => r.method === "turn/start"));
    assert.equal(wakeCount,1,"the original task is rehydrated once");
    await agent.dispose();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test("pool creates two Astra slots and one Sol, routes providers, and restores without duplicates", async () => {
  const config = testConfig();
  const runtime = new MockCursorRuntime();
  const codexRuntime = new MockCursorRuntime();
  const options = {config, runtime, codexRuntime, claude:new MockClaudeLauncher()};
  const pool = new AgentPool(options);
  await pool.start();
  assert.equal(pool.snapshots().length, DEFAULT_AGENTS.length);
  assert.deepEqual(pool.snapshots().filter((a) => a.provider === "codex").map((a) => a.model), ["gpt-6-astra","gpt-6-astra","gpt-5.6-sol"]);
  await pool.dispatch({type:"command",commandId:"c",agentId:"codex-astra-1",mode:"queue",text:"hello"});
  await waitFor(() => codexRuntime.sends.length === 1);
  assert.equal(runtime.sends.length,0);
  await assert.rejects(pool.dispatch({type:"set_model",commandId:"m",agentId:"agent-1",model:"gpt-6-astra"}), /provider/);
  await pool.dispose();
  const restored = new AgentPool(options);
  await restored.start();
  assert.equal(restored.snapshots().length,DEFAULT_AGENTS.length);
  await restored.dispose();
  fs.rmSync(config.dataDir,{recursive:true,force:true});
});
