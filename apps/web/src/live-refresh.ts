/** Coalesce overlapping refreshes and prevent late HTTP replies replacing newer live state. */
export function createLiveRefresh<T>(load: (signal: AbortSignal) => Promise<T>, commit: (value: T) => void, timeoutMs = 15_000) {
  let revision = 0;
  let pending: Promise<boolean> | undefined;
  return {
    invalidate() { revision += 1; },
    refresh(): Promise<boolean> {
      if (pending) return pending;
      const started = revision;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Refresh timed out"));
          controller.abort();
        }, timeoutMs);
      });
      pending = Promise.race([Promise.resolve().then(() => load(controller.signal)), deadline]).then((value) => {
        if (revision !== started) return false;
        commit(value);
        return true;
      }, (error: unknown) => {
        if (revision !== started) return false;
        throw error;
      }).finally(() => {
        clearTimeout(timer);
        pending = undefined;
      });
      return pending;
    },
  };
}
