import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log, logError } from "./log";
import type { TranscriptMirror } from "./runtime";

/** Max characters mirrored into a single IDE bubble. */
export const BUBBLE_TEXT_CAP = 32_000;

export interface SidebarWorkspace {
  id: string;
  configPath?: string;
  folderPath?: string;
}

export interface EnsureChatInput {
  composerId: string;
  name: string;
  model?: string;
  subtitle?: string;
}

export interface ConversationStep {
  bubbleId: string;
  /** Assistant answer text (may grow across polls). */
  text: string;
  /** Thinking block text, if this bubble is a thinking step. */
  thinking?: string;
  /** Tool call, if this bubble is a tool step. */
  tool?: { name: string; target?: string; status?: string };
}

export interface ConversationState {
  model?: string;
  /** Total entries in fullConversationHeadersOnly. */
  headerCount: number;
  /** Number of bubbles the IDE is currently generating. */
  generatingCount: number;
  lastUpdatedAt: number;
  status?: string;
  /** Assistant steps at/after the requested header offset, in order. */
  assistant: ConversationStep[];
}

function toolTarget(rawArgs: unknown): string | undefined {
  if (typeof rawArgs !== "string") return undefined;
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown>;
    const p = args.path ?? args.targetFile ?? args.relativePath;
    if (typeof p === "string") return path.basename(p);
    if (typeof args.command === "string") return args.command.slice(0, 50);
    if (typeof args.query === "string") return args.query.slice(0, 50);
    if (typeof args.pattern === "string") return args.pattern.slice(0, 50);
    if (typeof args.description === "string") return args.description.slice(0, 50);
  } catch {
    // ignore
  }
  return undefined;
}

/** Friendly tool name: read_file_v2 -> read file. */
function friendlyTool(name: unknown): string {
  if (typeof name !== "string" || !name) return "tool";
  return name.replace(/_v\d+$/, "").replace(/_/g, " ");
}

export function defaultComposerDbPath(): string {
  return path.join(
    os.homedir(),
    "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
  );
}

export function defaultWorkspaceStorageRoot(): string {
  return path.join(os.homedir(), "Library/Application Support/Cursor/User/workspaceStorage");
}

export function defaultGlassWorkspaceFile(): string {
  return path.join(
    os.homedir(),
    "Library/Application Support/Cursor/glassMultiRootWorkspaces/remote_agents-agent-1-and-2-more-workspace.code-workspace"
  );
}

export function resolveChatWorkspace(explicit?: string, controlRoot?: string): string {
  const requested = (explicit || "").trim();
  if (requested && fs.existsSync(requested)) return path.resolve(requested);
  const glass = defaultGlassWorkspaceFile();
  if (fs.existsSync(glass)) return glass;
  if (controlRoot && fs.existsSync(controlRoot)) return path.resolve(controlRoot);
  return path.resolve(controlRoot || process.cwd());
}

export function resolveSidebarWorkspace(
  chatWorkspace: string,
  storageRoot = defaultWorkspaceStorageRoot()
): SidebarWorkspace | null {
  const target = path.resolve(chatWorkspace);
  if (!fs.existsSync(storageRoot)) return null;
  for (const id of fs.readdirSync(storageRoot)) {
    const file = path.join(storageRoot, id, "workspace.json");
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
        folder?: string;
        workspace?: string;
      };
      const folder = fileUriToPath(data.folder);
      const workspaceFile = fileUriToPath(data.workspace);
      if (folder && path.resolve(folder) === target) {
        return { id, folderPath: folder };
      }
      if (workspaceFile && path.resolve(workspaceFile) === target) {
        return { id, configPath: workspaceFile };
      }
    } catch {
      // ignore unreadable workspace records
    }
  }
  return null;
}

function fileUriToPath(uri?: string): string | undefined {
  if (!uri) return undefined;
  try {
    const decoded = decodeURIComponent(uri.replace(/^file:\/\//, ""));
    return decoded.startsWith("/") ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function openDb(dbPath: string): {
  exec: (sql: string, ...params: unknown[]) => unknown;
  all: <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => T[];
  close: () => void;
} | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    // node:sqlite is available on Node 22+ (LaunchAgent runtime).
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (
        path: string,
        opts?: { readOnly?: boolean }
      ) => {
        exec(sql: string): void;
        prepare(sql: string): {
          run: (...params: unknown[]) => unknown;
          all: (...params: unknown[]) => unknown[];
        };
        close(): void;
      };
    };
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    return {
      exec(sql: string, ...params: unknown[]) {
        if (!params.length) return db.exec(sql);
        return db.prepare(sql).run(...params);
      },
      all<T = Record<string, unknown>>(sql: string, ...params: unknown[]) {
        return db.prepare(sql).all(...params) as T[];
      },
      close() {
        db.close();
      },
    };
  } catch (err) {
    logError("composer db open failed", err);
    return null;
  }
}

function vscodeUri(fsPath: string): Record<string, unknown> {
  const external = `file://${fsPath
    .split("/")
    .map((part) => (part ? encodeURIComponent(part) : ""))
    .join("/")}`;
  return {
    $mid: 1,
    fsPath,
    external,
    path: fsPath,
    scheme: "file",
  };
}

function workspaceIdentifier(workspace: SidebarWorkspace): Record<string, unknown> {
  if (workspace.configPath) {
    return { id: workspace.id, configPath: vscodeUri(workspace.configPath) };
  }
  if (workspace.folderPath) {
    return { id: workspace.id, uri: vscodeUri(workspace.folderPath) };
  }
  return { id: workspace.id };
}

function headerValue(input: {
  composerId: string;
  name: string;
  now: number;
  workspace: SidebarWorkspace;
  model?: string;
  subtitle?: string;
  createdAt?: number;
}): string {
  return JSON.stringify({
    type: "head",
    composerId: input.composerId,
    name: input.name,
    lastUpdatedAt: input.now,
    createdAt: input.createdAt ?? input.now,
    unifiedMode: "agent",
    forceMode: "edit",
    hasUnreadMessages: false,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    hasBlockingPendingActions: false,
    isArchived: false,
    isDraft: false,
    isWorktree: false,
    worktreeStartedReadOnly: false,
    isSpec: false,
    isProject: false,
    isBestOfNSubcomposer: false,
    numSubComposers: 0,
    referencedPlans: [],
    trackedGitRepos: [],
    workspaceIdentifier: workspaceIdentifier(input.workspace),
    hasBeenInSidebar: true,
    subtitle: input.subtitle || "Always-on remote agent",
    agentLocation: {
      type: "local",
      environment: workspaceIdentifier(input.workspace),
      status: "active",
    },
  });
}

function composerDataValue(input: {
  composerId: string;
  now: number;
  workspace: SidebarWorkspace;
  model?: string;
}): string {
  return JSON.stringify({
    _v: 18,
    composerId: input.composerId,
    richText: "",
    hasLoaded: true,
    text: "",
    fullConversationHeadersOnly: [],
    conversationMap: {},
    status: "none",
    context: {
      composers: [],
      quotes: [],
      selectedCommits: [],
      selectedPullRequests: [],
      selectedImages: [],
      folderSelections: [],
      fileSelections: [],
      selections: [],
      terminalSelections: [],
      selectedDocs: [],
      externalLinks: [],
      cursorRules: [],
      cursorCommands: [],
      uiElementSelections: [],
      consoleLogs: [],
      mentions: {},
    },
    gitGraphFileSuggestions: [],
    generatingBubbleIds: [],
    isReadingLongFile: false,
    codeBlockData: {},
    originalFileStates: {},
    newlyCreatedFiles: [],
    newlyCreatedFolders: [],
    createdAt: input.now,
    lastUpdatedAt: input.now,
    hasChangedContext: false,
    activeTabsShouldBeReactive: true,
    capabilities: [],
    isFileListExpanded: false,
    browserChipManuallyDisabled: false,
    browserChipManuallyEnabled: false,
    unifiedMode: "agent",
    forceMode: "edit",
    usageData: {},
    allAttachedFileCodeChunksUris: [],
    modelConfig: { modelName: input.model || "default", maxMode: false },
    subComposerIds: [],
    capabilityContexts: [],
    todos: [],
    isQueueExpanded: true,
    hasUnreadMessages: false,
    gitHubPromptDismissed: false,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    addedFiles: 0,
    removedFiles: 0,
    isArchived: false,
    isDraft: false,
    isCreatingWorktree: false,
    isApplyingWorktree: false,
    isUndoingWorktree: false,
    pendingCreateWorktree: false,
    isBestOfNSubcomposer: false,
    isBestOfNParent: false,
    isSpec: false,
    isSpecSubagentDone: false,
    stopHookLoopCount: 0,
    // Cursor rejects chats with isNAL=false as "created in an older version …
    // no longer supported" and will not run them. Current chats are isNAL=true.
    isNAL: true,
    planModeSuggestionUsed: false,
    isAgentic: true,
    workspaceIdentifier: workspaceIdentifier(input.workspace),
  });
}

type Db = NonNullable<ReturnType<typeof openDb>>;

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return String(value ?? "");
}

function clipBubbleText(text: string): string {
  if (text.length <= BUBBLE_TEXT_CAP) return text;
  return "…" + text.slice(text.length - BUBBLE_TEXT_CAP);
}

/**
 * Minimal bubble record matching what Cursor persists for real chats
 * (observed schema `_v: 3`; type 1 = user, type 2 = assistant). All the
 * empty collection fields are required for the renderer not to choke.
 */
function bubbleValue(input: {
  bubbleId: string;
  type: 1 | 2;
  text: string;
  createdAtIso: string;
}): string {
  const text = clipBubbleText(input.text);
  const bubble: Record<string, unknown> = {
    _v: 3,
    type: input.type,
    bubbleId: input.bubbleId,
    text,
    approximateLintErrors: [],
    lints: [],
    codebaseContextChunks: [],
    commits: [],
    pullRequests: [],
    attachedCodeChunks: [],
    assistantSuggestedDiffs: [],
    gitDiffs: [],
    interpreterResults: [],
    images: [],
    attachedFolders: [],
    attachedFoldersNew: [],
    userResponsesToSuggestedCodeBlocks: [],
    suggestedCodeBlocks: [],
    diffsForCompressingFiles: [],
    relevantFiles: [],
    toolResults: [],
    notepads: [],
    capabilities: [],
    multiFileLinterErrors: [],
    diffHistories: [],
    recentLocationsHistory: [],
    recentlyViewedFiles: [],
    isAgentic: false,
    fileDiffTrajectories: [],
    existedSubsequentTerminalCommand: false,
    existedPreviousTerminalCommand: false,
    docsReferences: [],
    webReferences: [],
    aiWebSearchResults: [],
    requestId: "",
    attachedFoldersListDirResults: [],
    humanChanges: [],
    attachedHumanChanges: false,
    summarizedComposers: [],
    cursorRules: [],
    cursorCommands: [],
    cursorCommandsExplicitlySet: false,
    pastChats: [],
    pastChatsExplicitlySet: false,
    contextPieces: [],
    editTrailContexts: [],
    allThinkingBlocks: [],
    diffsSinceLastApply: [],
    deletedFiles: [],
    supportedTools: [],
    tokenCount: { inputTokens: 0, outputTokens: 0 },
    attachedFileCodeChunksMetadataOnly: [],
    consoleLogs: [],
    uiElementPicked: [],
    isRefunded: false,
    knowledgeItems: [],
    documentationSelections: [],
    externalLinks: [],
    projectLayouts: [],
    unifiedMode: 2,
    capabilityContexts: [],
    todos: [],
    createdAt: input.createdAtIso,
    mcpDescriptors: [],
    workspaceUris: [],
  };
  if (input.type === 1) {
    bubble.richText = text;
  } else {
    bubble.codeBlocks = [];
  }
  return JSON.stringify(bubble);
}

function conversationHeader(input: {
  bubbleId: string;
  type: 1 | 2;
  textPreview?: string;
  createdAtIso: string;
}): Record<string, unknown> {
  const grouping: Record<string, unknown> =
    input.type === 1
      ? {
          isRenderable: true,
          hasText: true,
          textPreview: (input.textPreview || "").slice(0, 120),
          toolDisplayComputed: true,
        }
      : {
          isRenderable: true,
          hasText: true,
          isKeptFinalAiVisibleOutsideWorkedForGroup: true,
          toolDisplayComputed: true,
        };
  return {
    bubbleId: input.bubbleId,
    type: input.type,
    grouping,
    createdAt: input.createdAtIso,
  };
}

function upsertKV(db: Db, key: string, value: string): void {
  const res = db.exec("UPDATE cursorDiskKV SET value = ? WHERE key = ?", value, key) as
    | { changes?: number | bigint }
    | undefined;
  if (!res || !Number(res.changes || 0)) {
    db.exec("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)", key, value);
  }
}

export class ComposerSidebar implements TranscriptMirror {
  constructor(
    private readonly dbPath: string,
    private readonly workspace: SidebarWorkspace
  ) {}

  findNamedChat(name: string): string | undefined {
    const db = openDb(this.dbPath);
    if (!db) return undefined;
    try {
      const rows = db.all<{ composerId: string; value: string }>(
        "SELECT composerId, value FROM composerHeaders WHERE workspaceId = ? AND COALESCE(isSubagent, 0) = 0 AND COALESCE(isArchived, 0) = 0",
        this.workspace.id
      );
      for (const row of rows) {
        try {
          const parsed = JSON.parse(String(row.value || "{}")) as { name?: string };
          if (parsed.name === name) return row.composerId;
        } catch {
          // ignore
        }
      }
      return undefined;
    } finally {
      db.close();
    }
  }

  hasChat(composerId: string): boolean {
    const db = openDb(this.dbPath);
    if (!db) return false;
    try {
      const rows = db.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM composerHeaders WHERE composerId = ?",
        composerId
      );
      return Number(rows[0]?.n || 0) > 0;
    } finally {
      db.close();
    }
  }

  ensureChat(input: EnsureChatInput): boolean {
    const db = openDb(this.dbPath);
    if (!db) return false;
    const now = Date.now();
    try {
      const existing = db.all<{ createdAt: number; value: string }>(
        "SELECT createdAt, value FROM composerHeaders WHERE composerId = ?",
        input.composerId
      )[0];
      let createdAt = now;
      if (existing?.createdAt) createdAt = Number(existing.createdAt);
      const value = headerValue({
        composerId: input.composerId,
        name: input.name,
        now,
        workspace: this.workspace,
        model: input.model,
        subtitle: input.subtitle,
        createdAt,
      });
      if (existing) {
        db.exec(
          "UPDATE composerHeaders SET workspaceId = ?, lastUpdatedAt = ?, recency = ?, isArchived = 0, isSubagent = 0, value = ? WHERE composerId = ?",
          this.workspace.id,
          now,
          now,
          value,
          input.composerId
        );
      } else {
        db.exec(
          "INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value) VALUES (?, ?, ?, ?, 0, 0, ?, ?)",
          input.composerId,
          this.workspace.id,
          now,
          now,
          now,
          value
        );
      }
      const dataKey = `composerData:${input.composerId}`;
      const dataRows = db.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM cursorDiskKV WHERE key = ?",
        dataKey
      );
      if (Number(dataRows[0]?.n || 0) === 0) {
        db.exec(
          "INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)",
          dataKey,
          composerDataValue({
            composerId: input.composerId,
            now,
            workspace: this.workspace,
            model: input.model,
          })
        );
      }
      log("sidebar chat ready", input.name, input.composerId, this.workspace.id);
      return true;
    } catch (err) {
      logError("sidebar chat upsert failed", input.name, err);
      return false;
    } finally {
      db.close();
    }
  }

  /**
   * Reads the live conversation state the IDE persists for a chat. Used by
   * the bridge runtime to stream output of runs the IDE executes itself.
   */
  readConversation(composerId: string, sinceHeader = 0): ConversationState | null {
    const db = openDb(this.dbPath);
    if (!db) return null;
    try {
      const row = db.all<{ value: unknown }>(
        "SELECT value FROM cursorDiskKV WHERE key = ?",
        `composerData:${composerId}`
      )[0];
      if (!row) return null;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(textValue(row.value)) as Record<string, unknown>;
      } catch {
        return null;
      }
      const headers = Array.isArray(data.fullConversationHeadersOnly)
        ? (data.fullConversationHeadersOnly as Array<{ bubbleId?: string; type?: number }>)
        : [];
      const generating = Array.isArray(data.generatingBubbleIds)
        ? (data.generatingBubbleIds as unknown[]).length
        : 0;
      const assistant: ConversationStep[] = [];
      for (const header of headers.slice(sinceHeader)) {
        if (header?.type !== 2 || !header.bubbleId) continue;
        const bubbleRow = db.all<{ value: unknown }>(
          "SELECT value FROM cursorDiskKV WHERE key = ?",
          `bubbleId:${composerId}:${header.bubbleId}`
        )[0];
        const step: ConversationStep = { bubbleId: header.bubbleId, text: "" };
        if (bubbleRow) {
          try {
            const bubble = JSON.parse(textValue(bubbleRow.value)) as {
              text?: string;
              thinking?: { text?: string } | string;
              toolFormerData?: { name?: string; rawArgs?: unknown; status?: string };
            };
            step.text = bubble.text || "";
            if (bubble.thinking) {
              step.thinking =
                typeof bubble.thinking === "string"
                  ? bubble.thinking
                  : bubble.thinking.text || "";
            }
            if (bubble.toolFormerData) {
              step.tool = {
                name: friendlyTool(bubble.toolFormerData.name),
                target: toolTarget(bubble.toolFormerData.rawArgs),
                status: bubble.toolFormerData.status,
              };
            }
          } catch {
            // ignore malformed bubble
          }
        }
        assistant.push(step);
      }
      return {
        model: (data.modelConfig as {modelName?: string} | undefined)?.modelName,
        headerCount: headers.length,
        generatingCount: generating,
        lastUpdatedAt: Number(data.lastUpdatedAt || 0),
        status: typeof data.status === "string" ? data.status : undefined,
        assistant,
      };
    } catch (err) {
      logError("read conversation failed", composerId, err);
      return null;
    } finally {
      db.close();
    }
  }

  touchChat(composerId: string, subtitle?: string): void {
    const db = openDb(this.dbPath);
    if (!db) return;
    const now = Date.now();
    try {
      const row = db.all<{ value: string }>(
        "SELECT value FROM composerHeaders WHERE composerId = ?",
        composerId
      )[0];
      if (!row?.value) return;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(String(row.value));
      } catch {
        return;
      }
      parsed.lastUpdatedAt = now;
      parsed.hasBeenInSidebar = true;
      if (subtitle) parsed.subtitle = subtitle;
      db.exec(
        "UPDATE composerHeaders SET lastUpdatedAt = ?, recency = ?, value = ? WHERE composerId = ?",
        now,
        now,
        JSON.stringify(parsed),
        composerId
      );
    } catch (err) {
      logError("sidebar chat touch failed", composerId, err);
    } finally {
      db.close();
    }
  }

  /**
   * Mirrors the start of a run: writes the user bubble plus an empty
   * assistant bubble and registers both in fullConversationHeadersOnly.
   * Returns the assistant bubbleId to stream into, or null on failure.
   */
  startExchange(composerId: string, userText: string): string | null {
    const db = openDb(this.dbPath);
    if (!db) return null;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const userBubbleId = randomUUID();
    const assistantBubbleId = randomUUID();
    try {
      upsertKV(
        db,
        `bubbleId:${composerId}:${userBubbleId}`,
        bubbleValue({ bubbleId: userBubbleId, type: 1, text: userText, createdAtIso: nowIso })
      );
      upsertKV(
        db,
        `bubbleId:${composerId}:${assistantBubbleId}`,
        bubbleValue({ bubbleId: assistantBubbleId, type: 2, text: "", createdAtIso: nowIso })
      );
      this.appendConversationHeaders(
        db,
        composerId,
        [
          conversationHeader({
            bubbleId: userBubbleId,
            type: 1,
            textPreview: userText,
            createdAtIso: nowIso,
          }),
          conversationHeader({ bubbleId: assistantBubbleId, type: 2, createdAtIso: nowIso }),
        ],
        now
      );
      this.touchHeaderRow(db, composerId, now, userText.slice(0, 80));
      return assistantBubbleId;
    } catch (err) {
      logError("sidebar exchange start failed", composerId, err);
      return null;
    } finally {
      db.close();
    }
  }

  /** Replaces the assistant bubble text (throttled by the caller). */
  updateExchange(composerId: string, assistantBubbleId: string, text: string): void {
    const db = openDb(this.dbPath);
    if (!db) return;
    try {
      this.writeAssistantBubble(db, composerId, assistantBubbleId, text);
    } catch (err) {
      logError("sidebar exchange update failed", composerId, err);
    } finally {
      db.close();
    }
  }

  /** Final assistant text plus header timestamps/subtitle refresh. */
  finishExchange(
    composerId: string,
    assistantBubbleId: string,
    text: string,
    subtitle?: string
  ): void {
    const db = openDb(this.dbPath);
    if (!db) return;
    const now = Date.now();
    try {
      this.writeAssistantBubble(db, composerId, assistantBubbleId, text);
      this.appendConversationHeaders(db, composerId, [], now);
      this.touchHeaderRow(db, composerId, now, subtitle, true);
    } catch (err) {
      logError("sidebar exchange finish failed", composerId, err);
    } finally {
      db.close();
    }
  }

  private writeAssistantBubble(
    db: Db,
    composerId: string,
    bubbleId: string,
    text: string
  ): void {
    const key = `bubbleId:${composerId}:${bubbleId}`;
    const row = db.all<{ value: unknown }>(
      "SELECT value FROM cursorDiskKV WHERE key = ?",
      key
    )[0];
    let value: string | undefined;
    if (row) {
      try {
        const bubble = JSON.parse(textValue(row.value)) as Record<string, unknown>;
        bubble.text = clipBubbleText(text);
        value = JSON.stringify(bubble);
      } catch {
        value = undefined;
      }
    }
    if (!value) {
      value = bubbleValue({
        bubbleId,
        type: 2,
        text,
        createdAtIso: new Date().toISOString(),
      });
    }
    upsertKV(db, key, value);
  }

  private appendConversationHeaders(
    db: Db,
    composerId: string,
    entries: Array<Record<string, unknown>>,
    now: number
  ): void {
    const key = `composerData:${composerId}`;
    const row = db.all<{ value: unknown }>(
      "SELECT value FROM cursorDiskKV WHERE key = ?",
      key
    )[0];
    if (!row) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(textValue(row.value)) as Record<string, unknown>;
    } catch {
      return;
    }
    const headers = Array.isArray(data.fullConversationHeadersOnly)
      ? (data.fullConversationHeadersOnly as Array<{ bubbleId?: string }>)
      : [];
    const known = new Set(headers.map((h) => h?.bubbleId));
    for (const entry of entries) {
      if (!known.has(entry.bubbleId as string)) headers.push(entry as { bubbleId?: string });
    }
    data.fullConversationHeadersOnly = headers;
    data.lastUpdatedAt = now;
    db.exec("UPDATE cursorDiskKV SET value = ? WHERE key = ?", JSON.stringify(data), key);
  }

  private touchHeaderRow(
    db: Db,
    composerId: string,
    now: number,
    subtitle?: string,
    unread?: boolean
  ): void {
    const row = db.all<{ value: unknown }>(
      "SELECT value FROM composerHeaders WHERE composerId = ?",
      composerId
    )[0];
    if (!row) return;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(textValue(row.value)) as Record<string, unknown>;
    } catch {
      return;
    }
    parsed.lastUpdatedAt = now;
    parsed.hasBeenInSidebar = true;
    // Nudges the IDE sidebar to show an unread indicator for new mirrored
    // messages (an already-open chat view still needs a tab switch/reload).
    if (unread) parsed.hasUnreadMessages = true;
    if (subtitle) parsed.subtitle = subtitle;
    db.exec(
      "UPDATE composerHeaders SET lastUpdatedAt = ?, recency = ?, value = ? WHERE composerId = ?",
      now,
      now,
      JSON.stringify(parsed),
      composerId
    );
  }
}

/**
 * Enforces that the given chats are "current" (isNAL=true) on disk. A running
 * Cursor flushes its in-memory copy of loaded chats on quit, which can revert
 * a chat to the legacy state that Cursor refuses to run ("Chat Too Old"). The
 * worker calls this on a short interval so the value is correct on disk in the
 * window between a Cursor quit and its next launch.
 */
export function enforceChatsCurrent(dbPath: string, composerIds: string[]): void {
  if (!composerIds.length) return;
  const db = openDb(dbPath);
  if (!db) return;
  try {
    for (const cid of composerIds) {
      const row = db.all<{ value: unknown }>(
        "SELECT value FROM cursorDiskKV WHERE key = ?",
        `composerData:${cid}`
      )[0];
      if (!row) continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(textValue(row.value)) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (data.isNAL === true) continue;
      data.isNAL = true;
      data.isAgentic = true;
      db.exec(
        "UPDATE cursorDiskKV SET value = ? WHERE key = ?",
        JSON.stringify(data),
        `composerData:${cid}`
      );
      log("enforced current chat", cid);
    }
  } catch (err) {
    logError("enforce chats current failed", err);
  } finally {
    db.close();
  }
}

export function createComposerSidebar(input: {
  chatWorkspace: string;
  dbPath?: string;
  storageRoot?: string;
}): ComposerSidebar | null {
  const workspace = resolveSidebarWorkspace(
    input.chatWorkspace,
    input.storageRoot || defaultWorkspaceStorageRoot()
  );
  if (!workspace) {
    log("sidebar workspace mapping not found", input.chatWorkspace);
    return null;
  }
  return new ComposerSidebar(input.dbPath || defaultComposerDbPath(), workspace);
}
