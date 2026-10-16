// Browser-only git@1. Bootstrap injects the shared binary filesystem facade and
// a dynamic net.fetch@1 resolver; neither is a cross-plugin implementation import.
// One page-lived service is shared by composition and bundled recovery. Attaching
// a plugin scope never creates another VFS/network client or reads credentials.
export function createGitService({ fs, fetch: fetchImpl, origin, load = () => import("./browser-git.js") } = {}) {
  let loaded;
  const implementation = () => loaded ??= Promise.resolve().then(load).catch((error) => { loaded = undefined; throw error; });
  return Object.freeze({
    async call({ operation, options = {}, cwd = "/workspace", signal } = {}, transportFetch = fetchImpl) {
      if (signal?.aborted) throw signal.reason;
      const { createBrowserGit } = await implementation();
      if (signal?.aborted) throw signal.reason;
      let settled = false;
      const source = fs?.promises || fs;
      const guardedFs = signal && source ? new Proxy({}, { get(_target, key) {
        const value = source[key];
        if (typeof value !== "function") return value;
        return (...args) => {
          if (!settled && signal.aborted) throw signal.reason;
          return value.apply(source, args);
        };
      } }) : source;
      const git = createBrowserGit({ fs: guardedFs, cwd, fetch: (input, init) => {
        if (signal?.aborted) throw signal.reason;
        // Operation lifetime is owned by the execution caller. Upstream options
        // cannot replace it with a signal that survives worker termination.
        let local = false;
        try { local = Boolean(origin) && new URL(input).origin === new URL(origin).origin; } catch {}
        return (local ? fetchImpl : transportFetch)(input, { ...init, ...(signal ? { signal } : {}) });
      } });
      if (!Object.hasOwn(git, operation) || typeof git[operation] !== "function") {
        throw Object.assign(new Error("Unknown Git operation"), { code: "InvalidGitOperation" });
      }
      try { return await git[operation](options); }
      finally {
        // Upstream can release its fs locks in a detached finalizer after result
        // settlement. Let completed operations finish cleanup; abort only live work.
        settled = true;
      }
    }
  });
}

export function create({ service, hostInfo } = {}) {
  return {
    ...(hostInfo?.platform !== "browser" || !service ? { unavailable: "Git requires the browser's binary filesystem service." } : {}),
    setup(ctx) {
      if (hostInfo?.platform !== "browser" || !service) return;
      ctx.provide("git", 1, Object.freeze({
        available: () => !ctx.signal.aborted,
        call(input) {
          if (ctx.signal.aborted) throw new Error("Git adapter is stopped");
          return service.call(input, (request, init) => {
            const net = ctx.get("net.fetch", 1);
            if (typeof net !== "function") throw new Error("Selected network is unavailable");
            return net(request, init);
          });
        }
      }));
    }
  };
}

// Page lifetime controller: normal calls resolve the declared git@1 service.
// Only genuine setup failure/detached composition uses the SAME bundled owner.
// A stopped/blocked/unknown choice is not permission to use another provider.
export function createController(options) {
  const service = createGitService(options);
  let runtime = null;
  return Object.freeze({
    service,
    bind(value) { runtime = value ?? null; },
    resolve() {
      if (!runtime) return service;
      const records = runtime.list();
      const choice = runtime.selection?.choice("git", 1) || "core-git";
      const row = records.find(entry => entry.id === choice);
      if (row && ["stopped", "blocked"].includes(row.state)) return runtime.service("git", 1);
      if (row?.state === "failed" || records.some(entry => entry.essential && entry.state === "failed")) return service;
      return runtime.service("git", 1);
    }
  });
}
