// Plain-browser composition, not a sandbox. Local service values are never serialized.
const PLUGIN_ID = /^[a-z][a-z0-9-]{1,63}$/;
const serviceKey = (id, version) => `${id}@${version}`;
const message = (error) => error instanceof Error ? error.message : String(error);

function contract(id, version) {
  if (typeof id !== "string" || !id || id.includes("@") || !Number.isSafeInteger(version) || version < 1) {
    throw new TypeError("A service needs a nonempty id (without @) and a positive integer major version");
  }
  return serviceKey(id, version);
}
function declarations(items = []) {
  if (!Array.isArray(items)) throw new TypeError("Service declarations must be arrays");
  const seen = new Set();
  return items.map(({ id, version, default: isDefault }) => {
    const key = contract(id, version);
    if (seen.has(key)) throw new Error(`Duplicate service declaration: ${key}`);
    seen.add(key);
    return Object.freeze({ id, version, key, ...isDefault === true ? { default: true } : {} });
  });
}

/**
 * Register the complete page composition before start(). A runtime starts once;
 * stopped/failed plugins are not implicitly retried. Replace the runtime at a safe
 * page/session boundary, not while durable tasks are running.
 *
 * providers is optional explicit selection: { "execution@1": "core-execution" }.
 * Nonselected providers can activate, but their implementations are never resolved.
 * onError(error, {id, phase}) also receives cleanup/listener errors; it must not throw.
 * requestStop(id) is the user-initiated path (Settings → Plugins, external callers): for an active
 * essential reload:"page" plugin (or a plugin it depends on) it rejects without touching anything and
 * marks it reloadPending (list(), reloadPending()). stop(id) is internal teardown/failure handling/
 * fallback and always stops; close() tears all down.
 * start/stop/close return promises; list returns detached diagnostic records.
 *
 * pi is the host's frozen pi-durable/pi-ai export bag (plugin-pi.js), passed by
 * identity as ctx.pi so plugins never bundle their own pi-durable copy.
 * diagnose(kind, key, info|null) lets a consumer (e.g. agent-extensions.js) mark
 * one active contribution installed/failed; list() shows it under contributions.
 *
 * Provider selection (N1, any service): a provides entry may be marked default: true. A service with several
 * providers and exactly one default is not a conflict: all providers activate, the default is the one dependants
 * are ordered after, and service(id, version) resolves per call = the user's persisted choice (choose()) if that
 * provider is active and available (its service value has no available() or it returns truthy; synchronous),
 * else the default ONLY if it is also active and available. If neither is usable, value/provider are null,
 * with an honest reason (selection.resolve(): {value, provider, default, choice, reason, status}); consumers
 * must not interpret this as permission to use another transport. Availability may throw (unavailable).
 * Activation follows intended selection (choice or default), not the resolved ready provider, so a lazy
 * default can start while unavailable. Never silent: the reason is also pushed to subscribe() listeners.
 * The choice is stored under
 * "self-forming.provider.<id>@<version>" in `storage` (getItem/setItem/removeItem, default localStorage), except
 * net.fetch@1, which keeps "self-forming.net.route". No reload is needed to switch: callers that resolve per
 * request (service()) follow at once; a provider that cannot be swapped live must use reload:"page" and the
 * requestStop/reloadPending path.
 *
 * Definitions may also carry essential: true (a built-in the agent needs; consumers
 * such as agent-extensions.js never let a conversation deselect it; external
 * packages from plugin-client.js cannot set it) and unavailable: "reason" (a host
 * capability is missing, e.g. in a fork): the plugin is then blocked with that
 * reason at start(), never set up, and its hard dependents are blocked as well.
 */
export function createPluginRuntime({ onError = () => {}, providers = {}, pi, storage = defaultStorage() } = {}) {
  const records = new Map();
  const selections = new Map(Object.entries(providers));
  const selected = new Map();
  const entries = new Map();
  const listeners = new Set();
  let begun = false, closed = false, starting, closing;
  let ordered = [];

  function report(error, id, phase) {
    try { onError(error, { id, phase }); } catch { /* Reporting cannot stop teardown. */ }
  }
  function owned(r) {
    const result = [];
    for (const [kind, registry] of entries) for (const entry of registry.values()) {
      if (entry.owner !== r || entry.owner.scope?.closed) continue;
      result.push({ kind, key: entry.key, order: entry.order, ...(entry.diagnostic ? structuredCopy(entry.diagnostic) : {}) });
    }
    return result.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  function list() {
    return [...records.values()].map((r) => {
      const contributions = owned(r);
      return {
        id: r.id, version: r.version, reload: r.reload, state: r.state,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.essential ? { essential: true } : {}),
        ...(r.reloadPending ? { reloadPending: true } : {}),
        provides: r.provides.map(({ id, version, default: isDefault }) => ({ id, version, ...isDefault ? { default: true } : {} })),
        requires: r.requires.map(({ id, version }) => ({ id, version })),
        uses: r.uses.map(({ id, version }) => ({ id, version })),
        ...(contributions.length ? { contributions } : {})
      };
    });
  }
  function diagnose(kind, key, info) {
    const entry = entries.get(kind)?.get(key);
    if (!entry || entry.owner.scope?.closed) return false;
    const next = info == null ? undefined : structuredCopy(info);
    if (JSON.stringify(next) === JSON.stringify(entry.diagnostic)) return true;
    entry.diagnostic = next;
    emit();
    return true;
  }
  function emit() {
    for (const listener of [...listeners]) {
      try { listener(list()); } catch (error) { report(error, null, "subscribe"); }
    }
  }
  function state(r, value, reason) {
    if (r.state === value && r.reason === reason) return;
    r.state = value;
    r.reason = reason;
    emit();
  }
  const liveProvider = (r, key) => Boolean(r) && r.state === "active" && !r.scope?.closed && r.values.has(key);
  const providersOf = (key) => [...records.values()].filter((r) => r.provides.some((dep) => dep.key === key));
  const nameOf = (r) => r.name ?? r.id;
  function availableValue(value) {
    try { return typeof value?.available !== "function" || Boolean(value.available()); }
    catch { return false; }
  }
  function unusableReason(r, key) {
    if (!liveProvider(r, key)) return `${nameOf(r)} is not active`;
    return availableValue(r.values.get(key)) ? null : `${nameOf(r)} is not available`;
  }
  const choiceKey = (key) => CHOICE_KEYS[key] ?? `${CHOICE_PREFIX}${key}`;
  const unsaved = new Set();
  const lastReason = new Map();
  function choiceOf(key) {
    try { return storage?.getItem(choiceKey(key)) || null; } catch { return null; }
  }
  function resolution(id, version = 1) {
    const key = contract(id, version);
    const all = providersOf(key), def = selected.get(key) ?? null;
    const choice = all.length ? choiceOf(key) : null;
    let provider = null, reason = null;
    if (choice && choice !== def?.id) {
      const wanted = all.find((r) => r.id === choice);
      reason = wanted ? unusableReason(wanted, key) : `Saved provider "${choice}" is not installed`;
      if (!reason) provider = wanted;
    }
    if (!provider && def) {
      const unavailable = unusableReason(def, key);
      if (!unavailable) {
        provider = def;
        if (reason) reason += `; using ${nameOf(def)} instead.`;
      } else {
        reason = reason ? `${reason}; ${unavailable}.` : `${unavailable}.`;
      }
    } else if (!provider && reason) reason += ".";
    if (!provider && !reason && all.length) reason = `No provider of ${key} is selected.`;
    const base = reason ?? (provider ? `Using ${nameOf(provider)}.` : `No provider of ${key}.`);
    return Object.freeze({
      key, value: provider ? provider.values.get(key) : null, provider: provider?.id ?? null, default: def?.id ?? null,
      choice, reason, status: unsaved.has(key) ? `${base} The choice could not be saved.` : base
    });
  }
  function service(id, version = 1) {
    const result = resolution(id, version);
    if ((lastReason.get(result.key) ?? null) !== result.reason) {
      lastReason.set(result.key, result.reason);
      if (!closed) queueMicrotask(() => { if (!closed) emit(); });
    }
    return result.value;
  }
  function providerList(id, version = 1) {
    const key = contract(id, version), def = selected.get(key);
    return providersOf(key).map((r) => {
      const live = liveProvider(r, key);
      return { id: r.id, name: nameOf(r), ...r.hint ? { hint: r.hint } : {}, default: r === def, state: r.state, active: live, available: live && availableValue(r.values.get(key)), ...r.reason ? { reason: r.reason } : {} };
    }).sort((a, b) => (b.default - a.default) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  /** Services (id, version) with several providers and a default: the ones that need a selector (Settings → Providers). */
  function selectable() {
    const found = new Map();
    for (const r of records.values()) for (const dep of r.provides) {
      const entry = found.get(dep.key) ?? { id: dep.id, version: dep.version, count: 0 };
      entry.count += 1;
      found.set(dep.key, entry);
    }
    return [...found].filter(([key, entry]) => entry.count > 1 && selected.has(key)).map(([, { id, version }]) => ({ id, version }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version));
  }
  /** Persist the choice (null/the default = no saved choice). false: not a provider of this service. */
  function choose(id, version, providerId) {
    const key = contract(id, version), def = selected.get(key);
    const clearing = providerId == null || providerId === def?.id;
    if (!clearing && !providersOf(key).some((r) => r.id === providerId)) return false;
    unsaved.delete(key);
    try { if (clearing) storage?.removeItem?.(choiceKey(key)); else storage?.setItem(choiceKey(key), providerId); }
    catch { unsaved.add(key); }
    lastReason.delete(key);
    emit();
    return true;
  }
  function contributions(kind) {
    return [...(entries.get(kind)?.values() ?? [])]
      .filter((entry) => entry.owner.state === "active" && !entry.owner.scope.closed)
      .sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(({ key, value, order, owner }) => ({ kind, key, value, order, providerId: owner.id }));
  }

  function makeScope(r) {
    const controller = new AbortController();
    const stack = [];
    let ended = false, closingScope;
    function run(fn) {
      try { return Promise.resolve(fn()).catch((error) => report(error, r.id, "cleanup")); }
      catch (error) { report(error, r.id, "cleanup"); return Promise.resolve(); }
    }
    function cleanup(fn) {
      if (typeof fn !== "function") throw new TypeError("cleanup expects a function");
      let called = false;
      const once = () => { if (!called) { called = true; return fn(); } };
      if (ended) void run(once); // Late setup completions still release their resources.
      else stack.push(once);
    }
    function assertOpen() {
      if (ended) throw new Error(`Plugin scope is closed: ${r.id}`);
    }
    function close() {
      if (closingScope) return closingScope;
      ended = true;
      // Assign before dispatching abort: abort listeners may reenter stop/close.
      closingScope = Promise.resolve().then(async () => {
        while (stack.length) await run(stack.pop());
        r.values.clear();
      });
      controller.abort();
      // Registrations become invisible immediately; cleanup is awaited in reverse order.
      return closingScope;
    }
    function timer(repeat, fn, delay, args) {
      assertOpen();
      if (typeof fn !== "function") throw new TypeError("Managed timers require a function");
      const invoke = () => {
        if (ended) return;
        try { Promise.resolve(fn(...args)).catch((error) => report(error, r.id, "timer")); }
        catch (error) { report(error, r.id, "timer"); }
      };
      const handle = repeat ? globalThis.setInterval(invoke, delay) : globalThis.setTimeout(invoke, delay);
      cleanup(() => repeat ? globalThis.clearInterval(handle) : globalThis.clearTimeout(handle));
      return handle;
    }
    const ctx = Object.freeze({
      id: r.id, version: r.version, signal: controller.signal, cleanup,
      ...(pi ? { pi } : {}),
      provide(id, version, implementation) {
        assertOpen();
        const key = contract(id, version);
        if (!r.provides.some((dep) => dep.key === key)) throw new Error(`Undeclared provided service: ${key}`);
        if (implementation == null) throw new TypeError(`Service ${key} cannot be null or undefined`);
        if (r.values.has(key)) throw new Error(`Service already provided by ${r.id}: ${key}`);
        r.values.set(key, implementation);
        cleanup(() => { r.values.delete(key); });
      },
      get(id, version = 1) {
        assertOpen();
        const key = contract(id, version);
        if (![...r.requires, ...r.uses].some((dep) => dep.key === key)) throw new Error(`Undeclared dependency: ${key}`);
        return service(id, version);
      },
      contribute(kind, key, value, order = 0) {
        assertOpen();
        if (typeof kind !== "string" || !kind || typeof key !== "string" || !key || !Number.isFinite(order)) {
          throw new TypeError("Contributions need nonempty kind/key and finite order");
        }
        let registry = entries.get(kind);
        if (!registry) entries.set(kind, registry = new Map());
        const previous = registry.get(key);
        if (previous && !previous.owner.scope.closed) throw new Error(`Contribution conflict: ${kind}/${key} (${previous.owner.id}, ${r.id})`);
        const entry = { key, value, order, owner: r };
        registry.set(key, entry);
        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          if (registry.get(key) === entry) { registry.delete(key); emit(); }
        };
        cleanup(dispose);
        emit();
        return dispose;
      },
      setTimeout(fn, delay, ...args) { return timer(false, fn, delay, args); },
      setInterval(fn, delay, ...args) { return timer(true, fn, delay, args); }
    });
    return { ctx, close, get closed() { return ended; } };
  }

  function register(definition) {
    if (begun || closed) throw new Error("Register the complete composition before start()");
    const { id, version, setup, reload = "scope" } = definition;
    if (typeof id !== "string" || !PLUGIN_ID.test(id)) throw new TypeError(`Invalid plugin id: ${id}`);
    if (records.has(id)) throw new Error(`Duplicate plugin id: ${id}`);
    if (definition.api !== undefined && definition.api !== 1) throw new Error(`Unsupported plugin API ${definition.api}; this host supports API 1`);
    if (typeof version !== "string" || !version || typeof setup !== "function") throw new TypeError("Plugins require a version string and setup function");
    if (!["scope", "page", "restart"].includes(reload)) throw new TypeError(`Invalid reload policy: ${reload}`);
    if (definition.unavailable !== undefined && (typeof definition.unavailable !== "string" || !definition.unavailable)) throw new TypeError("unavailable must be a nonempty reason string");
    const requires = declarations(definition.requires), uses = declarations(definition.uses);
    if (uses.some((dep) => requires.some((hard) => hard.key === dep.key))) throw new Error("A dependency cannot be both required and optional");
    records.set(id, {
      id, version, setup, reload, provides: declarations(definition.provides), requires, uses,
      name: typeof definition.name === "string" && definition.name ? definition.name : undefined,
      hint: typeof definition.hint === "string" && definition.hint ? definition.hint : undefined,
      essential: definition.essential === true, unavailable: definition.unavailable,
      state: "installed", reason: undefined, values: new Map(), scope: null, stopRequested: false
    });
    emit();
  }

  function plan() {
    const candidates = new Map();
    const block = (r, reason) => { if (r.state === "installed") state(r, "blocked", reason); };
    for (const r of records.values()) if (r.unavailable) block(r, r.unavailable);
    for (const r of records.values()) for (const dep of r.provides) {
      if (!candidates.has(dep.key)) candidates.set(dep.key, []);
      candidates.get(dep.key).push(r);
    }
    for (const [key, choices] of candidates) {
      const selection = selections.get(key);
      const defaults = choices.filter((r) => r.provides.some((dep) => dep.key === key && dep.default));
      const choice = selection === undefined ? (choices.length === 1 ? choices[0] : defaults.length === 1 ? defaults[0] : null) : choices.find((r) => r.id === selection);
      if (choice) selected.set(key, choice);
      else for (const r of choices) block(r, selection === undefined
        ? `Provider conflict for ${key}: ${choices.map((p) => p.id).join(", ")}; mark exactly one as default or select a provider explicitly`
        : `Selected provider ${selection} does not provide ${key}`);
    }
    for (const r of records.values()) for (const dep of r.requires) {
      if (!selected.has(dep.key)) block(r, `Missing or conflicted required service: ${dep.key}`);
    }
    function propagate() {
      let changed;
      do {
        changed = false;
        for (const r of records.values()) if (r.state === "installed") {
          const dep = r.requires.find((dep) => selected.get(dep.key)?.state === "blocked");
          if (dep) { block(r, `Required provider blocked: ${dep.key} (${selected.get(dep.key).id})`); changed = true; }
        }
      } while (changed);
    }
    propagate();
    // Snapshot the graph before blocking cycles. Mutating it during traversal can
    // miss overlapping optional cycles (A->B->A and B->C->B).
    const graph = new Map([...records.values()].filter((r) => r.state === "installed").map((r) => [r,
      [...r.requires, ...r.uses].map((dep) => selected.get(dep.key)).filter((p) => p?.state === "installed")
    ]));
    const indices = new Map(), low = new Map(), stack = [], onStack = new Set();
    let sequence = 0;
    function connect(r) {
      indices.set(r, sequence); low.set(r, sequence++);
      stack.push(r); onStack.add(r);
      for (const provider of graph.get(r)) {
        if (!indices.has(provider)) { connect(provider); low.set(r, Math.min(low.get(r), low.get(provider))); }
        else if (onStack.has(provider)) low.set(r, Math.min(low.get(r), indices.get(provider)));
      }
      if (low.get(r) !== indices.get(r)) return;
      const members = []; let member;
      do { member = stack.pop(); onStack.delete(member); members.push(member); } while (member !== r);
      if (members.length > 1 || graph.get(r).includes(r)) {
        const reason = `Dependency cycle among: ${members.map((p) => p.id).sort().join(", ")}`;
        for (const cyclic of members) block(cyclic, reason);
      }
    }
    for (const r of graph.keys()) if (!indices.has(r)) connect(r);
    propagate();
    const visited = new Set();
    function visit(r) {
      if (r.state !== "installed" || visited.has(r)) return;
      visited.add(r);
      for (const provider of graph.get(r) ?? []) visit(provider);
      ordered.push(r);
    }
    for (const r of records.values()) visit(r);
  }

  async function activate(r) {
    if (closed || r.stopRequested || r.state !== "installed") return;
    const unavailable = r.requires.find((dep) => selected.get(dep.key)?.state !== "active");
    if (unavailable) { state(r, "blocked", `Required service unavailable: ${unavailable.key}`); return; }
    r.scope = makeScope(r);
    state(r, "starting");
    let deadline;
    let detachAbort = () => {};
    // Timers cannot interrupt synchronous JS. This is an async readiness deadline,
    // not a sandbox/watchdog; an infinite synchronous loop needs page recovery.
    const interrupted = new Promise((_, reject) => {
      const abort = () => reject(new Error(`Activation aborted: ${r.id}`));
      r.scope.ctx.signal.addEventListener("abort", abort, { once: true });
      detachAbort = () => r.scope.ctx.signal.removeEventListener("abort", abort);
      if (r.scope.ctx.signal.aborted) abort();
      deadline = globalThis.setTimeout(() => reject(new Error("Async activation exceeded the 5000ms readiness deadline")), 5000);
    });
    const setup = Promise.resolve().then(() => {
      if (r.scope.closed) throw new Error(`Activation aborted: ${r.id}`);
      return r.setup(r.scope.ctx);
    }).then((dispose) => {
      if (typeof dispose === "function") r.scope.ctx.cleanup(dispose);
      else if (dispose != null) throw new TypeError("setup must return a cleanup function or nothing");
    });
    try {
      await Promise.race([setup, interrupted]);
      if (r.scope.closed || r.stopRequested || closed) return;
      const missing = r.provides.find((dep) => !r.values.has(dep.key));
      if (missing) throw new Error(`Declared service was not provided: ${missing.key}`);
      state(r, "active");
    } catch (error) {
      if (!r.stopRequested && !closed) {
        state(r, "failed", message(error));
        report(error, r.id, "setup");
      }
      await r.scope.close();
    } finally {
      globalThis.clearTimeout(deadline);
      detachAbort();
    }
  }
  function start() {
    if (starting) return starting;
    if (closed) return Promise.reject(new Error("Plugin runtime is closed"));
    begun = true;
    // Assign the promise before notifications can cause a reentrant start().
    starting = Promise.resolve().then(async () => {
      if (!closed) {
        plan();
        for (const r of ordered) await activate(r);
      }
      return list();
    });
    return starting;
  }
  function stopRecords(targets) {
    // Invalidate all affected services before awaiting any cleanup.
    let changed = false;
    for (const r of targets) {
      changed ||= r.state !== "stopped";
      r.stopRequested = true; r.state = "stopped"; r.reason = undefined;
    }
    if (changed) emit();
    const order = [...new Set([...ordered, ...records.values()])].reverse().filter((r) => targets.has(r));
    return (async () => {
      for (const r of order) if (r.scope) await r.scope.close();
      return list();
    })();
  }
  function targetsOf(id) {
    const root = records.get(id);
    if (!root) return null;
    const targets = new Set([root]);
    let changed;
    do {
      changed = false;
      for (const r of records.values()) if (!targets.has(r) && r.requires.some((dep) => targets.has(selected.get(dep.key)))) {
        targets.add(r); changed = true;
      }
    } while (changed);
    return { root, targets };
  }
  function stop(id) {
    const found = targetsOf(id);
    return found ? stopRecords(found.targets) : Promise.resolve(list());
  }
  function requestStop(id) {
    const found = targetsOf(id);
    if (!found) return Promise.resolve(list());
    const { root, targets } = found;
    // C6: an active essential reload:"page" plugin (or one that depends on the root) keeps
    // running until the page reloads. Refuse before any teardown or state change.
    const held = [...targets].find((r) => r.essential && r.reload === "page" && r.state === "active");
    if (held) {
      if (!held.reloadPending) { held.reloadPending = true; emit(); }
      return Promise.reject(new Error(held === root
        ? `${held.id} is essential and applies only after the app reloads; it cannot be stopped on this page.`
        : `Stopping ${id} would also stop ${held.id}, which is essential and applies only after the app reloads.`));
    }
    return stopRecords(targets);
  }
  function close() {
    if (closing) return closing;
    closed = true;
    closing = stopRecords(new Set(records.values())).then((result) => { listeners.clear(); return result; });
    return closing;
  }
  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("subscribe expects a function");
    if (closed) return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  // True once a change to an essential reload:"page" plugin was refused: it applies after a reload.
  function reloadPending() {
    return [...records.values()].some((r) => r.reloadPending === true);
  }
  const selection = Object.freeze({ providers: providerList, services: selectable, resolve: resolution, choose, choice: (id, version = 1) => choiceOf(contract(id, version)) });
  return Object.freeze({ register, start, stop, requestStop, close, list, service, contributions, subscribe, diagnose, reloadPending, selection });
}

const CHOICE_PREFIX = "self-forming.provider.";
// Keys that existed before the general selection: never rename.
const CHOICE_KEYS = Object.freeze({ "net.fetch@1": "self-forming.net.route" });
function defaultStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

// Diagnostics are plain JSON (strings, numbers, arrays); never keep consumer objects.
function structuredCopy(value) {
  return JSON.parse(JSON.stringify(value));
}
