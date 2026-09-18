import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { ClaudeJob, ClaudeLauncher, CursorRunResult } from "./runtime";

export interface ClaudeResolution {
  available: boolean;
  path: string;
  args: string[];
  detail: string;
}

/** Injectable filesystem/platform probes keep Windows resolution testable on Unix. */
export interface ClaudeResolutionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  usable?: (file: string, executable: boolean) => boolean;
}

export function resolveClaudeBin(
  bin = process.env.CLAUDE_BIN || "claude",
  options: ClaudeResolutionOptions = {}
): ClaudeResolution {
  const windows = (options.platform ?? process.platform) === "win32";
  const paths = windows ? path.win32 : path.posix;
  const env = options.env ?? process.env;
  const usable = options.usable ?? ((file, executable) => {
    try {
      if (!statSync(file).isFile()) return false;
      accessSync(file, executable && !windows ? constants.X_OK : constants.R_OK);
      return true;
    } catch { return false; }
  });
  const explicit = paths.isAbsolute(bin) || /[\\/]/.test(bin);
  const home = (windows ? env.USERPROFILE : env.HOME) || os.homedir();
  const directories = [
    ...(env.PATH || env.Path || "").split(windows ? ";" : ":").filter(Boolean),
    paths.join(home, ".local", "bin"),
    ...(windows && env.APPDATA ? [paths.join(env.APPDATA, "npm")] : []),
  ];
  const bases = explicit ? [paths.resolve(bin)] : directories.map((dir) => paths.join(dir, bin));
  for (const base of bases) {
    const candidates = windows && !paths.extname(base)
      ? [base + ".exe", base + ".com", base + ".cmd", base]
      : [base];
    for (const candidate of candidates) {
      // npm's .cmd/.bat wrappers require cmd.exe. Resolve the adjacent official
      // JS entrypoint instead: prompts and arguments must never pass a shell.
      if (windows && /\.(cmd|bat)$/i.test(candidate)) {
        const script = paths.join(paths.dirname(candidate), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
        if (usable(candidate, false) && usable(script, false)) {
          return { available: true, path: process.execPath, args: [script], detail: "Claude Code CLI found (Node entrypoint)" };
        }
      } else if ((!windows || /\.(exe|com)$/i.test(candidate)) && usable(candidate, true)) {
        return { available: true, path: candidate, args: [], detail: "Claude Code CLI found" };
      }
    }
  }
  return { available: false, path: bin, args: [], detail: "Claude Code CLI unavailable; install it or set CLAUDE_BIN to an executable" };
}

export type ClaudeEvent = Record<string, any>;
export type ClaudeSpawn = (bin: string, args: string[], options: SpawnOptions) => ChildProcess;
export interface ClaudeProcessOptions {
  spawn?: ClaudeSpawn;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  platform?: NodeJS.Platform;
  windowsTreeKill?: (pid: number) => boolean;
}
export interface ClaudeProcessInput {
  bin: string;
  cwd: string;
  text: string;
  model?: string;
  sessionId?: string;
  resume?: boolean;
}

export function claudeModelId(model: string): string {
  const id = model.startsWith("claude-code:") ? model.slice("claude-code:".length) : model;
  if (!/^claude-[a-z0-9][a-z0-9.-]*$/i.test(id)) throw new Error("Invalid Claude Code model ID");
  return id;
}

export function claudeArgs(input: ClaudeProcessInput): string[] {
  const args = ["--print", "--dangerously-skip-permissions", "--verbose", "--output-format", "stream-json", "--include-partial-messages"];
  if (input.model) args.push("--model", claudeModelId(input.model));
  if (input.sessionId) args.push(input.resume ? "--resume" : "--session-id", input.sessionId);
  return args;
}

/** Only allowlisted codes/messages or a numeric HTTP status cross the worker boundary. */
function safeClaudeErrorDetail(ev: ClaudeEvent): string {
  const error = ev.error;
  const categories: Record<string, string> = {
    ECONNRESET: "connection reset", ECONNREFUSED: "connection refused",
    ETIMEDOUT: "network timeout", ENOTFOUND: "DNS lookup failed",
    authentication_error: "authentication failed; check Claude Code sign-in",
    permission_error: "provider permission denied; check model access",
    rate_limit_error: "provider rate limit", overloaded_error: "provider overloaded",
    api_error: "provider API error", invalid_request_error: "provider rejected request",
    billing_error: "provider billing error; check account billing",
  };
  for (const code of [error?.connection?.code, error?.code, error?.type, error?.error?.code, error?.error?.type, error]) {
    if (typeof code === "string" && Object.prototype.hasOwnProperty.call(categories, code)) return ` (${categories[code]}; ${code})`;
  }
  // Exact matches only: truncating an arbitrary provider message can still leak secrets.
  const messages = new Set(["Connection error.", "Request timed out.", "Rate limit exceeded", "Overloaded"]);
  for (const message of [error?.message, error?.error?.message, error]) {
    if (typeof message === "string" && messages.has(message)) return ` (${message})`;
  }
  const status = error?.status ?? ev.error_status;
  if (Number.isInteger(status) && status >= 400 && status <= 599) return ` (HTTP ${status})`;
  return "";
}

function scheduledClaudeRetry(ev: ClaudeEvent): { attempt: number; max: number; delay: number } | undefined {
  if (ev.type !== "system") return;
  // The CLI's internal transcript and stream-json wire event have different shapes.
  const retry = ev.subtype === "api_error" && ev.source === "request_retry"
    ? { attempt: ev.retryAttempt, max: ev.maxRetries, delay: ev.retryInMs }
    : ev.subtype === "api_retry"
      ? { attempt: ev.attempt, max: ev.max_retries, delay: ev.retry_delay_ms }
      : undefined;
  if (retry && Number.isSafeInteger(retry.attempt) && retry.attempt >= 1
    && Number.isSafeInteger(retry.max) && retry.attempt <= retry.max
    && Number.isFinite(retry.delay) && retry.delay >= 0) return retry;
}

/** Windows has no POSIX process groups. Kill the tree before killing its root,
 * otherwise taskkill can no longer discover descendants. Never invoke a shell. */
export function terminateWindowsClaudeTree(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
  run: (file: string, args: string[], options: SpawnSyncOptions) => { status: number | null; error?: Error } = spawnSync
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const root = env.SystemRoot || env.SYSTEMROOT;
  if (!root || !path.win32.isAbsolute(root)) return false;
  try {
    const result = run(path.win32.join(root, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      shell: false, windowsHide: true, timeout: 5000, stdio: "ignore", env,
    });
    return result.status === 0 && !result.error;
  } catch { return false; }
}

/** Starts draining BOTH pipes immediately, even if no consumer calls stream(). */
export class ClaudeProcess {
  private child?: ChildProcess;
  private events: ClaudeEvent[] = [];
  private wake?: () => void;
  private done = false;
  private cancelled = false;
  private failure?: string;
  private terminal?: ClaudeEvent;
  private awaitingTurnResult = false;
  private text = "";
  private killTimer?: NodeJS.Timeout;
  private stopping = false;
  private treeClean = false;
  private terminationFailed = false;
  private pendingExit?: { code: number | null; signal: NodeJS.Signals | null };
  private readonly windows = (this.options.platform ?? process.platform) === "win32";
  private resolve!: (result: CursorRunResult) => void;
  private readonly finished = new Promise<CursorRunResult>((resolve) => { this.resolve = resolve; });
  private tools = new Map<string, { name: string; writePath?: string }>();
  readonly completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private close!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  sessionObserved = false;
  missingSessionBeforeSubmission = false;
  private nonTerminalObserved = false;
  private protocolFailed = false;
  private lastRetryDetail = "";

  constructor(private readonly input: ClaudeProcessInput, private readonly options: ClaudeProcessOptions = {}) {
    this.completion = new Promise((resolve) => { this.close = resolve; });
    try {
      const resolved = resolveClaudeBin(input.bin, { env: options.env });
      // A missing executable still goes through spawn so ENOENT has the same
      // terminal behavior as permission errors and an invalid working directory.
      const child = (options.spawn ?? spawn)(resolved.path, [...resolved.args, ...claudeArgs(input)], {
        cwd: input.cwd, env: options.env ?? process.env, shell: false,
        windowsHide: true, detached: !this.windows, stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      // A leader can exit while tools keep inherited pipes open. Start cleanup
      // on exit, not only close, and retain the group ID until escalation ends.
      child.once("exit", () => {
        if (!this.windows && this.groupExists() && !this.stopping) this.kill("SIGTERM");
      });
      child.on("error", () => {
        this.failure = "Claude Code process could not start or communicate";
        this.finish({ code: null, signal: null });
      });
      // Drain stderr continuously without reflecting raw diagnostics (which can
      // contain auth headers, environment values or prompts) into the dashboard.
      child.stderr?.on("data", () => {});
      child.stderr?.on("error", () => { this.fail("Claude Code stderr stream failed"); });
      child.stdout?.on("error", () => { this.fail("Claude Code output stream failed"); });
      child.stdin?.on("error", () => { this.fail("Claude Code prompt delivery failed"); });
      if (!child.stdout || !child.stdin || !child.stderr) {
        this.fail("Claude Code pipes unavailable");
      } else {
        const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        lines.on("line", (line) => this.line(line, input.sessionId));
        child.once("close", (code, signal) => {
          lines.close();
          this.finish({ code, signal });
        });
        child.stdin.end(input.text);
      }
    } catch {
      this.failure = "Claude Code process could not start";
      this.finish({ code: null, signal: null });
    }
  }

  private line(line: string, expectedSession?: string): void {
    if (this.done || this.cancelled || !line.trim()) return;
    let ev: ClaudeEvent;
    try {
      ev = JSON.parse(line);
      if (!ev || typeof ev !== "object" || Array.isArray(ev) || typeof ev.type !== "string") throw new Error();
    } catch { this.fail("Claude Code emitted invalid stream JSON"); return; }
    if (ev.session_id && expectedSession && (typeof ev.session_id !== "string" || ev.session_id.toLowerCase() !== expectedSession.toLowerCase())) {
      this.fail("Claude Code returned a different conversation ID"); return;
    }
    if (ev.type !== "result") this.nonTerminalObserved = true;
    if (typeof ev.session_id === "string" && expectedSession && ev.session_id.toLowerCase() === expectedSession.toLowerCase()
      && ((ev.type === "system" && ev.subtype === "init") || ev.type === "assistant" || ev.type === "stream_event"
        || (ev.type === "result" && ev.subtype === "success" && ev.is_error !== true))) this.sessionObserved = true;
    if (this.terminal && ["assistant", "user", "stream_event"].includes(ev.type)) this.awaitingTurnResult = true;
    if (ev.type === "result") {
      // Native CLI 2.1.274 numbers delivered turn results within a run. A
      // background-task follow-up can produce another turn before process exit.
      // Legacy unnumbered results remain single-result; never accept replay,
      // missing frames, mixed producers, or a different/absent session identity.
      const index = ev.result_index;
      if (index !== undefined && (!Number.isSafeInteger(index) || index < 0
        || (!this.terminal && index !== 0))) {
        this.fail("Claude Code emitted an invalid result sequence"); return;
      }
      if (this.terminal && (!Number.isSafeInteger(this.terminal.result_index)
        || index !== this.terminal.result_index + 1
        || typeof ev.session_id !== "string" || !ev.session_id
        || typeof this.terminal.session_id !== "string"
        || ev.session_id.toLowerCase() !== this.terminal.session_id.toLowerCase())) {
        this.fail("Claude Code emitted multiple terminal results without a valid sequence"); return;
      }
      this.terminal = ev;
      this.awaitingTurnResult = false;
      if (ev.is_error === true || (ev.is_error !== undefined && typeof ev.is_error !== "boolean") || ev.subtype !== "success" || typeof ev.result !== "string" || (ev.errors !== undefined && (!Array.isArray(ev.errors) || ev.errors.length))) {
        const failures: Record<string, string> = {
          error_max_turns: "Claude Code reached its turn limit",
          error_max_budget_usd: "Claude Code reached its budget limit",
          error_during_execution: "Claude Code execution failed",
          error_max_structured_output_retries: "Claude Code could not produce a valid structured result",
        };
        this.failure = Object.prototype.hasOwnProperty.call(failures, ev.subtype)
          ? failures[ev.subtype] : "Claude Code reported an unsuccessful result";
        this.failure += safeClaudeErrorDetail(ev) || this.lastRetryDetail;
      }
      if (typeof ev.result === "string") this.text = ev.result;
      // Result is emitted only after successful process close, never optimistically.
      return;
    }
    // Claude emits system/api_error with an error payload while scheduling its
    // own request retry. Killing here aborts a recoverable run after tool work.
    // Do not replay the prompt or start another process; the CLI owns retries.
    const retry = scheduledClaudeRetry(ev);
    if (retry) {
      this.lastRetryDetail = safeClaudeErrorDetail(ev);
      this.push({ type: "system", subtype: "api_retry", retryAttempt: retry.attempt,
        maxRetries: retry.max, retryInMs: retry.delay,
        detail: `Claude Code is retrying an API request${this.lastRetryDetail}` });
      return;
    }
    if (ev.type === "error" || ev.error) {
      this.fail(`Claude Code reported a stream error${safeClaudeErrorDetail(ev)}`); return;
    }
    if (ev.type === "system") {
      if (ev.subtype === "init") this.push({ type: "system", subtype: "init", model: ev.model });
      return;
    }
    if (ev.type === "stream_event") {
      const part = ev.event;
      if (!part || typeof part !== "object") { this.fail("Claude Code emitted an invalid partial event"); return; }
      if (part.type === "message_start") {
        // Completed assistant messages carry transcript text; partial deltas
        // have a distinct event type so additive transcript consumers do not
        // insert a newline between tokens or replay a completed message.
      } else if (part.type === "content_block_start" && part.content_block?.type === "tool_use") {
        this.startTool(part.content_block);
      } else if (part.type === "content_block_delta") {
        if (part.delta?.type === "text_delta" && typeof part.delta.text === "string") {
          this.push({ type: "text_delta", text: part.delta.text });
        } else if (part.delta?.type === "thinking_delta" && typeof part.delta.thinking === "string") {
          this.push({ type: "thinking", text: part.delta.thinking });
        }
      } else if (part.type === "content_block_stop") this.push({ type: "thinking" });
      return;
    }
    if ((ev.type === "assistant" || ev.type === "user") && ev.message) {
      if (!Array.isArray(ev.message.content)) { this.fail("Claude Code emitted invalid message content"); return; }
      for (const block of ev.message.content) {
        if (block?.type === "text" && ev.type === "assistant" && typeof block.text === "string") this.pushText(block.text);
        if (block?.type === "tool_use") this.startTool(block);
        if (block?.type === "tool_result") {
          const tool = this.tools.get(block.tool_use_id);
          if (tool) {
            const written = !block.is_error && tool.writePath
              ? { tool_call: { writeToolCall: { args: { path: tool.writePath } } } }
              : {};
            this.push({ type: "tool_call", subtype: "completed", name: tool.name, id: block.tool_use_id, is_error: block.is_error === true, ...written });
          }
        }
      }
    }
  }
  private startTool(block: ClaudeEvent) {
    if (typeof block.id !== "string" || typeof block.name !== "string") { this.fail("Claude Code emitted invalid tool metadata"); return; }
    const existing = this.tools.get(block.id);
    const writePath = ["Write", "Edit"].includes(block.name) && typeof block.input?.file_path === "string"
      ? block.input.file_path : undefined;
    this.tools.set(block.id, { name: block.name, writePath: writePath || existing?.writePath });
    if (!existing) this.push({ type: "tool_call", subtype: "started", name: block.name, id: block.id });
  }
  private pushText(text: string) {
    this.text += text;
    this.push({ type: "assistant", message: { content: [{ type: "text", text }] } });
  }
  private push(ev: ClaudeEvent) { this.events.push(ev); this.wake?.(); }
  private fail(message: string) {
    this.protocolFailed = true;
    this.failure ??= message;
    this.kill("SIGTERM");
    this.scheduleKill();
  }
  private finish(exit: { code: number | null; signal: NodeJS.Signals | null }) {
    if (this.done) return;
    if (!this.treeClean && (this.stopping || (!this.windows && this.groupExists()))) {
      this.pendingExit = exit;
      if (!this.stopping) this.kill("SIGTERM");
      return;
    }
    clearTimeout(this.killTimer);
    this.done = true;
    const terminal = this.terminal;
    // Claude Code 2.1.274 reports this exact error before session setup or
    // inference. Require every zero-work indicator and a clean failed close;
    // stderr text, generic execution errors and merely zero tokens are NOT proof.
    this.missingSessionBeforeSubmission = Boolean(this.input.resume && this.input.sessionId
      && !this.cancelled && !this.protocolFailed && !this.nonTerminalObserved
      && exit.code === 1 && exit.signal === null
      && terminal?.type === "result" && terminal.subtype === "error_during_execution"
      && terminal.is_error === true && terminal.session_id === this.input.sessionId
      && terminal.num_turns === 0 && terminal.duration_api_ms === 0 && terminal.total_cost_usd === 0
      && Array.isArray(terminal.errors) && terminal.errors.length === 1
      && terminal.errors[0] === `No conversation found with session ID: ${this.input.sessionId}`
      && terminal.usage?.input_tokens === 0 && terminal.usage?.output_tokens === 0
      && terminal.usage?.cache_creation_input_tokens === 0 && terminal.usage?.cache_read_input_tokens === 0
      && terminal.modelUsage && typeof terminal.modelUsage === "object" && !Array.isArray(terminal.modelUsage)
      && Object.keys(terminal.modelUsage).length === 0);
    const result: CursorRunResult = this.terminationFailed ? { status: "error", error: { message: "Claude Code process tree could not be terminated" } }
      : this.cancelled ? { status: "cancelled" }
      : this.failure ? { status: "error", error: { message: this.failure } }
      : exit.code !== 0 || exit.signal ? { status: "error", error: { message: `Claude Code exited unsuccessfully${this.lastRetryDetail}` } }
      : this.awaitingTurnResult ? { status: "error", error: { message: "Claude Code exited without a follow-up terminal result" } }
      : !this.terminal ? { status: "error", error: { message: `Claude Code exited without a terminal result${this.lastRetryDetail}` } }
      : { status: "finished", result: this.text };
    this.push({ type: "result", subtype: result.status === "finished" ? "success" : result.status, is_error: result.status === "error", result: result.result, error: result.error });
    this.resolve(result);
    this.close(exit);
    this.wake?.();
  }
  private groupExists(): boolean {
    const pid = this.child?.pid;
    if (this.windows || !pid) return false;
    try { process.kill(-pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  }
  private scheduleKill() {
    if (this.killTimer || this.done || this.treeClean) return;
    // Keep this timer referenced: root exit/closed pipes must not cancel cleanup
    // while a TERM-resistant descendant is still writing in the background.
    this.killTimer = setTimeout(() => this.kill("SIGKILL"), this.options.killGraceMs ?? 2000);
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    if (this.done || this.treeClean) return;
    this.stopping = true;
    const pid = this.child?.pid;
    if (this.windows && pid) {
      // Windows Node SIGTERM is immediate root-only termination, so use /T /F
      // directly rather than orphaning tools before a later tree enumeration.
      const killed = (this.options.windowsTreeKill ?? ((id) => terminateWindowsClaudeTree(id, this.options.env)))(pid);
      this.terminationFailed = !killed;
      this.treeClean = true;
      if (!killed) this.finish({ code: null, signal: null });
    } else {
      try {
        if (pid) process.kill(-pid, signal);
        else if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.terminationFailed = true;
      }
      if (signal === "SIGKILL" || !this.groupExists()) this.treeClean = true;
      // Fake children have no OS group; retain their normal TERM->KILL contract.
      if (!pid && this.child?.exitCode === null && this.child.signalCode === null && signal !== "SIGKILL") this.treeClean = false;
    }
    if (this.terminationFailed) {
      this.treeClean = true;
      this.finish({ code: null, signal: null });
    }
    if (this.treeClean) {
      clearTimeout(this.killTimer);
      if (this.pendingExit) this.finish(this.pendingExit);
    } else this.scheduleKill();
  }
  async cancel() {
    if (!this.done) {
      this.cancelled = true;
      this.kill("SIGTERM");
      this.scheduleKill();
    }
    await this.finished;
    if (this.terminationFailed) throw new Error("Claude Code process tree could not be terminated");
  }
  wait() { return this.finished; }
  async *stream(): AsyncIterable<ClaudeEvent> {
    while (true) {
      while (this.events.length) yield this.events.shift()!;
      if (this.done) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

export function formatClaudeLine(line: string): string {
  try {
    const ev = JSON.parse(line);
    if (ev?.type === "assistant" && Array.isArray(ev.message?.content)) {
      return ev.message.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("");
    }
    if (ev?.type === "tool_call") return `${ev.subtype === "completed" ? "✓" : "→"} ${ev.name || "tool"}`;
    if (ev?.type === "result" && !ev.is_error && ev.subtype === "success" && typeof ev.result === "string") return ev.result;
  } catch { /* Raw diagnostics are never promoted to assistant text. */ }
  return "";
}

export class ProcessClaudeLauncher implements ClaudeLauncher {
  constructor(private readonly options: ClaudeProcessOptions = {}) {}
  start(input: { bin: string; text: string; cwd: string }): ClaudeJob {
    const process = new ClaudeProcess(input, this.options);
    return {
      kill: (signal) => process.kill(signal),
      async *output() {
        let assistantSeen = false;
        for await (const ev of process.stream()) {
          // Keep a result-only answer, but never replay streamed assistant text.
          if (ev.type === "result" && assistantSeen) continue;
          if (ev.type === "assistant") assistantSeen = true;
          const text = formatClaudeLine(JSON.stringify(ev));
          if (text) yield text;
        }
      },
      async wait() {
        const result = await process.wait();
        const exit = await process.completion;
        if (result.status === "error") throw new Error(result.error?.message || "Claude Code failed");
        return exit;
      },
    };
  }
}
