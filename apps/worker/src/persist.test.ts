import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { test, type TestContext } from "node:test";
import { AgentStore, type PersistedState } from "./persist";
import { AgentPool } from "./agent-pool";
import { MockCursorRuntime, MockClaudeLauncher } from "./mock-runtime";
import { testConfig } from "./test-util";

const state: PersistedState = { agents: { "extra-1": {
  name: "Research", kind: "extra", model: "composer-2.5", cursorAgentId: "conversation-do-not-lose",
} } };
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".persistence-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "agents.json");
  return { dir, file, store: new AgentStore(file) };
}

test("missing state starts fresh and first save is private", t => {
  const {dir,file,store}=fixture(t);
  assert.deepEqual(store.load(),{agents:{}});store.save(state);
  assert.equal(store.load().agents["extra-1"].cursorAgentId,"conversation-do-not-lose");
  assert.equal(fs.statSync(file).mode & 0o777,0o600);
  assert.deepEqual(fs.readdirSync(dir),["agents.json"]);
});

for (const [name, bytes] of Object.entries({
  truncated:'{"agents":{"extra-1":{"cursorAgentId":"conversation-do-not-lose"',
  empty:'', scalar:'null', array:'[]', missingAgents:'{}', invalidAgents:'{"agents":[]}',
  invalidSlot:'{"agents":{"extra-1":null}}',
  invalidKind:JSON.stringify({agents:{"extra-1":{...state.agents["extra-1"],kind:"unknown"}}}),
  invalidProvider:JSON.stringify({agents:{"extra-1":{...state.agents["extra-1"],provider:"typo"}}}),
  invalidSession:JSON.stringify({agents:{"extra-1":{...state.agents["extra-1"],cursorAgentId:42}}}),
  futureVersion:'{"version":2,"agents":{}}',
})) test(`existing ${name} state fails closed and save preserves every byte`, t => {
  const {file,store,dir}=fixture(t);fs.writeFileSync(file,bytes);
  assert.throws(()=>store.load(),/Cannot load agent state/);
  // Even a caller that ignores load failure cannot initialize over the file.
  assert.throws(()=>store.save(state),/Cannot load agent state/);
  assert.deepEqual(fs.readFileSync(file),Buffer.from(bytes));assert.deepEqual(fs.readdirSync(dir),["agents.json"]);
});

test("existing read I/O failure is not treated as missing state", t => {
  const {file,store}=fixture(t);fs.writeFileSync(file,JSON.stringify(state));const before=fs.readFileSync(file);
  const read=fs.readFileSync;
  const mock=t.mock.method(fs,"readFileSync",(...args: Parameters<typeof fs.readFileSync>)=>{
    if (args[0]===file) throw Object.assign(new Error("synthetic disk failure"),{code:"EIO"});
    return read(...args);
  });
  assert.throws(()=>store.load(),/cannot read state \(EIO\)/);assert.throws(()=>store.save(state),/EIO/);
  mock.mock.restore();assert.deepEqual(fs.readFileSync(file),before);
});

test("permission-denied state is preserved", {skip:process.getuid?.()===0}, t => {
  const {file,store}=fixture(t);const before=JSON.stringify(state);fs.writeFileSync(file,before);fs.chmodSync(file,0);
  try {assert.throws(()=>store.load(),/EACCES/);assert.throws(()=>store.save(state),/EACCES/);}
  finally {fs.chmodSync(file,0o600);}
  assert.equal(fs.readFileSync(file,"utf8"),before);
});

test("dangling state symlink fails closed without replacing it", t => {
  const {file,store}=fixture(t);fs.symlinkSync("absent-target.json",file);
  assert.throws(()=>store.load(),/cannot read state/);assert.throws(()=>store.save(state),/Cannot load/);
  assert.equal(fs.readlinkSync(file),"absent-target.json");
});

test("directory in place of state is not a fresh fleet", t => {
  const {file,store}=fixture(t);fs.mkdirSync(file);
  assert.throws(()=>store.load(),/Cannot load/);assert.throws(()=>store.save(state),/Cannot load/);assert.ok(fs.statSync(file).isDirectory());
});

test("successful saves use distinct exclusive private files and atomic replacement", t => {
  const {file,store,dir}=fixture(t);fs.writeFileSync(file,JSON.stringify(state),{mode:0o644});
  const rename=fs.renameSync;const seen:string[]=[];let old=fs.readFileSync(file);
  t.mock.method(fs,"renameSync",(from: fs.PathLike,to:fs.PathLike)=>{
    assert.equal(to,file);assert.deepEqual(fs.readFileSync(file),old);
    assert.equal(fs.statSync(from).mode & 0o777,0o600);seen.push(String(from));
    rename(from,to);old=fs.readFileSync(file);
  });
  store.save(state);store.save(state);
  assert.equal(new Set(seen).size,2);assert.ok(seen.every(p=>path.dirname(p)===dir));
  assert.equal(fs.statSync(file).mode & 0o777,0o600);assert.deepEqual(fs.readdirSync(dir),["agents.json"]);
});

for (const operation of ["writeFileSync","fsyncSync","renameSync"] as const) {
  test(`${operation} failure preserves original and cleans private temporary file`, t => {
    const {file,store,dir}=fixture(t);const bytes=JSON.stringify(state);fs.writeFileSync(file,bytes);
    let descriptor:number|undefined;
    const open=fs.openSync;
    t.mock.method(fs,"openSync",(p:fs.PathLike,flags:fs.OpenMode,mode?:fs.Mode)=>{
      const fd=open(p,flags,mode);if(String(p).endsWith('.tmp')){descriptor=fd;assert.equal(flags,"wx");assert.equal(fs.fstatSync(fd).mode & 0o777,0o600);}return fd;
    });
    t.mock.method(fs,operation,()=>{throw new Error(`synthetic ${operation} failure`);});
    assert.throws(()=>store.save(state),new RegExp(`synthetic ${operation} failure`));
    assert.equal(fs.readFileSync(file,"utf8"),bytes);assert.deepEqual(fs.readdirSync(dir),["agents.json"]);
    assert.notEqual(descriptor,undefined);assert.throws(()=>fs.fstatSync(descriptor!),/EBADF/);
  });
}

test("pre-existing temp collision is never reused, chmodded, or removed", t => {
  const {dir,file,store}=fixture(t);fs.writeFileSync(file,JSON.stringify(state));
  const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";const stale=path.join(dir,`.agents.json.${id}.tmp`);
  fs.writeFileSync(stale,"other writer",{mode:0o644});t.mock.method(crypto,"randomUUID",()=>id);
  const before=fs.readFileSync(file);assert.throws(()=>store.save(state),/EEXIST/);
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.readFileSync(stale,"utf8"),"other writer");assert.equal(fs.statSync(stale).mode & 0o777,0o644);
});


test("pool initialization aborts before creating any agent when state is corrupt", async t => {
  const {dir,file}=fixture(t);const bytes='{"agents":{"extra-1":{"cursorAgentId":"preserve-me"';fs.writeFileSync(file,bytes);
  const runtime=new MockCursorRuntime();const pool=new AgentPool({config:testConfig({dataDir:dir,workspacesRoot:path.join(dir,"workspaces")}),runtime,claude:new MockClaudeLauncher()});
  await assert.rejects(pool.start(),/invalid JSON/);
  assert.equal(runtime.creates,0);assert.deepEqual(pool.snapshots(),[]);
  assert.equal(fs.readFileSync(file,"utf8"),bytes);assert.deepEqual(fs.readdirSync(dir),["agents.json"]);
  await pool.dispose();
});
