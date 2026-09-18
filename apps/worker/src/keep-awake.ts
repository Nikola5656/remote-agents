import { spawn, type ChildProcess } from "node:child_process";
import { log, logError } from "./log";

const PULSE_MS = 2 * 60 * 1000;
const WATCH_MS = 10_000;

export interface KeepAwakeReport {
  caffeinate: boolean;
  preventingSleep: boolean;
  detail: string;
}

/**
 * Prevents idle/sleep while the worker is running.
 * Uses caffeinate only — never writes permanent pmset power settings.
 */
export class KeepAwake {
  private hold: ChildProcess | null = null;
  private pulseTimer: NodeJS.Timeout | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private holdAlive = false;

  constructor(
    private readonly enabled: boolean,
    private readonly spawnFn: typeof spawn = spawn
  ) {}

  start(): void {
    if (!this.enabled) {
      log("keep-awake disabled (KEEP_AWAKE=0)");
      return;
    }
    if (process.platform !== "darwin") {
      log("keep-awake skipped (not macOS)");
      return;
    }
    this.stopped = false;
    this.spawnHold();
    this.pulseTimer = setInterval(() => this.pulse(), PULSE_MS);
    this.watchTimer = setInterval(() => this.watchdog(), WATCH_MS);
    this.pulseTimer.unref?.();
    this.watchTimer.unref?.();
    log("keep-awake started (caffeinate -dims -w", process.pid, ")");
  }

  stop(): void {
    this.stopped = true;
    if (this.pulseTimer) clearInterval(this.pulseTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.pulseTimer = null;
    this.watchTimer = null;
    if (this.hold && !this.hold.killed) {
      this.hold.kill("SIGTERM");
    }
    this.hold = null;
    this.holdAlive = false;
  }

  report(): KeepAwakeReport {
    if (!this.enabled) {
      return {
        caffeinate: false,
        preventingSleep: false,
        detail: "KEEP_AWAKE disabled",
      };
    }
    if (process.platform !== "darwin") {
      return {
        caffeinate: false,
        preventingSleep: false,
        detail: "caffeinate is only available on macOS",
      };
    }
    const alive = this.holdAlive && !!this.hold && this.hold.exitCode === null;
    return {
      caffeinate: alive,
      preventingSleep: alive,
      detail: alive
        ? `caffeinate -dims holding pid ${process.pid}; idle pulse every 2m`
        : "caffeinate hold is not running (watchdog will restart)",
    };
  }

  private spawnHold(): void {
    if (this.stopped) return;
    try {
      const child = this.spawnFn("caffeinate", ["-dims", "-w", String(process.pid)], {
        stdio: "ignore",
      });
      this.hold = child;
      this.holdAlive = true;
      child.on("exit", (code, signal) => {
        this.holdAlive = false;
        log("caffeinate hold exited", code, signal);
        if (!this.stopped) {
          setTimeout(() => this.spawnHold(), 500).unref?.();
        }
      });
      child.on("error", (err) => {
        this.holdAlive = false;
        logError("caffeinate hold error", err);
      });
    } catch (err) {
      this.holdAlive = false;
      logError("failed to spawn caffeinate hold", err);
    }
  }

  private watchdog(): void {
    if (this.stopped) return;
    const dead =
      !this.hold ||
      this.hold.killed ||
      this.hold.exitCode !== null ||
      !this.holdAlive;
    if (dead) {
      log("keep-awake watchdog restarting caffeinate");
      this.spawnHold();
    }
  }

  private pulse(): void {
    if (this.stopped) return;
    try {
      const child = this.spawnFn("caffeinate", ["-u", "-t", "5"], {
        stdio: "ignore",
      });
      child.on("error", (err) => logError("caffeinate pulse error", err));
    } catch (err) {
      logError("failed to pulse caffeinate", err);
    }
  }
}
