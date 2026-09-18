import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkerConfig } from "./config";

export function testConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-agents-worker-"));
  return {
    serverUrl: "http://127.0.0.1:3847",
    serverHost: "",
    workerToken: "test-token",
    cursorApiKey: "test-key",
    cursorRuntime: "cli",
    cursorBin: "cursor",
    chatWorkspace: path.join(dataDir, "chat-workspace"),
    workerId: "test-worker",
    defaultCwd: "",
    workspacesRoot: path.join(dataDir, "workspaces"),
    controlRoot: path.join(dataDir, "control"),
    claudeBin: "claude",
    keepAwake: false,
    dataDir,
    heartbeatMs: 8000,
    sandboxMode: "disabled",
    forceRuns: true,
    ...overrides,
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(fn: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await delay(15);
  }
  throw new Error("timed out waiting for condition");
}
