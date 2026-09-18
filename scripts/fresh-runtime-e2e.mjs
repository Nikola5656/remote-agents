#!/usr/bin/env node
/**
 * Clean Linux runtime E2E against an unpacked release package (not dev checkout).
 * Spawns packaged server process; connects WorkerTransport with mock providers.
 */
import { createRequire } from "node:module";
import { randomBytes, scryptSync } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error("timed out waiting for condition");
}

function parseArgs(argv) {
  const pkgIdx = argv.indexOf("--package");
  if (pkgIdx === -1 || !argv[pkgIdx + 1]) {
    throw new Error("usage: fresh-runtime-e2e.mjs --package /path/to/unpacked/remote-agents");
  }
  return { packageRoot: path.resolve(argv[pkgIdx + 1]) };
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`server startup timed out:\n${output}`)), 20_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Control API listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server exited before listen (${code ?? signal}):\n${output}`));
    });
  });
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function workerConfig({ serverUrl, workerToken, dataDir, fleet }) {
  return {
    serverUrl,
    serverHost: "",
    workerToken,
    cursorApiKey: "e2e-dummy-key",
    cursorRuntime: "cli",
    cursorBin: "cursor",
    chatWorkspace: path.join(dataDir, "chat"),
    workerId: "e2e-runtime-worker",
    defaultCwd: "",
    workspacesRoot: path.join(dataDir, "workspaces"),
    controlRoot: dataDir,
    claudeBin: "claude",
    keepAwake: false,
    dataDir,
    heartbeatMs: 200,
    sandboxMode: "disabled",
    forceRuns: true,
    fleet,
    fleetFile: undefined,
  };
}

async function startPackagedServer(packageRoot, envExtra) {
  const env = { ...process.env, ...envExtra };
  delete env.APP_PASSWORD;
  const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: packageRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const port = await waitForListening(child);
    return { child, origin: `http://127.0.0.1:${port}` };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function connectWorker(packageRoot, { origin, workerToken, dataDir, fleet }) {
  const requireFromPkg = createRequire(path.join(packageRoot, "package.json"));
  const WebSocket = requireFromPkg("ws");
  const { AgentPool } = requireFromPkg("./apps/worker/dist/agent-pool");
  const { WorkerTransport } = requireFromPkg("./apps/worker/dist/transport");
  const { MockCursorRuntime, MockClaudeLauncher } = requireFromPkg("./apps/worker/dist/mock-runtime");
  const { emptyHealth } = requireFromPkg("@remote-agents/shared");

  const config = workerConfig({ serverUrl: origin, workerToken, dataDir, fleet });
  const runtime = new MockCursorRuntime();
  const hold = runtime.holdNext();
  let transport;
  const pool = new AgentPool({
    config,
    runtime,
    claude: new MockClaudeLauncher(),
    onAgentUpdate: (agent) => transport?.sendAgentUpdate(agent),
  });
  await pool.start();
  transport = new WorkerTransport(config, {
    agents: () => pool.snapshots(),
    health: () => ({
      ...emptyHealth(),
      ok: true,
      workerConnected: true,
      agents: pool.snapshots().map((a) => ({ id: a.id, present: true, status: a.status })),
    }),
    onCommand: (msg) => pool.dispatch(msg),
  });
  transport.start();
  return { WebSocket, pool, transport, runtime, hold, config };
}

async function api(origin, cookie, endpoint, body) {
  const res = await fetch(`${origin}/api${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: {
      cookie,
      origin: "https://127.0.0.1",
      "x-forwarded-proto": "https",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status !== 200) throw new Error(`API ${endpoint} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  const { packageRoot } = parseArgs(process.argv);
  const evidence = process.env.E2E_EVIDENCE || path.join(os.tmpdir(), "fresh-runtime-e2e");
  fs.mkdirSync(evidence, { recursive: true });

  const username = "runtime-e2e";
  const password = `e2e-${randomBytes(18).toString("base64url")}`;
  const salt = randomBytes(16);
  const passwordHash = `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
  const workerToken = randomBytes(32).toString("hex");
  const sessionDir = path.join(evidence, "sessions");
  const workerData = path.join(evidence, "worker-data");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(workerData, { recursive: true });

  const fleet = [
    { id: "e2e-cursor", name: "E2E cursor", provider: "cursor", defaultModel: "composer-2.5", kind: "extra" },
  ];
  const serverEnv = {
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "0",
    TRUST_PROXY: "1",
    PUBLIC_ORIGIN: "https://127.0.0.1",
    APP_USERNAME: username,
    APP_PASSWORD_HASH: passwordHash,
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    WORKER_TOKEN: workerToken,
    SESSION_DIR: sessionDir,
    SESSION_DAYS: "1",
  };

  const checks = [];
  let server;
  let worker;

  try {
    server = await startPackagedServer(packageRoot, serverEnv);
    const { origin } = server;
    fs.writeFileSync(path.join(evidence, "server-origin.txt"), `${origin}\n`);

    const healthz = await fetch(`${origin}/api/healthz`);
    if (healthz.status !== 200 || (await healthz.json()).ok !== true) throw new Error("healthz failed");
    checks.push("packaged-server-boot");

    const login = await fetch(`${origin}/api/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://127.0.0.1",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ username, password }),
    });
    if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    if (!cookie?.startsWith("ra.sid=")) throw new Error("missing session cookie");
    checks.push("login-session");

    worker = await connectWorker(packageRoot, { origin, workerToken, dataDir: workerData, fleet });
    await until(async () => (await api(origin, cookie, "/health")).workerConnected);
    checks.push("worker-ws-connected");

    const agents = await api(origin, cookie, "/agents");
    if (agents.length !== 1 || agents[0].id !== "e2e-cursor") throw new Error("unexpected fleet");
    await api(origin, cookie, `/agents/e2e-cursor/message`, {
      mode: "queue",
      text: "runtime-e2e-roundtrip",
    });
    await until(async () => (await api(origin, cookie, "/agents")).find((a) => a.id === "e2e-cursor")?.status === "running");
    worker.hold.release();
    await until(async () => (await api(origin, cookie, "/agents")).find((a) => a.id === "e2e-cursor")?.status === "idle");

    const { files } = await api(origin, cookie, "/agents/e2e-cursor/files");
    const report = files.find((f) => f.path.startsWith("reports/"));
    if (!report) throw new Error("no automatic markdown report");
    const content = await api(origin, cookie, `/agents/e2e-cursor/file?path=${encodeURIComponent(report.path)}`);
    if (!/Working on the request/.test(content.content) || !/runtime-e2e-roundtrip/.test(content.content)) {
      throw new Error("markdown content mismatch");
    }
    fs.writeFileSync(path.join(evidence, "markdown-path.txt"), `${report.path}\n`);
    checks.push("markdown-api-roundtrip");

    const agentsJsonBefore = JSON.parse(fs.readFileSync(path.join(workerData, "agents.json"), "utf8"));
    const persistedId = agentsJsonBefore.agents?.["e2e-cursor"]?.cursorAgentId;
    if (!persistedId) throw new Error("cursorAgentId not persisted before restart");
    fs.writeFileSync(path.join(evidence, "agents-before-restart.json"), JSON.stringify(agentsJsonBefore, null, 2));

    worker.transport.stop();
    await until(async () => !(await api(origin, cookie, "/health")).workerConnected);
    await stopChild(server.child);
    checks.push("server-stop");

    server = await startPackagedServer(packageRoot, serverEnv);
    const origin2 = server.origin;
    worker = await connectWorker(packageRoot, {
      origin: origin2,
      workerToken,
      dataDir: workerData,
      fleet,
    });
    const login2 = await fetch(`${origin2}/api/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://127.0.0.1",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ username, password }),
    });
    const cookie2 = login2.headers.get("set-cookie")?.split(";")[0];
    await until(async () => (await api(origin2, cookie2, "/health")).workerConnected);
    const agentsJsonAfter = JSON.parse(fs.readFileSync(path.join(workerData, "agents.json"), "utf8"));
    if (agentsJsonAfter.agents?.["e2e-cursor"]?.cursorAgentId !== persistedId) {
      throw new Error("cursorAgentId changed after restart");
    }
    const contentAfter = await api(origin2, cookie2, `/agents/e2e-cursor/file?path=${encodeURIComponent(report.path)}`);
    if (!/runtime-e2e-roundtrip/.test(contentAfter.content)) throw new Error("markdown missing after restart");
    checks.push("restart-persistence");

    const result = {
      status: "PASS",
      packageRoot,
      checks,
      persistedId,
      markdown: report.path,
    };
    fs.writeFileSync(path.join(evidence, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    worker?.transport?.stop();
    worker?.pool?.dispose?.();
    await stopChild(server?.child);
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
