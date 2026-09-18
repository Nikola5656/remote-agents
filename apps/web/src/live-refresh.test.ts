import test from "node:test";
import assert from "node:assert/strict";
import { createLiveRefresh } from "./live-refresh.js";

test("overlapping refresh triggers share one request and one state commit", async () => {
  let finish!: (value: number) => void;
  let loads = 0;
  const committed: number[] = [];
  const refresh = createLiveRefresh(() => { loads++; return new Promise<number>(r => { finish = r; }); }, v => committed.push(v));
  const pending = Array.from({ length: 10 }, () => refresh.refresh());
  await Promise.resolve();
  assert.equal(loads, 1);
  finish(42);
  assert.deepEqual(await Promise.all(pending), Array(10).fill(true));
  assert.deepEqual(committed, [42]);
});

test("a newer WebSocket snapshot or closed session invalidates late HTTP state", async () => {
  let finish!: (value: number) => void;
  const committed: number[] = [];
  const refresh = createLiveRefresh(() => new Promise<number>(r => { finish = r; }), v => committed.push(v));
  const pending = refresh.refresh();
  await Promise.resolve();
  refresh.invalidate();
  finish(1);
  assert.equal(await pending, false);
  assert.deepEqual(committed, []);
});

test("failed requests release the shared request and stale errors cannot replace live status", async () => {
  let fail!: (error: Error) => void;
  const refresh = createLiveRefresh(() => new Promise<number>((_, reject) => { fail = reject; }), () => {});
  const first = refresh.refresh();
  await Promise.resolve();
  fail(new Error("network"));
  await assert.rejects(first, /network/);
  const retry = refresh.refresh();
  assert.notEqual(retry, first);
  await Promise.resolve();
  refresh.invalidate();
  fail(new Error("obsolete failure"));
  assert.equal(await retry, false);
});

test("a stalled request is aborted and releases the slot for the next refresh", async () => {
  let loads = 0;
  let stalledSignal: AbortSignal | undefined;
  const committed: number[] = [];
  const refresh = createLiveRefresh(async (signal) => {
    if (++loads === 1) {
      stalledSignal = signal;
      // Even an uncooperative network operation cannot hold the slot forever.
      return new Promise<number>(() => {});
    }
    return 2;
  }, v => committed.push(v), 10);
  await assert.rejects(refresh.refresh(), /Refresh timed out/);
  assert.equal(stalledSignal?.aborted, true);
  assert.equal(await refresh.refresh(), true);
  assert.deepEqual(committed, [2]);
});
