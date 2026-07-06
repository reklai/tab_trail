import test from "node:test";
import assert from "node:assert/strict";
import { loadTsModule } from "./helpers/loadTsModule.mjs";

function loadAsyncFlowModule() {
  return loadTsModule("src/lib/common/utils/asyncFlow.ts");
}

function createDeferred() {
  let resolveDeferred = () => {};
  let rejectDeferred = () => {};
  const promise = new Promise((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

test("in-flight memo shares a single pending load across concurrent callers", async () => {
  const asyncFlow = await loadAsyncFlowModule();
  let taskRuns = 0;
  const gate = createDeferred();
  const ensureLoaded = asyncFlow.createInFlightMemo(async () => {
    taskRuns += 1;
    await gate.promise;
  });

  const firstCall = ensureLoaded();
  const secondCall = ensureLoaded();
  gate.resolve();
  await Promise.all([firstCall, secondCall]);
  await ensureLoaded();

  assert.equal(taskRuns, 1);
});

test("in-flight memo retries after a failed load", async () => {
  const asyncFlow = await loadAsyncFlowModule();
  let taskRuns = 0;
  const ensureLoaded = asyncFlow.createInFlightMemo(async () => {
    taskRuns += 1;
    if (taskRuns === 1) throw new Error("storage unavailable");
  });

  await assert.rejects(ensureLoaded(), /storage unavailable/);
  await ensureLoaded();
  await ensureLoaded();

  assert.equal(taskRuns, 2);
});

test("keyed task queue serializes tasks per key", async () => {
  const asyncFlow = await loadAsyncFlowModule();
  const queue = asyncFlow.createKeyedTaskQueue();
  const order = [];
  const firstGate = createDeferred();

  const firstTask = queue.run(1, async () => {
    await firstGate.promise;
    order.push("first");
    return "first";
  });
  const secondTask = queue.run(1, async () => {
    order.push("second");
    return "second";
  });

  firstGate.resolve();
  const results = await Promise.all([firstTask, secondTask]);

  assert.deepEqual(order, ["first", "second"]);
  assert.deepEqual(results, ["first", "second"]);
});

test("keyed task queue runs different keys concurrently", async () => {
  const asyncFlow = await loadAsyncFlowModule();
  const queue = asyncFlow.createKeyedTaskQueue();
  const order = [];
  const firstGate = createDeferred();

  const blockedTask = queue.run(1, async () => {
    await firstGate.promise;
    order.push("window one");
  });
  const independentTask = queue.run(2, async () => {
    order.push("window two");
  });

  await independentTask;
  firstGate.resolve();
  await blockedTask;

  assert.deepEqual(order, ["window two", "window one"]);
});

test("keyed task queue continues after a failed task", async () => {
  const asyncFlow = await loadAsyncFlowModule();
  const queue = asyncFlow.createKeyedTaskQueue();

  const failingTask = queue.run(1, async () => {
    throw new Error("task failed");
  });
  const followupTask = queue.run(1, async () => "recovered");

  await assert.rejects(failingTask, /task failed/);
  assert.equal(await followupTask, "recovered");
});
