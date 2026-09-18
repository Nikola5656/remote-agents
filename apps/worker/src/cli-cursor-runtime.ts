import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MODEL_CATALOG, modelProvider } from "@remote-agents/shared";
import type { ComposerSidebar } from "./composer-sidebar";
import { log, logError } from "./log";
import type {
  CursorAgentHandle,
  CursorRunHandle,
  CursorRunResult,
  CursorRuntime,
  SendOptions,
} from "./runtime";

const CREATE_TIMEOUT_MS = 12_000;
const LIST_MODELS_TIMEOUT_MS = 12_000;
/** SIGTERM grace before SIGKILL when cancelling a CLI process group. */
export const CANCEL_TERM_MS = 5_000;
/** Max wait after SIGKILL before giving up on the close handler. */
export const CANCEL_KILL_MS = 2_000;
/** Cap stream-json events retained in memory for a single run. */
export const MAX_STREAM_EVENTS = 4_000;
/** Cap the partial stdout line buffer while assembling stream-json lines. */
export const MAX_LINE_BUFFER_CHARS = 256 * 1024;
/** Cap captured stdout/stderr for short-lived create-chat / list-models calls. */
export const MAX_CAPTURE_OUTPUT_CHARS = 512 * 1024;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isComposerChatId(id: string): boolean {
  return UUID_RE.test(id.trim());
}

export function existingDirectory(input: string): string {
  try {
    const resolved = path.resolve(input);
    if (fs.statSync(resolved).isDirectory()) return resolved;
    return path.dirname(resolved);
  } catch {
    return process.cwd();
  }
}

export interface CliRun {
  id: string;
  stream(): AsyncIterable<unknown>;
  wait(): Promise<CursorRunResult>;
  cancel(): Promise<void>;
}

export type SandboxMode = "enabled" | "disabled";

export interface StartRunInput {
  chatId: string;
  text: string;
  model: string;
  cwd: string;
  workspace?: string;
  apiKey?: string;
  force?: boolean;
  sandbox?: SandboxMode;
}

export interface CursorCli {
  createChat(input: { cwd: string; workspace?: string }): Promise<string>;
  listModels(input: { cwd: string; apiKey?: string }): Promise<string[]>;
  startRun(input: StartRunInput): CliRun;
}

export interface CliCursorRuntimeOptions {
  bin?: string;
  chatWorkspace: string;
  sidebar?: ComposerSidebar | null;
  cli?: CursorCli;
  env?: NodeJS.ProcessEnv;
  /** Sandbox mode for every run; disabled by default so agents can write anywhere. */
  sandbox?: SandboxMode;
  /** Pass --force on every run (not just interrupts); on by default. */
  forceRuns?: boolean;
}

// Dashboard IDs remain stable across SDK/CLI modes; the CLI requires its full model IDs.
export function cursorCliModel(model: string): string {
  const ids: Record<string, string> = {
    "claude-fable-5-1": "claude-fable-5-1-thinking-high",
    "grok-4.6": "cursor-grok-4.6-high-fast",
    "claude-opus-4-8": "claude-opus-4-8-thinking-high",
  };
  return ids[model] ?? model;
}

export function parseCliModelList(output: string): string[] {
  return [...new Set(output.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^([a-z0-9][a-z0-9._:-]{2,})(?:\s+-\s+.*)?$/i);
    return match ? [match[1]] : [];
  }))];
}

export function buildRunArgs(input: {
  chatId: string;
  text: string;
  model: string;
  workspace?: string;
  force?: boolean;
  sandbox?: SandboxMode;
}): string[] {
  const args = [
    "agent",
    "--resume",
    input.chatId,
    "--print",
    "--trust",
    "--output-format",
    "stream-json",
    "--model",
    input.model,
  ];
  if (input.workspace) args.push("--workspace", input.workspace);
  if (input.sandbox) args.push("--sandbox", input.sandbox);
  if (input.force) args.push("--force");
  args.push(input.text);
  return args;
}

function parseChatId(stdout: string, stderr: string): string {
  const text = `${stdout}\n${stderr}`;
  const match = text.match(UUID_RE);
  if (!match) {
    throw new Error(`create-chat did not return a chat id: ${text.trim().slice(0, 240)}`);
  }
  return match[0];
}

export function parseStreamEvent(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: trimmed }] },
    };
  }
}

/** Cursor stream-json terminal `result` events can report failure with exit code 0. */
export function terminalResultFromEvent(event: unknown): CursorRunResult | null {
  if (!event || typeof event !== "object") return null;
  const ev = event as Record<string, unknown>;
  if (ev.type === "error") {
    const message =
      typeof ev.message === "string"
        ? ev.message
        : typeof ev.error === "string"
          ? ev.error
          : "cursor agent stream error";
    return { status: "error", error: { message }, result: message };
  }
  if (ev.type !== "result") return null;
  const isError =
    ev.is_error === true ||
    ev.subtype === "error" ||
    ev.status === "error" ||
    ev.status === "ERROR";
  if (isError) {
    const message =
      typeof ev.result === "string"
        ? ev.result
        : typeof ev.message === "string"
          ? ev.message
          : "cursor agent run failed";
    return { status: "error", error: { message }, result: message };
  }
  const text = typeof ev.result === "string" ? ev.result : undefined;
  return { status: "finished", result: text || "ok" };
}

export function appendBounded(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk;
  if (next.length <= maxChars) return next;
  return next.slice(next.length - maxChars);
}

/** Assembles stream-json lines and drains a trailing partial line on close. */
export class StreamLineBuffer {
  private buffer = "";

  feed(chunk: string): string[] {
    this.buffer = appendBounded(this.buffer, chunk, MAX_LINE_BUFFER_CHARS);
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    return lines;
  }

  drain(): string[] {
    const tail = this.buffer.trim();
    this.buffer = "";
    return tail ? [tail] : [];
  }
}

export function waitForChildClose(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("close", () => resolve());
  });
}

export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM"
): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  }
}

async function ensureChildSpawned(child: ChildProcess): Promise<void> {
  if (child.pid) return;
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (err) => reject(err));
    child.once("close", () => resolve());
  }).catch(() => undefined);
}

export async function cancelProcessGroup(
  child: ChildProcess,
  opts: { termMs?: number; killMs?: number } = {}
): Promise<void> {
  const termMs = opts.termMs ?? CANCEL_TERM_MS;
  const killMs = opts.killMs ?? CANCEL_KILL_MS;
  await ensureChildSpawned(child);
  if (!child.pid) {
    await waitForChildClose(child);
    return;
  }

  const exited = waitForChildClose(child);
  killProcessTree(child, "SIGTERM");
  const termOutcome = await Promise.race([
    exited.then(() => "closed"),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), termMs)),
  ]);
  if (termOutcome === "closed") {
    // The leader can exit while a tool keeps running with closed stdio.
    // Check its isolated process group before declaring cancellation complete.
    let descendants = false;
    try { process.kill(-child.pid, 0); descendants = true; } catch { /* gone */ }
    if (!descendants) return;
  }

  killProcessTree(child, "SIGKILL");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, killMs)),
  ]);
}

export class ProcessCursorCli implements CursorCli {
  constructor(
    private readonly bin: string,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  createChat(input: { cwd: string; workspace?: string }): Promise<string> {
    // create-chat ignores --workspace and hashes process.cwd(); extra flags can hang.
    return this.capture({
      args: ["agent", "create-chat"],
      cwd: existingDirectory(input.cwd),
      timeoutMs: CREATE_TIMEOUT_MS,
    }).then((out) => parseChatId(out.stdout, out.stderr));
  }

  async listModels(input: { cwd: string; apiKey?: string }): Promise<string[]> {
    try {
      const out = await this.capture({
        args: ["agent", "--list-models"],
        cwd: existingDirectory(input.cwd),
        timeoutMs: LIST_MODELS_TIMEOUT_MS,
        apiKey: input.apiKey,
      });
      const ids = parseCliModelList(`${out.stdout}\n${out.stderr}`);
      if (ids.length) return [...new Set(ids)];
    } catch (err) {
      logError("cursor agent --list-models failed", err);
    }
    return MODEL_CATALOG.filter((m) => modelProvider(m.id) === "cursor").map((m) => cursorCliModel(m.id));
  }

  startRun(input: StartRunInput): CliRun {
    const args = buildRunArgs(input);
    return new CliProcessRun(this.bin, args, {
      cwd: existingDirectory(input.cwd),
      env: this.childEnv(input.apiKey),
    });
  }

  private childEnv(apiKey?: string): NodeJS.ProcessEnv {
    const env = { ...this.env };
    if (apiKey) env.CURSOR_API_KEY = apiKey;
    return env;
  }

  private capture(input: {
    args: string[];
    cwd: string;
    timeoutMs: number;
    apiKey?: string;
  }): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, input.args, {
        cwd: input.cwd,
        env: this.childEnv(input.apiKey),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        void cancelProcessGroup(child).finally(() => {
          reject(new Error(`timed out: cursor ${input.args.join(" ")}`));
        });
      }, input.timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout = appendBounded(stdout, String(chunk), MAX_CAPTURE_OUTPUT_CHARS);
      });
      child.stderr.on("data", (chunk) => {
        stderr = appendBounded(stderr, String(chunk), MAX_CAPTURE_OUTPUT_CHARS);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code && code !== 0) {
          reject(new Error(`cursor ${input.args.join(" ")} exited ${code}: ${stderr.trim()}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}

export class CliProcessRun implements CliRun {
  readonly id = randomUUID();
  private readonly events: unknown[] = [];
  private readonly waiters: Array<(event: unknown) => void> = [];
  private done = false;
  private result: CursorRunResult = { status: "running" };
  private streamTerminal: CursorRunResult | null = null;
  private readonly finished: Promise<CursorRunResult>;
  private readonly child: ChildProcess;
  private readonly lineBuffer = new StreamLineBuffer();

  constructor(
    bin: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv }
  ) {
    this.child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.finished = new Promise((resolve) => {
      this.child.stdout?.on("data", (chunk) => {
        for (const line of this.lineBuffer.feed(String(chunk))) {
          this.ingestLine(line);
        }
      });
      this.child.stderr?.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (text) {
          this.push({
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text }] },
          });
        }
      });
      this.child.on("error", (err) => {
        this.result = { status: "error", error: { message: err.message } };
        this.finish(resolve);
      });
      this.child.on("close", (code, signal) => {
        for (const line of this.lineBuffer.drain()) {
          this.ingestLine(line);
        }
        if (this.result.status === "running") {
          this.result = this.resolveCloseResult(code, signal);
        }
        this.finish(resolve);
      });
    });
  }

  private ingestLine(line: string): void {
    const event = parseStreamEvent(line);
    if (!event) return;
    const terminal = terminalResultFromEvent(event);
    if (terminal) this.streamTerminal = terminal;
    this.push(event);
  }

  private resolveCloseResult(
    code: number | null,
    signal: NodeJS.Signals | null
  ): CursorRunResult {
    if (this.result.status === "cancelled") return this.result;
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      return { status: "cancelled", result: "cancelled" };
    }
    if (code !== 0) {
      return {
        status: "error",
        error: { message: `cursor agent exited ${code}` },
      };
    }
    if (this.streamTerminal) return this.streamTerminal;
    return { status: "finished", result: "ok" };
  }

  private push(event: unknown): void {
    if (this.events.length >= MAX_STREAM_EVENTS) {
      this.events.shift();
    }
    this.events.push(event);
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
  }

  private finish(resolve: (result: CursorRunResult) => void): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters) waiter(undefined);
    this.waiters.length = 0;
    resolve(this.result);
  }

  async *stream(): AsyncIterable<unknown> {
    while (true) {
      if (this.events.length) {
        yield this.events.shift();
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiters.push(() => resolve());
      });
    }
  }

  wait(): Promise<CursorRunResult> {
    return this.finished;
  }

  async cancel(): Promise<void> {
    if (this.done) return;
    this.result = { status: "cancelled", result: "cancelled" };
    await cancelProcessGroup(this.child);
    await this.finished.catch(() => undefined);
  }
}

export class CliCursorRuntime implements CursorRuntime {
  readonly kind = "cli" as const;
  private readonly cli: CursorCli;
  private readonly chatWorkspace: string;
  private readonly sidebar?: ComposerSidebar | null;
  private readonly sandbox: SandboxMode;
  private readonly forceRuns: boolean;

  constructor(opts: CliCursorRuntimeOptions) {
    this.cli = opts.cli || new ProcessCursorCli(opts.bin || "cursor", opts.env);
    this.chatWorkspace = opts.chatWorkspace;
    this.sidebar = opts.sidebar;
    this.sandbox = opts.sandbox ?? "disabled";
    this.forceRuns = opts.forceRuns ?? true;
  }

  get transcript(): ComposerSidebar | null {
    return this.sidebar ?? null;
  }

  async create(input: {
    slotId: string;
    name?: string;
    model: string;
    cwd: string;
    apiKey?: string;
  }): Promise<CursorAgentHandle> {
    const name = input.name || input.slotId;
    const existing = this.sidebar?.findNamedChat(name);
    // `cursor agent create-chat` hangs without a TTY (LaunchAgent). It only
    // writes a CLI store UUID anyway — allocate one and materialize the
    // IDE sidebar header ourselves.
    const chatId = existing || randomUUID();
    if (!existing) log("allocated Cursor chat id", input.slotId, chatId);
    this.publishSidebar(chatId, name, input.model);
    log("created Cursor chat", input.slotId, chatId, name);
    return this.wrap(chatId, name, input.cwd, input.apiKey);
  }

  async resume(
    agentId: string,
    input: { model: string; cwd: string; apiKey?: string; name?: string }
  ): Promise<CursorAgentHandle> {
    if (!isComposerChatId(agentId)) {
      throw new Error(`not a visible Cursor chat id: ${agentId}`);
    }
    const name = input.name || agentId;
    this.publishSidebar(agentId, name, input.model);
    log("resumed Cursor chat", agentId, name);
    return this.wrap(agentId, name, input.cwd, input.apiKey);
  }

  async listModels(apiKey?: string): Promise<string[]> {
    const ids = await this.cli.listModels({ cwd: this.chatWorkspace, apiKey });
    return ids.map((id) => MODEL_CATALOG.find((m) => modelProvider(m.id) === "cursor" && cursorCliModel(m.id) === id)?.id ?? id);
  }

  private publishSidebar(chatId: string, name: string, model?: string): void {
    if (!this.sidebar) return;
    this.sidebar.ensureChat({ composerId: chatId, name, model });
  }

  private wrap(
    chatId: string,
    _name: string,
    cwd: string,
    apiKey?: string
  ): CursorAgentHandle {
    const runtime = this;
    return {
      agentId: chatId,
      async send(text: string, options: SendOptions) {
        const run = runtime.cli.startRun({
          chatId,
          text,
          model: cursorCliModel(options.model),
          cwd,
          workspace: cwd,
          apiKey,
          force: runtime.forceRuns || options.force ? true : undefined,
          sandbox: runtime.sandbox,
        });
        runtime.sidebar?.touchChat(chatId, text.slice(0, 80));
        return {
          id: run.id,
          supports(op: string) {
            return op === "cancel" || op === "wait" || op === "stream";
          },
          stream: () => run.stream(),
          wait: () => run.wait(),
          cancel: () => run.cancel(),
        };
      },
      async dispose() {},
    };
  }
}
