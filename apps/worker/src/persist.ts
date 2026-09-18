import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { modelProvider, type AgentKind, type ModelProvider } from "@remote-agents/shared";

export interface PersistedSlot {
  cursorAgentId?: string;
  model: string;
  name: string;
  kind: AgentKind;
  provider?: ModelProvider;
  /** Preserve invalid provider metadata as a visible, non-runnable slot. */
  restoreError?: string;
  cwd?: string;
}

export interface PersistedState {
  /** Missing in legacy state. */
  version?: 1;
  agents: Record<string, PersistedSlot>;
}

export class AgentStore {
  constructor(private readonly filePath: string) {}

  load(): PersistedState {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A dangling symlink is existing broken state, not a fresh installation.
        try { fs.lstatSync(this.filePath); }
        catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") return { agents: {} };
          throw this.failure(`cannot inspect state (${(statError as NodeJS.ErrnoException).code || "I/O error"})`);
        }
      }
      throw this.failure(`cannot read state (${(error as NodeJS.ErrnoException).code || "I/O error"})`);
    }
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch { throw this.failure("invalid JSON; original state was preserved"); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw this.failure("expected a state object");
    const state = raw as Record<string, unknown>;
    if (state.version !== undefined && state.version !== 1) throw this.failure(`Unsupported agent state version: ${state.version}`);
    if (!state.agents || typeof state.agents !== "object" || Array.isArray(state.agents)) throw this.failure("agents must be an object");
    const agents: Record<string, PersistedSlot> = {};
    for (const [id, value] of Object.entries(state.agents)) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ["constructor", "prototype"].includes(id)) throw this.failure(`invalid agent id ${id}`);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw this.failure(`invalid slot ${id}`);
      const slot = value as PersistedSlot;
      if (typeof slot.model !== "string" || !slot.model.trim() || typeof slot.name !== "string" || !slot.name.trim()) throw this.failure(`invalid name/model for ${id}`);
      if (!["core", "extra", "claude"].includes(slot.kind)) throw this.failure(`invalid kind for ${id}`);
      for (const key of ["cursorAgentId", "cwd", "restoreError"] as const) {
        if (slot[key] !== undefined && typeof slot[key] !== "string") throw this.failure(`invalid ${key} for ${id}`);
      }
      if (slot.provider !== undefined && !["cursor", "codex", "claude"].includes(slot.provider)) throw this.failure(`invalid provider for ${id}`);
      agents[id] = {
        name: slot.name, model: slot.model, kind: slot.kind,
        provider: slot.provider ?? modelProvider(slot.model),
        ...(typeof slot.restoreError === "string" ? { restoreError: slot.restoreError } : {}),
        ...(typeof slot.cursorAgentId === "string" ? { cursorAgentId: slot.cursorAgentId } : {}),
        ...(typeof slot.cwd === "string" ? { cwd: slot.cwd } : {}),
      };
    }
    return { version: 1, agents };
  }

  private failure(reason: string): Error {
    return new Error(`Cannot load agent state ${this.filePath}: ${reason}`);
  }

  save(state: PersistedState): void {
    // Also protect callers that save without first loading, and detect corruption
    // introduced since the last read. This is not a multi-writer lock.
    this.load();
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const agents = Object.fromEntries(Object.entries(state.agents).map(([id, slot]) => [id, {
      ...slot, provider: slot.provider ?? modelProvider(slot.model),
    }]));
    const bytes = JSON.stringify({ version: 1, agents }, null, 2);
    const temporary = path.join(dir, `.${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    let owned = false;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      owned = true;
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.filePath);
    } finally {
      try { if (descriptor !== undefined) fs.closeSync(descriptor); }
      finally { if (owned && fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
  }
}
