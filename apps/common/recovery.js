// apps/common/recovery.js
function createRecoveryGate(onChange = () => {
}) {
  const held = /* @__PURE__ */ new Map();
  const notify = () => onChange();
  return {
    hold(provider) {
      if (!held.has(provider)) held.set(provider, /* @__PURE__ */ new Set());
    },
    has(provider) {
      return held.has(provider);
    },
    get waiting() {
      return [...held].filter(([, waiters]) => waiters.size).map(([provider]) => provider);
    },
    release(provider) {
      const waiters = held.get(provider);
      if (!waiters) return;
      held.delete(provider);
      for (const waiter of [...waiters]) waiter.finish();
      notify();
    },
    wait(provider, signal) {
      signal?.throwIfAborted();
      const waiters = held.get(provider);
      if (!waiters) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          waiters.delete(waiter);
          signal?.removeEventListener("abort", abort);
        };
        const waiter = { finish() {
          cleanup();
          resolve();
        } };
        const abort = () => {
          cleanup();
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          notify();
        };
        waiters.add(waiter);
        signal?.addEventListener("abort", abort, { once: true });
        notify();
      });
    }
  };
}
export {
  createRecoveryGate
};
