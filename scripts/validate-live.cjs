// Runs real agents and leaves one uniquely named Markdown file in each workspace.
// Requires Node 22+ and an existing authenticated session cookie in a private file.
const fs = require('node:fs');
const WebSocket = require('ws');
const os = require('node:os');
const path = require('node:path');
const configuredOrigin = process.env.REMOTE_AGENTS_URL;
if (!configuredOrigin) throw new Error('Set REMOTE_AGENTS_URL to the control server URL.');
const server = new URL(configuredOrigin);
if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || server.pathname !== '/' || server.search || server.hash) {
  throw new Error('REMOTE_AGENTS_URL must be an HTTP(S) origin without credentials, path, query, or fragment.');
}
const origin = server.origin;
const cookieFile = process.env.REMOTE_AGENTS_COOKIE_FILE;
if (!cookieFile) throw new Error('Set REMOTE_AGENTS_COOKIE_FILE to a private session-cookie file.');
const cookie = fs.readFileSync(cookieFile, 'utf8').trim();
const ids = (process.env.REMOTE_AGENTS_IDS ||
  'agent-1,agent-2,agent-3,extra-1,codex-astra-1,codex-astra-2,codex-sol-1,claude-fable-5-1,claude-fable-5,claude-opus-5,claude-opus-4-8').split(',');
const reportPath = process.env.REMOTE_AGENTS_REPORT || path.join(os.tmpdir(), 'remote-agents-validation.json');
const stamp = Date.now();
const report = { started: new Date().toISOString(), agents: {}, websocket: { messages: 0, agents: [] } };
const streamedAgents = new Set();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, body) {
  const response = await fetch(origin + '/api' + path, {
    method: body ? 'POST' : 'GET', headers: { cookie, origin, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.error || 'Request failed'}`);
  return result;
}

const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/ws/ui', { headers: { Cookie: cookie, Origin: origin } });
ws.on('message', (data) => {
  const event = JSON.parse(data);
  report.websocket.messages++;
  const agent = event.agent || (event.type === 'agent' ? event.payload : undefined);
  if (!agent || !ids.includes(agent.id)) return;
  streamedAgents.add(agent.id);
  if (report.agents[agent.id] && agent.status === 'running') report.agents[agent.id].observedRunning = true;
});

async function main() {
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const all = await api('/agents');
  for (const id of ids) {
    const agent = all.find((a) => a.id === id);
    if (!agent || agent.status !== 'idle') throw new Error(`Agent ${id} must exist and be idle before validation`);
    report.agents[id] = {
      model: agent.model, provider: agent.provider, reasoningEffort: agent.reasoningEffort,
      file: `E2E_${stamp}.md`, marker: `REMOTE_AGENTS_OK_${id}_${stamp}`,
    };
  }
  // Submit sequentially so transport failures cannot leave sibling HTTP requests unobserved.
  // The actual agent processes run concurrently after acknowledgement.
  for (const id of ids) {
    const entry = report.agents[id];
    entry.ack = await api(`/agents/${id}/message`, {
      mode: 'queue',
      text: `End-to-end validation task. In your assigned working directory, create the file ${entry.file} ` +
        `containing exactly the single line ${entry.marker}. Use a file-writing or shell tool to actually ` +
        'write it, then read it back to verify. Do not modify any other files. Reply with the marker after verification.',
    });
    console.log('ACCEPTED', id, entry.model);
  }
  const remaining = new Set(ids);
  const deadline = Date.now() + 600000;
  while (remaining.size && Date.now() < deadline) {
    await pause(4000);
    const agents = await api('/agents');
    for (const id of [...remaining]) {
      const agent = agents.find((a) => a.id === id);
      const entry = report.agents[id];
      if (['running', 'queued', 'starting'].includes(agent.status)) continue;
      Object.assign(entry, {
        status: agent.status, headline: agent.headline, toolCount: agent.toolCount,
        runId: agent.runId, completedAt: new Date().toISOString(),
        // CLI init records the actual model; bridge execution is checked separately.
        runtimeModel: agent.fullLog.match(/^Model: (.+)$/m)?.[1],
      });
      try {
        const listed = await api(`/agents/${id}/files`);
        entry.remotelyListed = listed.files.some((file) => file.path === entry.file);
        const file = await api(`/agents/${id}/file?path=${entry.file}`);
        entry.content = file.content;
        entry.verified = file.content.trim() === entry.marker && agent.status === 'idle' &&
          agent.toolCount > 0 && entry.observedRunning === true && entry.remotelyListed;
      } catch (error) { entry.error = error.message; entry.verified = false; }
      console.log(entry.verified ? 'VERIFIED' : 'FAILED', id, entry.status, entry.toolCount, entry.runtimeModel || '');
      remaining.delete(id);
    }
  }
  for (const id of remaining) Object.assign(report.agents[id], { error: 'Timed out', verified: false });
  report.health = await api('/health');
  report.passed = ids.every((id) => report.agents[id].verified) && report.health.ok;
  console.log('RESULT', report.passed ? 'PASS' : 'FAIL');
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => { report.error = error.message; process.exitCode = 1; console.error(error.message); })
  .finally(() => {
    report.websocket.agents = [...streamedAgents];
    report.finished = new Date().toISOString();
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    ws.close();
    console.log('Report:', reportPath);
  });
