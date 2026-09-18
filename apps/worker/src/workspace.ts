import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandHome(input: string): string {
  const value = input.trim();
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

export function slug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "agent";
}

export function defaultWorkspacesRoot(): string {
  return path.join(os.homedir(), "remote-agent-workspaces");
}

export function isControlPlaneDir(cwd: string, controlRoot: string): boolean {
  if (!cwd || !controlRoot) return false;
  const target = path.resolve(expandHome(cwd));
  const root = path.resolve(expandHome(controlRoot));
  return target === root || target.startsWith(root + path.sep);
}

export function ensureWorkspace(dir: string): string {
  const resolved = expandHome(dir);
  fs.mkdirSync(resolved, { recursive: true });
  const marker = path.join(resolved, "README.md");
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(
      marker,
      "# Agent workspace\n\nThis folder is the working tree for a Remote Agents slot.\nIt is separate from the control app in `remote_agents`.\n",
      "utf8"
    );
  }
  return resolved;
}

export function resolveAgentWorkspace(opts: {
  agentId: string;
  explicitCwd?: string;
  savedCwd?: string;
  sharedCwd?: string;
  workspacesRoot: string;
  controlRoot: string;
}): string {
  const candidates = [opts.explicitCwd, opts.savedCwd, opts.sharedCwd];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    if (isControlPlaneDir(value, opts.controlRoot)) continue;
    return ensureWorkspace(value);
  }
  return ensureWorkspace(path.join(expandHome(opts.workspacesRoot), slug(opts.agentId)));
}
