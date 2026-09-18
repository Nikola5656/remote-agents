import test from "node:test";
import assert from "node:assert/strict";
import { BridgeCursorRuntime } from "./bridge-cursor-runtime";
import type { ComposerSidebar } from "./composer-sidebar";
import type { DesktopBridge } from "./desktop-bridge";
import { MockCursorRuntime } from "./mock-runtime";

test("IDE model mismatch routes the exact requested model and workspace through Cursor CLI", async () => {
  const fallback = new MockCursorRuntime();
  let bridged = false;
  const sidebar = { ensureChat() {}, readConversation() { return {model:"grok-4.6",headerCount:0}; } } as unknown as ComposerSidebar;
  const bridge = { sendMessage() { bridged = true; } } as unknown as DesktopBridge;
  const runtime = new BridgeCursorRuntime(bridge,sidebar,fallback);
  const agent = await runtime.resume("test-chat",{model:"composer-2.5",cwd:"/tmp/selected-workspace",name:"Composer"});
  const run = await agent.send("task",{model:"composer-2.5"});
  await run.wait();
  assert.equal(bridged,false);
  assert.equal(fallback.sends[0].model,"composer-2.5");
  assert.equal(run.transcript,sidebar);
});
