import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isControlPlaneDir,
  resolveAgentWorkspace,
  slug,
} from "./workspace";

describe("workspace", () => {
  it("keeps agents out of the control repo", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ra-ws-"));
    const control = path.join(tmp, "remote_agents");
    const root = path.join(tmp, "workspaces");
    fs.mkdirSync(control, { recursive: true });
    const cwd = resolveAgentWorkspace({
      agentId: "agent-1",
      savedCwd: control,
      sharedCwd: control,
      workspacesRoot: root,
      controlRoot: control,
    });
    assert.equal(cwd, path.join(root, "agent-1"));
    assert.equal(isControlPlaneDir(cwd, control), false);
    assert.ok(fs.existsSync(path.join(cwd, "README.md")));
  });

  it("honors an explicit project folder", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ra-ws-"));
    const project = path.join(tmp, "my-app");
    const cwd = resolveAgentWorkspace({
      agentId: "agent-2",
      explicitCwd: project,
      workspacesRoot: path.join(tmp, "workspaces"),
      controlRoot: path.join(tmp, "remote_agents"),
    });
    assert.equal(cwd, project);
    assert.ok(fs.existsSync(project));
  });

  it("slugs extra agent ids", () => {
    assert.equal(slug("extra-Research Lab"), "extra-research-lab");
  });
});
