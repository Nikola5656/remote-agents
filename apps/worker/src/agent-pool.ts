import type {
  AgentSnapshot,
  AgentKind,
  ModelProvider,
  ServerToWorker,
  WorkspaceFileContent,
  WorkspaceFileInfo,
} from "@remote-agents/shared";
import { DEFAULT_AGENTS, MODEL_CATALOG, modelProvider, canonicalModelId } from "@remote-agents/shared";
import { AgentSlot } from "./agent-slot";
import type { FleetAgent, WorkerConfig } from "./config";
import type { SdkHealth } from "./health";
import { log } from "./log";
import { AgentStore } from "./persist";
import type { ClaudeLauncher, CursorRuntime } from "./runtime";
import { listMarkdownFiles, readMarkdownFile } from "./workspace-files";
import { ensureWorkspace, resolveAgentWorkspace } from "./workspace";

function runtimeDetail(kind: string): string {
  if (kind === "bridge") return "IDE bridge active (chats run live in the Cursor sidebar)";
  if (kind === "machine") return "Cloud machine agents ready (live in IDE sidebar)";
  if (kind === "cli") return "Cursor chats ready";
  return "Cursor SDK ready";
}

export interface PoolOptions {
  config: WorkerConfig;
  runtime: CursorRuntime;
  codexRuntime?: CursorRuntime;
  claudeRuntime?: CursorRuntime;
  providerHealth?: Partial<Record<ModelProvider, () => { ready: boolean; detail: string }>>;
  claude: ClaudeLauncher;
  store?: AgentStore;
  onAgentUpdate?: (agent: AgentSnapshot) => void;
}

export class AgentPool {
  private readonly slots = new Map<string, AgentSlot>();
  private readonly store: AgentStore;
  private extraSeq = 1;
  private readonly providers = new Map<string, ModelProvider>();
  private readonly providerModels = new Map<ModelProvider, string[]>();
  private readonly providerErrors = new Map<ModelProvider, string>();
  private sdkReady = false;
  private sdkDetail = "Starting";
  private readonly onAgentUpdate?: (agent: AgentSnapshot) => void;

  constructor(private readonly opts: PoolOptions) {
    this.store = opts.store || new AgentStore(`${opts.config.dataDir}/agents.json`);
    this.onAgentUpdate = opts.onAgentUpdate;
  }

  async start(): Promise<void> {
    const persisted = this.store.load();
    const fleet: FleetAgent[] = this.opts.config.fleet ?? DEFAULT_AGENTS;
    await Promise.all((["cursor", "codex", "claude"] as const).map(async (provider) => {
      const catalog = MODEL_CATALOG.filter((m) => modelProvider(m.id) === provider).map((m) => m.id);
      this.providerModels.set(provider, catalog);
      const runtime = this.runtimeFor(provider);
      try {
        if (!runtime || runtime.kind === "degraded") throw new Error(`${provider} runtime is not available on this worker`);
        const health = this.opts.providerHealth?.[provider]?.();
        if (health && !health.ready) throw new Error(health.detail);
        const available = await runtime.listModels(provider === "cursor" ? this.opts.config.cursorApiKey : undefined);
        this.providerModels.set(provider, available.filter((id) => catalog.includes(id)));
      } catch (error) {
        this.providerErrors.set(provider, error instanceof Error ? error.message : String(error));
      }
    }));
    this.sdkReady = !this.providerErrors.has("cursor");
    this.sdkDetail = this.providerErrors.get("cursor") ?? runtimeDetail(this.opts.runtime.kind);

    for (const definition of fleet) {
      const saved = persisted.agents[definition.id];
      let cwd: string;
      let workspaceError: string | undefined;
      try {
        cwd = this.workspaceFor(definition.id, definition.name, definition.cwd, saved?.cwd);
      } catch (error) {
        cwd = definition.cwd ?? saved?.cwd ?? this.opts.config.workspacesRoot;
        workspaceError = `Workspace unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.slots.set(definition.id, this.makeSlot({
        id: definition.id, name: definition.name, kind: definition.kind ?? "extra",
        provider: definition.provider,
        model: canonicalModelId(saved?.model || definition.defaultModel), cwd, persisted: saved,
        startupError: workspaceError || saved?.restoreError || (saved?.provider && saved.provider !== definition.provider
          ? `Saved provider ${saved.provider} conflicts with configured provider ${definition.provider}; state was not reassigned`
          : undefined),
      }));
    }

    // A custom fleet is authoritative. Unlisted persisted slots stay on disk,
    // but are not silently reintroduced into the configured roster.
    if (!this.opts.config.fleetFile) for (const [id, saved] of Object.entries(persisted.agents)) {
      if (this.slots.has(id) || !["extra", "claude"].includes(saved.kind)) continue;
      let cwd = saved.cwd ?? this.opts.config.workspacesRoot;
      let startupError: string | undefined;
      try { cwd = this.workspaceFor(id, saved.name, undefined, saved.cwd); }
      catch (error) { startupError = `Workspace unavailable: ${error instanceof Error ? error.message : String(error)}`; }
      this.slots.set(id, this.makeSlot({
        id, name: saved.name, kind: saved.kind, provider: saved.provider ?? modelProvider(saved.model),
        model: canonicalModelId(saved.model), cwd, persisted: saved, startupError: startupError || saved.restoreError,
      }));
    }
    for (const id of Object.keys(persisted.agents).concat([...this.slots.keys()])) {
      const match = /^extra-(\d+)$/.exec(id);
      if (match) this.extraSeq = Math.max(this.extraSeq, Number(match[1]) + 1);
    }

    await Promise.allSettled([...this.slots.values()].map((slot) => slot.boot()));
    if (fleet.some((agent) => agent.provider === "cursor")) {
      this.sdkReady = [...this.slots.values()].some((slot) => this.providers.get(slot.id) === "cursor" && slot.snapshot().status === "idle");
      if (!this.sdkReady && !this.providerErrors.has("cursor")) this.sdkDetail = "Cursor slots failed to initialize; inspect individual errors";
    }

    log("agent pool ready", [...this.slots.keys()].join(", "), this.opts.runtime.kind);
  }

  snapshots(): AgentSnapshot[] {
    return [...this.slots.values()].map((s) => this.withProvider(s.snapshot()));
  }

  get(id: string): AgentSlot | undefined {
    return this.slots.get(id);
  }

  sdkHealth(): SdkHealth {
    if (![...this.providers.values()].includes("cursor")) return { ready: true, apiKeyPresent: Boolean(this.opts.config.cursorApiKey), detail: "Cursor is not configured in this fleet" };
    return {
      ready: this.sdkReady,
      apiKeyPresent: Boolean(this.opts.config.cursorApiKey),
      detail: this.sdkDetail,
    };
  }

  async dispatch(
    msg: ServerToWorker
  ): Promise<{ files?: WorkspaceFileInfo[]; file?: WorkspaceFileContent } | void> {
    switch (msg.type) {
      case "stop_agent": {
        await this.require(msg.agentId).stopRun(msg.runId);
        return;
      }
      case "remove_queued_instruction": {
        this.require(msg.agentId).removeQueuedInstruction(msg.instructionId);
        return;
      }
      case "command": {
        const slot = this.require(msg.agentId);
        slot.handleInstruction(msg.text, msg.mode);
        return;
      }
      case "set_model": {
        const slot = this.require(msg.agentId);
        const model = canonicalModelId(msg.model);
        if (modelProvider(model) !== this.providers.get(slot.id)) throw new Error("Choose a model from this agent’s provider, or create another agent.");
        if (!this.modelsFor(this.providers.get(slot.id)!).includes(model)) throw new Error(`Unsupported model: ${model}`);
        slot.setModel(model);
        return;
      }
      case "set_output_mode": {
        const slot = this.require(msg.agentId);
        slot.setOutputMode(msg.outputMode);
        return;
      }
      case "spawn_agent": {
        const provider = modelProvider(canonicalModelId(msg.model));
        const models = this.providerModels.get(provider) ?? [];
        if (!models.includes(canonicalModelId(msg.model))) throw new Error(`Unsupported model: ${msg.model}`);
        const id = `extra-${this.extraSeq++}`;
        const slot = this.makeSlot({
          id,
          name: msg.name,
          kind: provider === "claude" ? "claude" : "extra",
          provider,
          model: canonicalModelId(msg.model),
          cwd: this.workspaceFor(id, msg.name, msg.cwd),
        });
        this.slots.set(id, slot);
        await slot.boot();
        log("spawned extra agent", id, msg.name);
        return;
      }
      case "spawn_claude": {
        const slot = this.require(msg.agentId);
        slot.spawnClaude(msg.text, msg.mode);
        return;
      }
      case "stop_claude": {
        const slot = this.require(msg.agentId);
        slot.stopClaude(msg.mode);
        return;
      }
      case "set_cwd": {
        const slot = this.require(msg.agentId);
        await slot.setCwd(
          this.workspaceFor(slot.id, slot.name, msg.cwd, slot.cwd)
        );
        return;
      }
      case "list_files": {
        const slot = this.require(msg.agentId);
        return { files: listMarkdownFiles(slot.cwd) };
      }
      case "read_file": {
        const slot = this.require(msg.agentId);
        return { file: readMarkdownFile(slot.cwd, msg.path) };
      }
      default: {
        const _never: never = msg;
        throw new Error(`Unknown command ${(_never as { type: string }).type}`);
      }
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.slots.values()].map((s) => s.dispose()));
  }

  private workspaceFor(
    id: string,
    _name: string,
    explicitCwd?: string,
    savedCwd?: string
  ): string {
    // An explicit user-selected folder is authoritative; it is not a sandbox.
    if (explicitCwd?.trim()) return ensureWorkspace(explicitCwd);
    return resolveAgentWorkspace({
      agentId: id,
      explicitCwd,
      savedCwd,
      sharedCwd: this.opts.config.defaultCwd,
      workspacesRoot: this.opts.config.workspacesRoot,
      controlRoot: this.opts.config.controlRoot,
    });
  }

  private require(agentId: string): AgentSlot {
    const slot = this.slots.get(agentId);
    if (!slot) throw new Error(`Unknown agent ${agentId}`);
    return slot;
  }

  private runtimeFor(provider: ModelProvider): CursorRuntime | undefined {
    if (provider === "codex") return this.opts.codexRuntime;
    if (provider === "claude") return this.opts.claudeRuntime;
    return this.opts.runtime;
  }

  private modelsFor(provider: ModelProvider): string[] {
    return this.providerModels.get(provider) ?? [];
  }

  private withProvider(snapshot: AgentSnapshot): AgentSnapshot {
    const provider = this.providers.get(snapshot.id) ?? modelProvider(snapshot.model);
    return { ...snapshot, provider, availableModels: this.modelsFor(provider), reasoningEffort: provider === "codex" ? "medium" : undefined };
  }

  private makeSlot(input: {
    id: string;
    name: string;
    kind: AgentKind;
    provider: ModelProvider;
    startupError?: string;
    model: string;
    cwd: string;
    persisted?: import("./persist").PersistedSlot;
  }): AgentSlot {
    this.providers.set(input.id, input.provider);
    const target = this.runtimeFor(input.provider);
    // Fail closed at create/resume; never execute a different provider or model.
    const validate = (model: string): void => {
      const error = input.startupError || this.providerErrors.get(input.provider);
      if (error) throw new Error(error);
      if (!target) throw new Error(`${input.provider} runtime is not configured on this worker`);
      if (modelProvider(model) !== input.provider || !this.modelsFor(input.provider).includes(model)) {
        throw new Error(`Requested ${input.provider} model ${model} is unavailable; no substitution was made`);
      }
    };
    const runtime: CursorRuntime = {
      kind: target?.kind ?? "degraded",
      transcript: target?.transcript,
      isResumableId: target?.isResumableId?.bind(target),
      listModels: async () => this.modelsFor(input.provider),
      create: async (args) => { validate(args.model); return target!.create(args); },
      resume: async (id, args) => { validate(args.model); return target!.resume(id, args); },
    };
    return new AgentSlot({
      id: input.id,
      name: input.name,
      kind: input.kind,
      model: input.model,
      cwd: input.cwd,
      apiKey: input.provider === "cursor" ? this.opts.config.cursorApiKey : "",
      runtime,
      claude: this.opts.claude,
      claudeBin: this.opts.config.claudeBin,
      availableModels: this.modelsFor(input.provider),
      store: this.store,
      persisted: input.persisted,
      onUpdate: (snap) => this.onAgentUpdate?.(this.withProvider(snap)),
      mirror: runtime.transcript ?? null,
    });
  }
}
