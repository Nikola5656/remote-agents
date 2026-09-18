import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import WebSocket from "ws";
import {
  CORE_AGENTS,
  CODEX_AGENTS,
  DEFAULT_AGENTS,
  emptyAgent,
  emptyHealth,
  ServerToWorker,
} from "@remote-agents/shared";
import { MAX_WS_MESSAGE_BYTES } from "./validation";
import { ServerConfig } from "./env";
import { startServer, StartedServer } from "./server";

interface HttpResult {
  status: number;
  json: unknown;
  cookies: string[];
  headers: http.IncomingHttpHeaders;
}

const TEST_ORIGIN = "http://127.0.0.1";

function cookieHeader(setCookies: string[]): string {
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

function request(
  port: number,
  opts: {
    method?: string;
    path: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
    omitOrigin?: boolean;
  }
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const data =
      opts.rawBody !== undefined
        ? opts.rawBody
        : opts.body !== undefined
          ? JSON.stringify(opts.body)
          : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: opts.path,
        method: opts.method || "GET",
        headers: {
          ...(!opts.omitOrigin && opts.method && !["GET", "HEAD"].includes(opts.method)
            ? { origin: TEST_ORIGIN }
            : {}),
          ...(data
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(data),
              }
            : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          if (text) {
            try {
              json = JSON.parse(text);
            } catch {
              json = text;
            }
          }
          resolve({
            status: res.statusCode || 0,
            json,
            cookies: res.headers["set-cookie"] || [],
            headers: res.headers,
          });
        });
      }
    );
    req.on("error", reject);
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function rejectedUpgrade(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode || 0));
    ws.once("open", () => reject(new Error("WebSocket unexpectedly opened")));
    ws.once("error", () => undefined);
  });
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("timed out waiting for worker message"));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (err) {
        reject(err);
      }
    };
    ws.once("message", onMessage);
  });
}

test("control API", async (t) => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-sess-"));
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    username: "operator",
    password: "correct-horse",
    sessionSecret: "test-session-secret-value",
    sessionDays: 30,
    workerToken: "test-worker-token",
    publicOrigin: "http://127.0.0.1",
    sessionDir,
    environment: "test",
    trustProxy: false,
    workerRequestTimeoutMs: 250,
  };

  let started: StartedServer | undefined;
  let port = 0;
  let cookie = "";

  try {
    started = await startServer(config);
    port = started.port;

    await t.test("missing lazy assets return uncached 404 while HTML routes revalidate", async () => {
      for (const method of ["GET", "HEAD"]) {
        const asset = await request(port, { method, path: "/assets/MarkdownViewer-removed-release.js" });
        assert.equal(asset.status, 404);
        assert.equal(asset.headers["cache-control"], "no-store");
        assert.match(String(asset.headers["content-type"]), /application\/json/);
        if (method === "GET") assert.deepEqual(asset.json, { error: "Asset not found" });
      }
      for (const route of ["/", "/index.html", "/agents/example-slot"]) {
        const page = await request(port, { path: route });
        assert.equal(page.status, 200);
        assert.match(String(page.headers["content-type"]), /text\/html/);
        assert.equal(page.headers["cache-control"], "no-cache, max-age=0, must-revalidate");
        assert.equal(typeof page.json, "string");
        assert.match(page.json as string, /<!doctype html>/i);
      }
    });

    await t.test("rejects invalid login", async () => {
      const missing = await request(port, {
        method: "POST",
        path: "/api/login",
        body: { username: "operator" },
      });
      assert.equal(missing.status, 400);

      const bad = await request(port, {
        method: "POST",
        path: "/api/login",
        body: { username: "operator", password: "wrong" },
      });
      assert.equal(bad.status, 401);
      assert.equal((bad.json as { error?: string }).error, "Invalid credentials");
    });

    await t.test("issues a session and protects routes", async () => {
      const healthz = await request(port, { path: "/api/healthz" });
      assert.equal(healthz.status, 200);
      assert.deepEqual(healthz.json, { ok: true });
      assert.equal(healthz.headers["x-powered-by"], undefined);
      assert.match(String(healthz.headers["content-security-policy"]), /default-src 'self'/);
      assert.equal(healthz.headers["cache-control"], "no-store");

      const unauthMe = await request(port, { path: "/api/me" });
      assert.equal(unauthMe.status, 401);

      const unauthHealth = await request(port, { path: "/api/health" });
      assert.equal(unauthHealth.status, 401);

      const login = await request(port, {
        method: "POST",
        path: "/api/login",
        body: { username: "operator", password: "correct-horse" },
      });
      assert.equal(login.status, 200);
      assert.equal((login.json as { ok?: boolean }).ok, true);
      cookie = cookieHeader(login.cookies);
      assert.ok(cookie.includes("ra.sid="));
      assert.ok(login.cookies[0].includes("HttpOnly"));
      assert.ok(login.cookies[0].includes("SameSite=Strict"));

      const me = await request(port, {
        path: "/api/me",
        headers: { cookie },
      });
      assert.equal(me.status, 200);
      assert.deepEqual(me.json, { username: "operator" });

      const health = await request(port, {
        path: "/api/health",
        headers: { cookie },
      });
      assert.equal(health.status, 200);
      const report = health.json as { workerConnected?: boolean };
      assert.equal(report.workerConnected, false);

      const agents = await request(port, {
        path: "/api/agents",
        headers: { cookie },
      });
      assert.equal(agents.status, 200);
      const list = agents.json as Array<{ id: string; status: string }>;
      assert.deepEqual(
        list.map((a) => a.id).sort(),
        DEFAULT_AGENTS.map((a) => a.id).sort()
      );
      assert.ok(list.every((a) => a.status === "offline"));
    });

    await t.test("returns 503 when the worker is down", async () => {
      const res = await request(port, {
        method: "POST",
        path: "/api/agents/agent-1/message",
        headers: { cookie },
        body: { text: "hello", mode: "interrupt" },
      });
      assert.equal(res.status, 503);
      assert.deepEqual({ ...(res.json as object), commandId: "id" }, {
        error: "Worker unavailable; command was not sent", code: "WORKER_OFFLINE", acceptance: "not_sent", commandId: "id",
      });
    });

    await t.test("enforces origin checks on cookie-authenticated mutations", async () => {
      const crossSite = await request(port, {
        method: "POST",
        path: "/api/logout",
        headers: { cookie, origin: "https://evil.example" },
      });
      assert.equal(crossSite.status, 403);

      const missingOrigin = await request(port, {
        method: "POST",
        path: "/api/login",
        body: { username: "operator", password: "correct-horse" },
        omitOrigin: true,
      });
      assert.equal(missingOrigin.status, 403);

      const stillAuthenticated = await request(port, {
        path: "/api/me",
        headers: { cookie },
      });
      assert.equal(stillAuthenticated.status, 200);
    });

    await t.test("rejects malformed and oversized request bodies safely", async () => {
      const malformed = await request(port, {
        method: "POST",
        path: "/api/login",
        rawBody: '{"username":',
      });
      assert.equal(malformed.status, 400);
      assert.deepEqual(malformed.json, { error: "Invalid request body" });

      const oversizedBody = await request(port, {
        method: "POST",
        path: "/api/login",
        rawBody: JSON.stringify({ value: "x".repeat(300 * 1024) }),
      });
      assert.equal(oversizedBody.status, 413);
      assert.deepEqual(oversizedBody.json, { error: "Request body is too large" });

      const oversizedField = await request(port, {
        method: "POST",
        path: "/api/agents/agent-1/message",
        headers: { cookie },
        body: { text: "x".repeat(64 * 1024 + 1), mode: "queue" },
      });
      assert.equal(oversizedField.status, 400);
    });

    await t.test("protects UI and worker websocket upgrades", async () => {
      const noOrigin = new WebSocket(`ws://127.0.0.1:${port}/ws/ui`, {
        headers: { cookie },
      });
      assert.equal(await rejectedUpgrade(noOrigin), 403);

      const noSession = new WebSocket(`ws://127.0.0.1:${port}/ws/ui`, {
        origin: TEST_ORIGIN,
      });
      assert.equal(await rejectedUpgrade(noSession), 401);

      const ui = new WebSocket(`ws://127.0.0.1:${port}/ws/ui`, {
        origin: TEST_ORIGIN,
        headers: { cookie },
      });
      await waitForOpen(ui);
      const uiClosed = closeCode(ui);
      ui.close();
      await uiClosed;

      const queryToken = new WebSocket(
        `ws://127.0.0.1:${port}/ws/worker?token=test-worker-token`
      );
      assert.equal(await rejectedUpgrade(queryToken), 401);
    });

    await t.test("negotiates compact initial UI snapshots without changing upgrade authentication", async () => {
      const noSession = new WebSocket(`ws://127.0.0.1:${port}/ws/ui?protocol=2`, { origin: TEST_ORIGIN });
      assert.equal(await rejectedUpgrade(noSession), 401);
      const ui = new WebSocket(`ws://127.0.0.1:${port}/ws/ui?protocol=2`, {
        origin: TEST_ORIGIN, headers: { cookie },
      });
      const messages: Record<string, unknown>[] = [];
      ui.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
      try {
        await waitForOpen(ui);
        for (let i = 0; i < 100 && messages.length < 2; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.deepEqual(messages.map((message) => message.type), ["health", "agents"]);
        assert.ok(messages[0].health);
        assert.ok(Array.isArray(messages[1].agents));
        assert.equal(messages.some((message) => "payload" in message), false);
      } finally {
        const closed = closeCode(ui);
        ui.close();
        await closed;
      }
    });

    await t.test("requires worker hello before other messages", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`, {
        headers: { Authorization: "Bearer test-worker-token" },
      });
      await waitForOpen(ws);
      const closed = closeCode(ws);
      ws.send(
        JSON.stringify({
          type: "heartbeat",
          health: emptyHealth(),
          agents: [],
        })
      );
      assert.equal(await closed, 1008);
      for (let i = 0; i < 20 && started?.store.isWorkerConnected(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(started?.store.isWorkerConnected(), false);
    });

    await t.test("disconnects a worker that sends an invalid nested schema", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`, {
        headers: { Authorization: "Bearer test-worker-token" },
      });
      await waitForOpen(ws);
      ws.send(
        JSON.stringify({
          type: "hello",
          workerId: "schema-test",
          health: emptyHealth(),
          agents: [],
        })
      );
      const closed = closeCode(ws);
      ws.send(
        JSON.stringify({
          type: "agent_update",
          agent: { ...emptyAgent("agent-1", "Agent 1", "model"), percent: 101 },
        })
      );
      assert.equal(await closed, 1008);
      for (let i = 0; i < 20 && started?.store.isWorkerConnected(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(started?.store.isWorkerConnected(), false);
    });

    await t.test("closes an oversized worker websocket frame", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`, {
        headers: { Authorization: "Bearer test-worker-token" },
      });
      await waitForOpen(ws);
      const closed = closeCode(ws);
      ws.send("x".repeat(MAX_WS_MESSAGE_BYTES + 1));
      assert.equal(await closed, 1009);
      assert.equal(started?.store.isWorkerConnected(), false);
    });

    await t.test("forwards interrupt vs queue command shapes to the worker", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`, {
        headers: { Authorization: "Bearer test-worker-token" },
      });
      await waitForOpen(ws);

      ws.send(
        JSON.stringify({
          type: "hello",
          workerId: "mock-worker",
          health: {
            ...emptyHealth(),
            ok: true,
            workerConnected: true,
            issues: [],
          },
          agents: [
            ...CORE_AGENTS.map((a, index) => ({
              ...emptyAgent(a.id, a.name, a.defaultModel),
              status: "idle",
              headline: index === 0 ? "token=super-secret-value" : "Ready",
              fullLog: index === 0 ? "Authorization: Bearer abcdefghijklmnop" : "",
            })),
            {
              ...emptyAgent("fleet-dynamic-1", "Dynamic", "provider-new-model", "extra"),
              provider: "cursor",
              availableModels: ["provider-new-model"],
              status: "idle",
              headline: "Ready",
            },
          ],
        })
      );

      let connected = false;
      for (let i = 0; i < 20; i++) {
        const health = await request(port, {
          path: "/api/health",
          headers: { cookie },
        });
        if ((health.json as { workerConnected?: boolean }).workerConnected) {
          connected = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(connected, true);

      const fleet = await request(port, {
        path: "/api/agents",
        headers: { cookie },
      });
      const fleetAgents = fleet.json as Array<{
        id: string;
        headline: string;
        fullLog: string;
        provider?: string;
      }>;
      const first = fleetAgents.find((agent) => agent.id === "agent-1");
      assert.equal(first?.headline, "token=[REDACTED]");
      assert.equal(first?.fullLog, "Authorization: [REDACTED]");
      assert.equal(
        fleetAgents.find((agent) => agent.id === "fleet-dynamic-1")?.provider,
        "cursor"
      );
      const models = await request(port, {
        path: "/api/models",
        headers: { cookie },
      });
      assert.ok(
        (models.json as Array<{ id: string }>).some(
          (model) => model.id === "provider-new-model"
        )
      );

      ws.send(
        JSON.stringify({
          type: "heartbeat",
          health: {
            ...emptyHealth(),
            ok: true,
            workerConnected: true,
            issues: [],
            host: {
              ...emptyHealth().host,
              hostname: "heartbeat-marker",
            },
          },
          agents: [],
        })
      );
      for (
        let i = 0;
        i < 20 &&
        started?.store.getHealth().host.hostname !== "heartbeat-marker";
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        started?.store.getHealth().host.hostname,
        "heartbeat-marker"
      );
      const afterHeartbeatResponse = await request(port, {
        path: "/api/agents",
        headers: { cookie },
      });
      const afterEmptyHeartbeat = afterHeartbeatResponse.json as Array<{
        id: string;
        headline: string;
      }>;
      assert.equal(
        afterEmptyHeartbeat.find((agent) => agent.id === "agent-1")?.headline,
        "token=[REDACTED]"
      );
      assert.ok(
        afterEmptyHeartbeat.some((agent) => agent.id === "fleet-dynamic-1")
      );

      let ignoreNext = false;
      ws.on("message", (raw) => {
        const cmd = JSON.parse(raw.toString()) as ServerToWorker;
        if (ignoreNext) {
          ignoreNext = false;
          return;
        }
        ws.send(JSON.stringify({ type: "ack", commandId: cmd.commandId, ok: cmd.type !== "set_model", error: cmd.type === "set_model" ? "Unsupported provider" : undefined }));
      });
      const waitInterrupt = nextMessage(ws);
      const interrupt = await request(port, {
        method: "POST",
        path: "/api/agents/agent-1/message",
        headers: { cookie },
        body: { text: "stop and do this now", mode: "interrupt" },
      });
      assert.equal(interrupt.status, 200);
      const interruptCmd = (await waitInterrupt) as ServerToWorker;
      assert.equal(interruptCmd.type, "command");
      if (interruptCmd.type === "command") {
        assert.equal(interruptCmd.mode, "interrupt");
        assert.equal(interruptCmd.text, "stop and do this now");
        assert.equal(interruptCmd.agentId, "agent-1");
        assert.ok(interruptCmd.commandId);
        assert.equal(
          (interrupt.json as { commandId?: string }).commandId,
          interruptCmd.commandId
        );
      }

      const waitDocument = nextMessage(ws);
      const document = await request(port, {
        method: "POST", path: "/api/agents/agent-1/markdown", headers: { cookie },
        body: { path: "reports/mobile-guide.md", instruct: "Include a getting started section." },
      });
      assert.equal(document.status, 200);
      const documentCmd = await waitDocument as ServerToWorker;
      assert.equal(documentCmd.type, "command");
      if (documentCmd.type === "command") {
        assert.match(documentCmd.text, /"reports\/mobile-guide\.md"/);
        assert.match(documentCmd.text, /Include a getting started section\./);
        assert.equal(documentCmd.mode, "queue");
      }
      for (const path of ["../outside.md", "/absolute.md", "C:/outside.md", "reports\\outside.md", "reports/file.txt", "reports/\nfile.md"]) {
        const invalidDocument = await request(port, {
          method: "POST", path: "/api/agents/agent-1/markdown", headers: { cookie }, body: { path },
        });
        assert.equal(invalidDocument.status, 400, path);
      }
      const oversizedDocument = await request(port, {
        method: "POST", path: "/api/agents/agent-1/markdown", headers: { cookie },
        body: { path: "report.md", instruct: "x".repeat(64 * 1024) },
      });
      assert.equal(oversizedDocument.status, 400);

      const waitQueue = nextMessage(ws);
      const queued = await request(port, {
        method: "POST",
        path: "/api/agents/agent-2/message",
        headers: { cookie },
        body: { text: "when you have a moment", mode: "queue" },
      });
      assert.equal(queued.status, 200);
      const queueCmd = (await waitQueue) as ServerToWorker;
      assert.equal(queueCmd.type, "command");
      if (queueCmd.type === "command") {
        assert.equal(queueCmd.mode, "queue");
        assert.equal(queueCmd.text, "when you have a moment");
        assert.equal(queueCmd.agentId, "agent-2");
        assert.ok(queueCmd.commandId);
        assert.notEqual(
          queueCmd.commandId,
          (interruptCmd as { commandId: string }).commandId
        );
      }

      for (const body of [{}, { runId: "" }, { runId: "x".repeat(129) }, { runId: "bad\u0000id" }]) {
        const invalidStop = await request(port, { method: "POST", path: "/api/agents/agent-1/stop", headers: { cookie }, body });
        assert.equal(invalidStop.status, 400);
      }
      assert.equal((await request(port, { method: "POST", path: "/api/agents/agent-1/stop", body: { runId: "run-1" } })).status, 401);
      assert.equal((await request(port, { method: "DELETE", path: "/api/agents/agent-1/queue/queued-1" })).status, 401);
      assert.equal((await request(port, { method: "DELETE", path: "/api/agents/agent-1/queue/queued-1", headers: { cookie, origin: "https://wrong.example" } })).status, 403);
      assert.equal((await request(port, { method: "POST", path: "/api/agents/missing/stop", headers: { cookie }, body: { runId: "run-1" } })).status, 404);
      assert.equal((await request(port, { method: "DELETE", path: "/api/agents/missing/queue/queued-1", headers: { cookie } })).status, 404);
      assert.equal((await request(port, { method: "DELETE", path: `/api/agents/agent-1/queue/${"x".repeat(129)}`, headers: { cookie } })).status, 400);

      // A successful HTTP response requires the real worker acknowledgement.
      ignoreNext = true;
      const stopMessage = nextMessage(ws);
      let stopResponded = false;
      const stopResponse = request(port, { method: "POST", path: "/api/agents/agent-1/stop", headers: { cookie }, body: { runId: "run-1" } }).then((response) => { stopResponded = true; return response; });
      const stopCommand = await stopMessage as ServerToWorker;
      assert.equal(stopCommand.type, "stop_agent");
      if (stopCommand.type === "stop_agent") assert.equal(stopCommand.runId, "run-1");
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(stopResponded, false);
      ws.send(JSON.stringify({ type: "ack", commandId: stopCommand.commandId, ok: true }));
      assert.equal((await stopResponse).status, 200);

      const removeMessage = nextMessage(ws);
      const removeResponse = await request(port, { method: "DELETE", path: "/api/agents/agent-1/queue/queued-1", headers: { cookie } });
      const removeCommand = await removeMessage as ServerToWorker;
      assert.equal(removeResponse.status, 200);
      assert.equal(removeCommand.type, "remove_queued_instruction");
      if (removeCommand.type === "remove_queued_instruction") assert.equal(removeCommand.instructionId, "queued-1");

      for (const action of [
        { method: "POST", path: "/api/agents/agent-1/stop", body: { runId: "stale-run" }, error: "This task is no longer active. Refresh activity." },
        { method: "DELETE", path: "/api/agents/agent-1/queue/started-item", error: "This instruction is no longer queued; it may have started." },
      ]) {
        ignoreNext = true;
        const commandMessage = nextMessage(ws);
        const response = request(port, { ...action, headers: { cookie } });
        const command = await commandMessage as ServerToWorker;
        ws.send(JSON.stringify({ type: "ack", commandId: command.commandId, ok: false, error: action.error }));
        const conflict = await response;
        assert.equal(conflict.status, 409);
        assert.equal((conflict.json as { error: string }).error, action.error);
      }

      const rejected = await request(port, {
        method: "POST", path: "/api/agents/agent-1/model", headers: { cookie }, body: { model: "gpt-6-astra" },
      });
      assert.equal(rejected.status, 502);
      assert.equal((rejected.json as {error:string}).error, "Worker rejected command");

      ignoreNext = true;
      const pendingCommand = nextMessage(ws);
      const timedOut = await request(port, {
        method: "POST",
        path: "/api/agents/agent-1/cwd",
        headers: { cookie },
        body: { cwd: "/tmp" },
      });
      assert.equal(timedOut.status, 503);
      const uncertain = timedOut.json as { code: string; commandId: string; acceptance: string; error: string };
      assert.equal(uncertain.code, "ACK_TIMEOUT");
      assert.equal(uncertain.acceptance, "unknown");
      assert.match(uncertain.error, /may already be queued.*Check the agent before retrying/);
      const original = await pendingCommand as ServerToWorker;
      assert.equal(uncertain.commandId, original.commandId);
      ws.send(JSON.stringify({ type: "ack", commandId: original.commandId, ok: true }));
      // A late acknowledgement cannot change the response into safe-to-retry.
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(uncertain.acceptance, "unknown");

      ws.close();
      await new Promise((resolve) => ws.once("close", resolve));
      const offline = await request(port, {path:"/api/agents",headers:{cookie}});
      assert.ok((offline.json as Array<{status:string}>).every((a) => a.status === "offline"));
    });

    await t.test("rate limits repeated login attempts", async () => {
      let response: HttpResult | undefined;
      for (let i = 0; i < 6; i++) {
        response = await request(port, {
          method: "POST",
          path: "/api/login",
          body: { username: "operator", password: "wrong" },
        });
      }
      assert.equal(response?.status, 429);
      assert.equal((response?.json as { error?: string }).error, "Too many login attempts");
    });

    await t.test("destroys the session on same-origin logout", async () => {
      const logout = await request(port, {
        method: "POST",
        path: "/api/logout",
        headers: { cookie },
      });
      assert.equal(logout.status, 200);
      assert.ok(logout.cookies.some((value) => value.startsWith("ra.sid=;")));
      const me = await request(port, { path: "/api/me", headers: { cookie } });
      assert.equal(me.status, 401);
    });
  } finally {
    if (started) {
      await started.close();
    }
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  }
});

test("secure session cookie honors an explicitly trusted TLS proxy", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-secure-sess-"));
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    username: "operator",
    password: "correct-horse",
    sessionSecret: "test-session-secret-value",
    sessionDays: 1,
    workerToken: "test-worker-token",
    publicOrigin: "https://control.example",
    sessionDir,
    environment: "test",
    trustProxy: 1,
  };
  const started = await startServer(config);
  try {
    const login = await request(started.port, {
      method: "POST",
      path: "/api/login",
      headers: {
        origin: "https://control.example",
        "x-forwarded-proto": "https",
      },
      body: { username: "operator", password: "correct-horse" },
    });
    assert.equal(login.status, 200);
    assert.ok(login.cookies[0].includes("Secure"));
    assert.ok(login.cookies[0].includes("SameSite=Strict"));
  } finally {
    await started.close();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
