import {
  AgentSnapshot,
  CORE_AGENTS,
  DEFAULT_AGENTS,
  emptyAgent,
  emptyHealth,
  HealthReport,
  ModelOption,
  modelProvider,
} from "@remote-agents/shared";

const CORE_IDS = new Set<string>(CORE_AGENTS.map((a) => a.id));
const SEEDS = DEFAULT_AGENTS;

export class AgentStore {
  private health: HealthReport = emptyHealth();
  private agents = new Map<string, AgentSnapshot>();
  private workerConnected = false;
  private lastHeartbeatAt: number | null = null;

  constructor() {
    this.seedCoreAgents();
    this.syncHealthAgents();
  }

  private seedCoreAgents(): void {
    for (const agent of SEEDS) {
      this.agents.set(agent.id, this.seedValue(agent));
    }
  }

  private seedValue(agent: (typeof SEEDS)[number]): AgentSnapshot {
    const provider = modelProvider(agent.defaultModel);
    return {
      ...emptyAgent(
        agent.id,
        agent.name,
        agent.defaultModel,
        agent.kind ?? "extra"
      ),
      provider,
      availableModels: [agent.defaultModel],
    };
  }

  isWorkerConnected(): boolean {
    return this.workerConnected;
  }

  getHealth(): HealthReport {
    return {
      ...this.health,
      workerConnected: this.workerConnected,
      lastHeartbeatAt: this.lastHeartbeatAt,
      agents: this.listAgents().map((a) => ({
        id: a.id,
        present: this.workerConnected && a.status !== "offline",
        status: a.status,
      })),
    };
  }

  listAgents(): AgentSnapshot[] {
    const cores = CORE_AGENTS.map((c) => this.agents.get(c.id)).filter(
      (a): a is AgentSnapshot => Boolean(a)
    );
    const extras = [...this.agents.values()]
      .filter((a) => !CORE_IDS.has(a.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    return [...cores, ...extras];
  }

  getAgent(id: string): AgentSnapshot | undefined {
    if (!id || id.length > 128 || id.includes("\u0000")) return undefined;
    return this.agents.get(id);
  }

  listModels(catalog: ModelOption[]): ModelOption[] {
    const models = new Map(catalog.map((model) => [model.id, model]));
    for (const agent of this.agents.values()) {
      for (const id of new Set([agent.model, ...agent.availableModels])) {
        if (!models.has(id)) {
          models.set(id, {
            id,
            label: id,
            short: id,
            provider: agent.provider || modelProvider(id),
          });
        }
      }
    }
    return [...models.values()];
  }

  applySnapshot(health: HealthReport, agents: AgentSnapshot[], replaceAgents = true): void {
    this.workerConnected = true;
    this.lastHeartbeatAt = Date.now();
    this.health = {
      ...health,
      workerConnected: true,
      lastHeartbeatAt: this.lastHeartbeatAt,
    };
    // A hello is authoritative, including custom fleets; an empty heartbeat
    // only refreshes health and keeps the last acknowledged agent snapshots.
    if (replaceAgents) this.agents.clear();
    for (const agent of agents) this.agents.set(agent.id, agent);
    this.syncHealthAgents();
  }

  applyHeartbeat(health: HealthReport, agents: AgentSnapshot[]): void {
    this.applySnapshot(health, agents, agents.length > 0);
  }

  applyAgent(agent: AgentSnapshot): void {
    this.agents.set(agent.id, agent);
    this.syncHealthAgents();
  }

  markWorkerDisconnected(): void {
    this.workerConnected = false;
    for (const [id, agent] of this.agents) {
      this.agents.set(id, { ...agent, status: "offline", headline: "Worker disconnected", runStartedAt: undefined });
    }
    this.health = {
      ...this.health,
      ok: false,
      workerConnected: false,
      lastHeartbeatAt: this.lastHeartbeatAt,
      issues: Array.from(
        new Set([...this.health.issues, "Worker is offline"])
      ),
    };
    this.syncHealthAgents();
  }

  private syncHealthAgents(): void {
    this.health = {
      ...this.health,
      workerConnected: this.workerConnected,
      lastHeartbeatAt: this.lastHeartbeatAt,
      agents: this.listAgents().map((a) => ({
        id: a.id,
        present: this.workerConnected && a.status !== "offline",
        status: a.status,
      })),
    };
  }
}
