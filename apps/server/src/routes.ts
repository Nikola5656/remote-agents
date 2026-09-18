import { Request, Response, Router } from "express";
import {
  DeliveryMode,
  MODEL_CATALOG,
  OutputMode,
  ServerToWorker,
} from "@remote-agents/shared";
import { ServerConfig } from "./env";
import { AgentStore } from "./store";
import { requireAuth, SESSION_COOKIE_NAME, verifyCredentials } from "./auth";
import { WorkerHub, WorkerRequestError } from "./ws";
import { randomBytes, randomUUID } from "crypto";

function newCommandId(): string {
  if (typeof randomUUID === "function") {
    return randomUUID();
  }
  return randomBytes(16).toString("hex");
}

function readBoundedString(
  value: unknown,
  max: number,
  options: { trim?: boolean; allowEmpty?: boolean } = {}
): string | undefined {
  if (typeof value !== "string" || value.length > max || value.includes("\u0000")) {
    return undefined;
  }
  const result = options.trim === false ? value : value.trim();
  if (!options.allowEmpty && !result) return undefined;
  return result;
}

function parseDeliveryMode(value: unknown): DeliveryMode | undefined {
  return value === "interrupt" || value === "queue" ? value : undefined;
}

function parseOutputMode(value: unknown): OutputMode | undefined {
  return value === "condensed" || value === "full" ? value : undefined;
}

function sendOrOffline(
  workerHub: WorkerHub,
  message: ServerToWorker,
  res: Response,
  conflictOnReject = false
): void {
  void workerHub
    .request(message)
    .then((ack) => {
      if (!ack.ok) {
        res.status(conflictOnReject ? 409 : 502).json({ error: conflictOnReject ? ack.error || "Worker rejected command; refresh activity and try again." : "Worker rejected command" });
        return;
      }
      res.json({ ok: true, commandId: message.commandId });
    })
    .catch((error: unknown) => {
      if (error instanceof WorkerRequestError) {
        res.status(503).json({ error: error.message, code: error.code,
          commandId: message.commandId, acceptance: error.code === "WORKER_OFFLINE" ? "not_sent" : "unknown" });
        return;
      }
      res.status(503).json({ error: "Worker unavailable" });
    });
}

export function createApiRouter(options: {
  config: ServerConfig;
  store: AgentStore;
  workerHub: WorkerHub;
}): Router {
  const { config, store, workerHub } = options;
  const router = Router();

  router.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  router.post("/login", async (req, res) => {
    const username = readBoundedString(req.body?.username, 128, { trim: false });
    const password = readBoundedString(req.body?.password, 1024, { trim: false });
    if (username === undefined || password === undefined) {
      res.status(400).json({ error: "username and password are required" });
      return;
    }
    const ok = await verifyCredentials(username, password, config);
    if (!ok) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    req.session.regenerate((err) => {
      if (err) {
        res.status(500).json({ error: "Session error" });
        return;
      }
      req.session.user = config.username;
      req.session.save((saveErr) => {
        if (saveErr) {
          res.status(500).json({ error: "Session error" });
          return;
        }
        res.json({ ok: true, username: config.username });
      });
    });
  });

  router.post("/logout", requireAuth, (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        res.status(500).json({ error: "Session error" });
        return;
      }
      res.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        sameSite: "strict",
        secure: config.publicOrigin.startsWith("https"),
        path: "/",
      });
      res.json({ ok: true });
    });
  });

  router.get("/me", requireAuth, (req, res) => {
    res.json({ username: req.session.user });
  });

  router.get("/health", requireAuth, (_req, res) => {
    const health = store.getHealth();
    res.json({ ...health, workerConnected: store.isWorkerConnected() });
  });

  router.get("/agents", requireAuth, (_req, res) => {
    res.json(store.listAgents());
  });

  router.get("/models", requireAuth, (_req, res) => {
    res.json(store.listModels(MODEL_CATALOG));
  });

  router.get("/agents/:id", requireAuth, (req, res) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(agent);
  });

  router.post("/agents/:id/message", requireAuth, (req, res) => {
    const text = readBoundedString(req.body?.text, 64 * 1024);
    const mode = parseDeliveryMode(req.body?.mode);
    if (!text || !mode) {
      res.status(400).json({ error: "text and mode (interrupt|queue) are required" });
      return;
    }
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    sendOrOffline(
      workerHub,
      {
        type: "command",
        commandId: newCommandId(),
        agentId: agent.id,
        mode,
        text,
      },
      res
    );
  });

  router.post("/agents/:id/stop", requireAuth, (req, res) => {
    const runId = readBoundedString(req.body?.runId, 128);
    if (!runId) {
      res.status(400).json({ error: "runId is required; refresh activity before stopping a task" });
      return;
    }
    const agent = store.getAgent(req.params.id);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    sendOrOffline(workerHub, { type: "stop_agent", commandId: newCommandId(), agentId: agent.id, runId }, res, true);
  });

  router.delete("/agents/:id/queue/:instructionId", requireAuth, (req, res) => {
    const instructionId = readBoundedString(req.params.instructionId, 128);
    if (!instructionId) { res.status(400).json({ error: "A valid queued instruction id is required" }); return; }
    const agent = store.getAgent(req.params.id);
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
    sendOrOffline(workerHub, { type: "remove_queued_instruction", commandId: newCommandId(), agentId: agent.id, instructionId }, res, true);
  });

  router.post("/agents/:id/model", requireAuth, (req, res) => {
    const model = readBoundedString(req.body?.model, 128);
    if (!model) {
      res.status(400).json({ error: "model is required" });
      return;
    }
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    sendOrOffline(
      workerHub,
      {
        type: "set_model",
        commandId: newCommandId(),
        agentId: agent.id,
        model,
      },
      res
    );
  });

  router.post("/agents/:id/output-mode", requireAuth, (req, res) => {
    const outputMode = parseOutputMode(req.body?.outputMode);
    if (!outputMode) {
      res
        .status(400)
        .json({ error: "outputMode (condensed|full) is required" });
      return;
    }
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    sendOrOffline(
      workerHub,
      {
        type: "set_output_mode",
        commandId: newCommandId(),
        agentId: agent.id,
        outputMode,
      },
      res
    );
  });

  router.post("/agents", requireAuth, (req, res) => {
    const name = readBoundedString(req.body?.name, 128);
    const model = readBoundedString(req.body?.model, 128);
    const cwd = readBoundedString(req.body?.cwd, 4096);
    if (!name || !model) {
      res.status(400).json({ error: "name and model are required" });
      return;
    }
    const message: ServerToWorker = {
      type: "spawn_agent",
      commandId: newCommandId(),
      name,
      model,
    };
    if (cwd) {
      message.cwd = cwd;
    }
    sendOrOffline(workerHub, message, res);
  });

  router.post("/agents/:id/claude", requireAuth, (req, res) => {
    const text = readBoundedString(req.body?.text, 64 * 1024);
    const mode = parseDeliveryMode(req.body?.mode);
    if (!text || !mode) {
      res.status(400).json({ error: "text and mode (interrupt|queue) are required" });
      return;
    }
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    sendOrOffline(
      workerHub,
      {
        type: "spawn_claude",
        commandId: newCommandId(),
        agentId: agent.id,
        text,
        mode,
      },
      res
    );
  });

  router.post("/agents/:id/cwd", requireAuth, (req, res) => {
    const cwd = readBoundedString(req.body?.cwd, 4096);
    if (!cwd) {
      res.status(400).json({ error: "cwd is required" });
      return;
    }
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    sendOrOffline(
      workerHub,
      {
        type: "set_cwd",
        commandId: newCommandId(),
        agentId: agent.id,
        cwd,
      },
      res
    );
  });

  router.get("/agents/:id/files", requireAuth, (req, res) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    void workerHub
      .request({
        type: "list_files",
        commandId: newCommandId(),
        agentId: agent.id,
      })
      .then((ack) => {
        if (!ack.ok) {
          res.status(502).json({ error: "Worker rejected list" });
          return;
        }
        res.json({ files: ack.files || [] });
      })
      .catch(() => {
        res.status(503).json({ error: "Worker unavailable" });
      });
  });

  router.get("/agents/:id/file", requireAuth, (req, res) => {
    const rel = readBoundedString(req.query.path, 4096);
    if (!rel) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    void workerHub
      .request({
        type: "read_file",
        commandId: newCommandId(),
        agentId: agent.id,
        path: rel,
      })
      .then((ack) => {
        if (!ack.ok || !ack.file) {
          res.status(ack.ok ? 404 : 502).json({
            error: ack.ok ? "File not found" : "Worker rejected file request",
          });
          return;
        }
        res.json(ack.file);
      })
      .catch(() => {
        res.status(503).json({ error: "Worker unavailable" });
      });
  });

  router.post("/agents/:id/markdown", requireAuth, (req, res) => {
    const rel = readBoundedString(req.body?.path, 4096);
    const instruct = readBoundedString(req.body?.instruct, 64 * 1024);
    const mode = parseDeliveryMode(req.body?.mode) || "queue";
    if (!rel) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    if (
      !/\.(md|markdown)$/i.test(rel) || /[\\\r\n]/.test(rel) ||
      rel.startsWith("/") || /^[a-z]:/i.test(rel) ||
      rel.split("/").some(part => !part || part === "." || part === "..")
    ) {
      res.status(400).json({ error: "path must be a relative Markdown file inside the workspace" });
      return;
    }
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const prompt = [
      `Create or update the markdown file named ${JSON.stringify(rel)} in this workspace. Write complete useful markdown into that file. Do not edit other files.`,
      instruct ? `Document requirements:\n${instruct}` : "",
    ].filter(Boolean).join("\n\n");
    if (prompt.length > 64 * 1024) {
      res.status(400).json({ error: "Document path and requirements are too long" });
      return;
    }
    sendOrOffline(
      workerHub,
      {
        type: "command",
        commandId: newCommandId(),
        agentId: agent.id,
        mode,
        text: prompt,
      },
      res
    );
  });

  router.post("/agents/:id/claude/stop", requireAuth, (req, res) => {
    const mode = parseDeliveryMode(req.body?.mode);
    if (!mode) {
      res.status(400).json({ error: "mode (interrupt|queue) is required" });
      return;
    }
    const agent = store.getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    sendOrOffline(
      workerHub,
      {
        type: "stop_claude",
        commandId: newCommandId(),
        agentId: agent.id,
        mode,
      },
      res
    );
  });

  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  return router;
}
