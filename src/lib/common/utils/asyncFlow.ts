// Async coordination primitives used by both the background worker and content
// scripts: a sleep helper, single-flight memoization, and keyed task queues for
// per-tab event serialization.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type InFlightMemo = () => Promise<void>;

export function createInFlightMemo(task: () => Promise<void>): InFlightMemo {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = task().catch((error: unknown) => {
      inFlight = null;
      throw error;
    });
    return inFlight;
  };
}

export interface KeyedTaskQueue {
  run<T>(key: number, task: () => Promise<T>): Promise<T>;
}

export function createKeyedTaskQueue(): KeyedTaskQueue {
  const tasksByKey = new Map<number, Promise<void>>();
  return {
    run<T>(key: number, task: () => Promise<T>): Promise<T> {
      const previousTask = tasksByKey.get(key) ?? Promise.resolve();
      const result = previousTask.then(() => task());
      const settled = result.then(() => {}, () => {});
      tasksByKey.set(key, settled);
      void settled.then(() => {
        if (tasksByKey.get(key) === settled) {
          tasksByKey.delete(key);
        }
      });
      return result;
    },
  };
}
