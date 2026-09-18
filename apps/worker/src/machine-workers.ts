import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import os from "node:os";
import { log, logError } from "./log";

/**
 * Supervises a single `cursor agent worker` (My Machines) process for this
 * Mac. The worker daemon locks its per-user data dir, so only one process can
 * run; personal workers allow shared assignment, letting several cloud agents
 * execute tool calls here concurrently. All agent slots share one machine
 * name (default "remote-mac").
 */

export interface MachineWorkersOptions {
  bin: string;
  apiKey: string;
  /** Workspace roots exposed to agents (home dir covers everything else). */
  dirs: string[];
  machineName?: string;
}

export class MachineWorkers {
  private child: ChildProcess | null = null;
  private restarts = 0;
  private disposed = false;

  constructor(private readonly opts: MachineWorkersOptions) {
    process.on("exit", () => this.kill());
  }

  machineName(_slotId?: string): string {
    return this.opts.machineName || "remote-mac";
  }

  /** Ensure the shared worker is running; returns the machine name. */
  ensure(_slotId?: string, _cwd?: string): string {
    if (!this.child || this.child.exitCode !== null) this.start();
    return this.machineName();
  }

  dispose(): void {
    this.disposed = true;
    this.kill();
  }

  private start(): void {
    if (this.disposed) return;
    // Reap stale workers from previous processes (they hold the daemon lock).
    try {
      spawnSync("pkill", ["-f", "cursor-agent.* worker |agent worker .*start"], { timeout: 5000 });
    } catch {
      // best effort
    }
    const dirs = [...new Set(this.opts.dirs.filter(Boolean))];
    const args = [
      "agent",
      "worker",
      "--name",
      this.machineName(),
      ...dirs.flatMap((d) => ["--worker-dir", d]),
      "--api-key",
      this.opts.apiKey,
      "--idle-release-timeout",
      "0",
      "start",
    ];
    const child = spawn(this.opts.bin, args, {
      cwd: dirs[0] || os.homedir(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) log(`[machine ${this.machineName()}]`, text.slice(0, 400));
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) log(`[machine ${this.machineName()}] err`, text.slice(0, 400));
    });
    child.on("error", (err) => logError("machine worker spawn failed", err));
    child.on("close", (code) => {
      if (this.disposed || this.child !== child) return;
      this.restarts += 1;
      const delay = Math.min(2000 * this.restarts, 30_000);
      log("machine worker exited", `code=${code}`, `restart in ${delay}ms`);
      setTimeout(() => {
        if (!this.disposed && this.child === child) this.start();
      }, delay).unref?.();
    });
    log("machine worker started", this.machineName(), "dirs", dirs.join(", "));
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }
}
