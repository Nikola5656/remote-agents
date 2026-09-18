const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { startServer } = require('../apps/server/dist/server');
const { AgentPool } = require('../apps/worker/dist/agent-pool');
const { WorkerTransport } = require('../apps/worker/dist/transport');
const { MockCursorRuntime, MockClaudeLauncher } = require('../apps/worker/dist/mock-runtime');
const { testConfig } = require('../apps/worker/dist/test-util');
const { emptyHealth } = require('../packages/shared/dist');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(25); }
  throw Error('Integration condition timed out');
}

test('HTTP login -> authenticated WebSockets -> three-provider fleet -> automatic Markdown -> reconnect', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-stack-'));
  const workerToken = crypto.randomBytes(32).toString('hex');
  const password = crypto.randomBytes(24).toString('hex');
  const server = await startServer({host:'127.0.0.1',port:0, username:'integration',password,sessionSecret:crypto.randomBytes(32).toString('hex'),sessionDays:1,workerToken,publicOrigin:'',sessionDir:path.join(dir,'sessions'),environment:'test'});
  const origin = `http://127.0.0.1:${server.port}`;
  const fleet = [
    {id:'cursor-test',name:'Cursor test',provider:'cursor',defaultModel:'composer-2.5',kind:'extra'},
    {id:'codex-test',name:'Codex test',provider:'codex',defaultModel:'gpt-6-astra',kind:'extra'},
    {id:'claude-test',name:'Claude test',provider:'claude',defaultModel:'claude-code:claude-fable-5-1',kind:'claude'},
  ];
  const config = testConfig({serverUrl:origin,workerToken,heartbeatMs:150,fleet,fleetFile:'custom-fleet'});
  const runtimes = [new MockCursorRuntime(), new MockCursorRuntime(), new MockCursorRuntime()];
  let transport, ui;
  const events = [];
  const pool = new AgentPool({config,runtime:runtimes[0],codexRuntime:runtimes[1],claudeRuntime:runtimes[2],claude:new MockClaudeLauncher(),onAgentUpdate:agent=>transport?.sendAgentUpdate(agent)});
  try {
    assert.equal((await fetch(origin+'/api/agents')).status,401);
    const login = await fetch(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({username:'integration',password})});
    assert.equal(login.status,200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    async function api(endpoint, body) {
      const res = await fetch(origin+'/api'+endpoint,{method:body?'POST':'GET',headers:{cookie,origin,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
      const result=await res.json();assert.equal(res.status,200,JSON.stringify(result));return result;
    }
    ui = new WebSocket(origin.replace('http','ws')+'/ws/ui',{headers:{Cookie:cookie,Origin:origin}});
    ui.on('message',data=>events.push(JSON.parse(data)));
    await new Promise((resolve,reject)=>{ui.once('open',resolve);ui.once('error',reject);});
    await pool.start();
    transport = new WorkerTransport(config,{agents:()=>pool.snapshots(),health:()=>({...emptyHealth(),ok:true,workerConnected:true,agents:pool.snapshots().map(a=>({id:a.id,present:true,status:a.status}))}),onCommand:msg=>pool.dispatch(msg)});
    transport.start();
    await until(async()=> (await api('/agents')).length===3 && (await api('/health')).workerConnected);
    assert.deepEqual((await api('/agents')).map(a=>a.id).sort(),fleet.map(a=>a.id).sort());
    for (const [index, agent] of fleet.entries()) {
      const hold = runtimes[index].holdNext();
      await api(`/agents/${agent.id}/message`,{mode:'queue',text:`integration-${agent.id}`});
      await until(()=>events.some(e=>e.agent?.id===agent.id && e.agent.status==='running'));
      hold.release();
      await until(async()=> (await api('/agents')).find(a=>a.id===agent.id).status==='idle');
      const {files} = await api(`/agents/${agent.id}/files`);
      const report = files.find(file=>file.path.startsWith('reports/'));
      assert.ok(report, 'short assistant responses must produce automatic Markdown');
      const content = await api(`/agents/${agent.id}/file?path=${encodeURIComponent(report.path)}`);
      assert.match(content.content,/Working on the request/);
      assert.match(content.content,new RegExp(`integration-${agent.id}`));
      assert.equal(runtimes[index].sends[0].model,agent.defaultModel);
    }
    transport.stop();
    await until(async()=> !(await api('/health')).workerConnected);
    transport.start();
    await until(async()=> (await api('/health')).workerConnected);
    await pause(350); // two empty heartbeats must retain the authoritative fleet.
    assert.equal((await api('/agents')).length,3);
    assert.ok(events.some(e=>e.agent?.provider==='claude'));
  } finally {
    transport?.stop();ui?.terminate();await pool.dispose();await server.close();
    fs.rmSync(config.dataDir,{recursive:true,force:true});fs.rmSync(dir,{recursive:true,force:true});
  }
});
