#!/usr/bin/env node
/**
 * Cross-platform worker setup entrypoint.
 * Dispatches to platform install scripts under apps/worker/scripts/.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  REPO_ROOT,
  assertNode,
  log,
  npmBuild,
  npmCi,
  MIN_NODE_WORKER,
  parseArgs,
  platformLabel,
} from "./setup-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const skipBuild = Boolean(args["skip-build"]);
const skipCi = Boolean(args["skip-ci"]);

function main() {
  const platform = platformLabel();
  log(`==> remote-agents worker setup (${platform})`);

  if (platform === "windows") {
    const ps1 = path.join(REPO_ROOT, "scripts/setup-worker-wsl.ps1");
    const wslArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1];
    if (skipBuild) wslArgs.push("-SkipBuild");
    if (skipCi) wslArgs.push("-SkipCi");
    const result = spawnSync("powershell", wslArgs, { stdio: "inherit", cwd: REPO_ROOT });
    process.exit(result.status ?? 1);
  }

  assertNode(MIN_NODE_WORKER, "setup-worker");

  if (!skipCi) npmCi(REPO_ROOT);
  if (!skipBuild) npmBuild(REPO_ROOT);

  const scriptDir = path.join(REPO_ROOT, "apps/worker/scripts");
  let cmd;
  let cmdArgs;

  if (platform === "macos") {
    cmd = "bash";
    cmdArgs = [path.join(scriptDir, "install-macos.sh")];
  } else if (platform === "linux" || platform === "windows-wsl") {
    cmd = "bash";
    cmdArgs = [path.join(scriptDir, "install-linux.sh")];
  } else {
    throw new Error(`unsupported platform: ${platform}`);
  }

  const result = spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: REPO_ROOT });
  process.exit(result.status ?? 1);
}

main();
