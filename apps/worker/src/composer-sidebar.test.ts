import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
  ComposerSidebar,
  resolveChatWorkspace,
  resolveSidebarWorkspace,
} from "./composer-sidebar";

interface TestDb {
  exec(sql: string): void;
  prepare(sql: string): { all: (...params: unknown[]) => unknown[] };
  close(): void;
}

function sqlite(file: string): TestDb {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => TestDb;
  };
  return new DatabaseSync(file);
}

function queryAll<T>(file: string, sql: string, ...params: unknown[]): T[] {
  const db = sqlite(file);
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function createDb(file: string): void {
  const db = sqlite(file);
  db.exec(`
    CREATE TABLE composerHeaders (
      composerId TEXT,
      workspaceId TEXT,
      createdAt INTEGER,
      lastUpdatedAt INTEGER,
      isArchived INTEGER,
      isSubagent INTEGER,
      recency INTEGER,
      checkpointAt INTEGER,
      value TEXT
    );
    CREATE TABLE cursorDiskKV (
      key TEXT,
      value BLOB
    );
  `);
  db.close();
}

describe("composer sidebar", () => {
  it("maps a workspace folder to the IDE storage id", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ra-ws-store-"));
    const id = "abc123workspace";
    const workspace = path.join(root, "project");
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(
      path.join(root, id, "workspace.json"),
      JSON.stringify({ folder: pathToFileURL(workspace).href })
    );
    const mapped = resolveSidebarWorkspace(workspace, root);
    assert.deepEqual(mapped, { id, folderPath: workspace });
  });

  it("prefers an explicit chat workspace when it exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-chat-ws-"));
    assert.equal(resolveChatWorkspace(dir, "/tmp/control"), path.resolve(dir));
  });

  it("upserts a named Agent 1 header that the sidebar list can find", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-composer-"));
    const dbPath = path.join(dir, "state.vscdb");
    createDb(dbPath);
    const sidebar = new ComposerSidebar(dbPath, {
      id: "ec22261f4cf3cf60423626c95026d550",
      configPath: "/tmp/window.code-workspace",
    });
    const id = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    assert.equal(sidebar.ensureChat({ composerId: id, name: "Agent 1", model: "claude-fable-5-1" }), true);
    assert.equal(sidebar.hasChat(id), true);
    assert.equal(sidebar.findNamedChat("Agent 1"), id);
    sidebar.touchChat(id, "Agent 1 online");
    assert.equal(sidebar.findNamedChat("Agent 1"), id);
  });

  it("mirrors an exchange as bubbles plus conversation headers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-mirror-"));
    const dbPath = path.join(dir, "state.vscdb");
    createDb(dbPath);
    const sidebar = new ComposerSidebar(dbPath, {
      id: "ec22261f4cf3cf60423626c95026d550",
      configPath: "/tmp/window.code-workspace",
    });
    const id = "cccccccc-dddd-4eee-8fff-000000000000";
    assert.equal(
      sidebar.ensureChat({ composerId: id, name: "Agent 1", model: "claude-fable-5-1" }),
      true
    );

    const assistantBubbleId = sidebar.startExchange(id, "Agent 1 online");
    assert.ok(assistantBubbleId);
    sidebar.updateExchange(id, assistantBubbleId!, "streaming output…");
    sidebar.finishExchange(id, assistantBubbleId!, "worker test output", "Done");

    const bubbles = queryAll<{ key: string; value: string }>(
      dbPath,
      "SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY key",
      `bubbleId:${id}:%`
    );
    assert.equal(bubbles.length, 2);
    const parsed = bubbles.map((row) => JSON.parse(String(row.value)));
    const user = parsed.find((b) => b.type === 1);
    const assistant = parsed.find((b) => b.type === 2);
    assert.equal(user.text, "Agent 1 online");
    assert.equal(user.richText, "Agent 1 online");
    assert.equal(user._v, 3);
    assert.equal(assistant.text, "worker test output");
    assert.equal(assistant.bubbleId, assistantBubbleId);

    const dataRow = queryAll<{ value: string }>(
      dbPath,
      "SELECT value FROM cursorDiskKV WHERE key = ?",
      `composerData:${id}`
    )[0];
    const data = JSON.parse(String(dataRow.value));
    const headers = data.fullConversationHeadersOnly as Array<{
      bubbleId: string;
      type: number;
      grouping: { isRenderable?: boolean };
    }>;
    assert.equal(headers.length, 2);
    assert.deepEqual(
      headers.map((h) => h.type),
      [1, 2]
    );
    assert.equal(headers[1].bubbleId, assistantBubbleId);
    assert.equal(headers[0].grouping.isRenderable, true);

    const header = queryAll<{ value: string }>(
      dbPath,
      "SELECT value FROM composerHeaders WHERE composerId = ?",
      id
    )[0];
    assert.equal(JSON.parse(String(header.value)).subtitle, "Done");

    // Re-running an exchange appends, never duplicates existing headers.
    const second = sidebar.startExchange(id, "next task");
    assert.ok(second);
    const after = JSON.parse(
      String(
        queryAll<{ value: string }>(
          dbPath,
          "SELECT value FROM cursorDiskKV WHERE key = ?",
          `composerData:${id}`
        )[0].value
      )
    );
    assert.equal(after.fullConversationHeadersOnly.length, 4);
  });

  it("caps mirrored bubble text at 32KB", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-mirror-cap-"));
    const dbPath = path.join(dir, "state.vscdb");
    createDb(dbPath);
    const sidebar = new ComposerSidebar(dbPath, { id: "ws", folderPath: "/tmp" });
    const id = "dddddddd-eeee-4fff-8000-111111111111";
    sidebar.ensureChat({ composerId: id, name: "Cap test" });
    const bubbleId = sidebar.startExchange(id, "hi");
    assert.ok(bubbleId);
    sidebar.finishExchange(id, bubbleId!, "x".repeat(100_000));
    const row = queryAll<{ value: string }>(
      dbPath,
      "SELECT value FROM cursorDiskKV WHERE key = ?",
      `bubbleId:${id}:${bubbleId}`
    )[0];
    const text = JSON.parse(String(row.value)).text as string;
    assert.ok(text.length <= 32_001);
    assert.ok(text.startsWith("…"));
  });

  it("reads conversation steps: text, thinking, and tool calls", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-read-"));
    const dbPath = path.join(dir, "state.vscdb");
    createDb(dbPath);
    const sidebar = new ComposerSidebar(dbPath, { id: "ws", folderPath: "/tmp" });
    const id = "eeeeeeee-ffff-4000-8111-222222222222";
    sidebar.ensureChat({ composerId: id, name: "Reader" });

    const db = sqlite(dbPath);
    const put = (key: string, value: string) =>
      db.exec(`INSERT INTO cursorDiskKV (key, value) VALUES ('${key}', '${value.replace(/'/g, "''")}')`);
    const headers = [
      { bubbleId: "u1", type: 1 },
      { bubbleId: "think1", type: 2 },
      { bubbleId: "tool1", type: 2 },
      { bubbleId: "ans1", type: 2 },
    ];
    db.exec(
      `UPDATE cursorDiskKV SET value = '${JSON.stringify({
        _v: 18,
        isNAL: true,
        status: "completed",
        generatingBubbleIds: [],
        lastUpdatedAt: 123,
        fullConversationHeadersOnly: headers,
      }).replace(/'/g, "''")}' WHERE key = 'composerData:${id}'`
    );
    put(`bubbleId:${id}:think1`, JSON.stringify({ type: 2, thinking: { text: "pondering" } }));
    put(
      `bubbleId:${id}:tool1`,
      JSON.stringify({
        type: 2,
        toolFormerData: {
          name: "read_file_v2",
          status: "completed",
          rawArgs: JSON.stringify({ path: "/tmp/README.md" }),
        },
      })
    );
    put(`bubbleId:${id}:ans1`, JSON.stringify({ type: 2, text: "final answer" }));
    db.close();

    const state = sidebar.readConversation(id, 0);
    assert.ok(state);
    assert.equal(state!.status, "completed");
    assert.equal(state!.assistant.length, 3);
    assert.equal(state!.assistant[0].thinking, "pondering");
    assert.deepEqual(state!.assistant[1].tool, {
      name: "read file",
      target: "README.md",
      status: "completed",
    });
    assert.equal(state!.assistant[2].text, "final answer");
  });

  it("does not crash when the db is missing", () => {
    const sidebar = new ComposerSidebar("/nonexistent/state.vscdb", { id: "ws" });
    assert.equal(sidebar.startExchange("some-id", "hello"), null);
    sidebar.updateExchange("some-id", "bubble", "text");
    sidebar.finishExchange("some-id", "bubble", "text");
  });
});
