import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { condenseOutput, estimatePercent } from "./condense";
import { dequeueInstruction, enqueueInstruction } from "./queue";

describe("condense", () => {
  it("caps running work below 100 and returns mobile-sized text", () => {
    const view = condenseOutput({
      fullText:
        "Reading auth.ts. Editing the session cookie flags. Running tests next so the login flow stays secure on mobile.",
      actions: ["read", "edit"],
      status: "running",
      toolCount: 2,
    });
    assert.ok(view.percent >= 3 && view.percent < 100);
    assert.ok(view.headline.length <= 90);
    assert.ok(view.condensedLog.startsWith("Running ·"));
    assert.ok(!view.condensedLog.includes("%"));
  });

  it("keeps short final answers visible instead of showing the previous instruction", () => {
    const view = condenseOutput({ fullText: "> Please finish the validation.\nMOBILE_UI_OK", actions: [], status: "finished" });
    assert.equal(view.headline, "MOBILE_UI_OK");
    assert.match(view.condensedLog, /MOBILE_UI_OK/);
  });

  it("marks finished work as 100%", () => {
    assert.equal(
      estimatePercent({ fullText: "done", actions: [], status: "finished" }),
      100
    );
  });

  it("starts low at the beginning of a run", () => {
    const pct = estimatePercent({
      fullText: "",
      actions: [],
      status: "running",
      toolCount: 0,
      elapsedMs: 0,
    });
    assert.ok(pct <= 10, `expected <=10, got ${pct}`);
  });

  it("does not lock to 70 on error-looking words", () => {
    const pct = estimatePercent({
      fullText: "cannot reproduce the error yet, investigating",
      actions: [],
      status: "running",
      toolCount: 1,
      elapsedMs: 10_000,
    });
    assert.notEqual(pct, 70);
    assert.ok(pct < 30);
  });

  it("grows with activity and stays below 100 while running", () => {
    const early = estimatePercent({
      fullText: "",
      actions: [],
      status: "running",
      toolCount: 1,
      elapsedMs: 30_000,
    });
    const late = estimatePercent({
      fullText: "",
      actions: [],
      status: "running",
      toolCount: 12,
      elapsedMs: 8 * 60_000,
    });
    assert.ok(late > early);
    assert.ok(late <= 92);
  });
});

describe("queue", () => {
  it("interrupt jumps the line", () => {
    let state = { items: [] as ReturnType<typeof enqueueInstruction>["next"]["items"] };
    const a = enqueueInstruction(
      state,
      { id: "a", text: "first", mode: "queue", createdAt: 1 },
      "queue"
    );
    const b = enqueueInstruction(
      a.next,
      { id: "b", text: "urgent", mode: "interrupt", createdAt: 2 },
      "interrupt"
    );
    assert.equal(b.interrupted, true);
    assert.equal(b.next.items[0].id, "b");
    const pulled = dequeueInstruction(b.next);
    assert.equal(pulled.item?.id, "b");
  });

  it("queue appends in order", () => {
    const first = enqueueInstruction(
      { items: [] },
      { id: "a", text: "one", mode: "queue", createdAt: 1 },
      "queue"
    );
    const second = enqueueInstruction(
      first.next,
      { id: "b", text: "two", mode: "queue", createdAt: 2 },
      "queue"
    );
    assert.deepEqual(
      second.next.items.map((i) => i.id),
      ["a", "b"]
    );
  });
});

it("clips verbose tool descriptions without losing status", () => {
  const view = condenseOutput({fullText:"working", actions:["shell "+"x".repeat(6000)],status:"running"});
  assert.ok(view.lastActions[0].length <= 240);
  assert.ok(view.condensedLog.length < 1000);
});

it("rejects queue overflow before changing pending instructions", () => {
  const item = {id:"x",text:"hello",mode:"queue" as const,createdAt:1};
  const state = {items:Array.from({length:100},()=>({...item}))};
  assert.throws(()=>enqueueInstruction(state,item,"queue"),/Queue is full/);
  assert.throws(()=>enqueueInstruction(state,item,"interrupt"),/Queue is full/);
  assert.equal(state.items.length,100);
});
