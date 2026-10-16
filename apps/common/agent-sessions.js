// apps/common/agent-sessions.js
// Page-owned session lifecycle and the agent.sessions@1 facade (docs/plugins-providers-agent-core.md
// §B2, step C1). Moved verbatim from app.js start(): the foreground state (bridge event
// host.lifecycle), the transition chain (reconcile: close on background through
// createSessionCloser, open on foreground), the agent.stopped handler and host.keepAlive.
// The page keeps one controller for its lifetime; sessions (openAppSession) come and go.
//
// Activation chain (AGENTS.md "How activation works") is unchanged: app-revisions'
// closeSession calls closeForReload(current), which saves the draft and closes the session
// on the same transition chain as a background close; app.activate and reload stay in
// app-revisions.js. reloadNow() is the same save-close-reload without an app revision.
//
// This module never calls session.close() itself except for a session that opened after
// the page went to the background (exactly as before); every other close goes through the
// closer, so draft saving and assertCanOpen() keep their semantics.
//
// Step C2: the controller also owns the page's agent.harness@1 facade (controller.harness).
// Sessions report their harness handle through controller.onHarness(handle | null): after
// Harness.open, and null before the Harness closes (session.js). session.js takes the
// callback from its options.onHarness (the open request carries it), else from the page
// controller registered with setPageAgentSessions, so app.js needs no change for it.
//
// Step C3d: core-agent opens the sessions. The page gives its session options through
// connect({sessionOptions}); core-agent's setup (plugins/core-agent/web) calls
// begin(open, "core-agent") with its opener, or app.js calls the bundled core-agent copy's
// begin(open, "bundled") when composition is unavailable. Only the first begin starts the
// lifecycle (startedBy tells which); later calls change nothing.
import { AGENT_HARNESS_V1, AGENT_SESSIONS_V1, SESSION_NOT_OPEN_MESSAGE } from "./agent-contracts.js";

let pageSessions;
let pageHarness;
let pageHarnessSink;
let pageFailureSink;
let pageController;

/** The page's agent.sessions@1 facade (set by app.js), or undefined (tests, forks). */
export function pageAgentSessions() {
  return pageSessions;
}
/** The page's agent.harness@1 facade (the registered controller's), or undefined. */
export function pageAgentHarness() {
  return pageHarness;
}
/** session.js: where a session without options.onHarness reports its handle, or undefined. */
export function pageHarnessListener() {
  return pageHarnessSink;
}
/** session.js: where a session without options.onFailed reports that its Harness failed (storage error), or undefined. */
export function pageSessionFailureListener() {
  return pageFailureSink;
}
/** The registered page controller when it can begin (core-agent opens its sessions), or undefined. */
export function pageAgentLifecycle() {
  return pageController;
}
/** Registers the page's controller; plugin-builtins provides its facades as agent.sessions@1 and agent.harness@1. */
export function setPageAgentSessions(controller) {
  pageSessions = controller?.facade ?? controller;
  pageHarness = controller?.harness;
  pageHarnessSink = typeof controller?.onHarness === "function" ? controller.onHarness : void 0;
  pageFailureSink = typeof controller?.sessionFailed === "function" ? controller.sessionFailed : void 0;
  pageController = typeof controller?.begin === "function" ? controller : void 0;
  return pageSessions;
}

/**
 * open({wanted}) -> session | undefined. Opens the execution env and calls openAppSession;
 *   when wanted() turned false while opening it may close the session itself and resolve
 *   undefined (otherwise this module closes it, as before). Optional: begin(open, by) gives
 *   it later (core-agent, step C3d).
 * closer: createSessionCloser(saveDraft) from app-revisions.js (draft saved, then close;
 *   assertCanOpen() refuses to open after a failed close).
 * bridge, hostInfo: may also be given later through connect()/start(); hostInfo may be a
 *   function (read lazily).
 * blocked(): true while the page is reloading (app update activating or reloadNow); no
 *   session opens meanwhile (app.js appReloading).
 * reloadRefusal(): a reason string while reloadNow() must not run (app update queued, sign-in
 *   in progress, a UI operation), else undefined.
 * onReloading(value): reloadNow() started (true) or failed and the page stays (false).
 * onOpenError(cause): opening failed while in the foreground.
 * onStopped(session): agent.stopped stopped the current session's reply.
 * reportError(cause): background close failed, a listener threw, a stop failed.
 * reload(): defaults to location.reload().
 */
export function createAgentSessions(options = {}) {
  const { closer } = options;
  let open = options.open;
  if (open !== void 0 && typeof open !== "function") throw new TypeError("createAgentSessions needs open()");
  if (typeof closer?.close !== "function" || typeof closer?.assertCanOpen !== "function") throw new TypeError("createAgentSessions needs a session closer (createSessionCloser)");
  const report = (cause) => { try { options.reportError?.(cause); } catch { /* reporting never breaks the lifecycle */ } };
  const blocked = () => Boolean(options.blocked?.());
  let bridge;
  let hostInfo = options.hostInfo;
  let current;
  let foreground = true;
  let lifecycleSeen = false;
  let hostApplied = false;
  let started = false;
  let reloadingNow = false;
  let keepAliveSent = false;
  let startedBy;
  let sessionOptions;
  let markBegun;
  const begun = new Promise((resolve) => { markBegun = resolve; });
  let transition = Promise.resolve();
  let sessionSubscription;
  const sessionListeners = new Set();
  const snapshotListeners = new Set();
  const harnessListeners = new Set();
  let harnessHandle = null;
  const info = () => typeof hostInfo === "function" ? hostInfo() : hostInfo;

  function emitSession(value, details) {
    for (const listener of [...sessionListeners]) {
      try { listener(value, details); } catch (cause) { report(cause); }
    }
  }
  function emitHarness(value, details) {
    for (const listener of [...harnessListeners]) {
      try { listener(value, details); } catch (cause) { report(cause); }
    }
  }
  /**
   * A session's agent.harness@1 handle after Harness.open, or null (details.previous: the
   * handle that ends) before its Harness closes. A late null for an older handle never
   * clears a newer one.
   */
  function onHarness(handle, details = {}) {
    if (handle) {
      if (handle === harnessHandle) return;
      harnessHandle = handle;
      emitHarness(handle, { reason: "open" });
      return;
    }
    if (!harnessHandle || (details?.previous && details.previous !== harnessHandle)) return;
    const previous = harnessHandle;
    harnessHandle = null;
    emitHarness(null, { previous, reason: "close" });
  }
  function emitSnapshot(snapshot) {
    for (const listener of [...snapshotListeners]) {
      try { listener(snapshot); } catch (cause) { report(cause); }
    }
  }
  // host.keepAlive while any conversation works (was in app.js render()).
  function keepAlive(snapshot) {
    const anyRunning = Boolean(snapshot.anyBusy);
    if (anyRunning !== keepAliveSent && info()?.capabilities?.backgroundReplies) {
      keepAliveSent = anyRunning;
      void bridge?.call("host.keepAlive", { busy: anyRunning }).catch(() => {
      });
    }
  }
  function detach() {
    const unsubscribe = sessionSubscription;
    sessionSubscription = void 0;
    try { unsubscribe?.(); } catch (cause) { report(cause); }
  }
  function attach(opened) {
    current = opened;
    emitSession(opened, { reason: "open" });
    if (current !== opened) return;
    sessionSubscription = opened.subscribe((snapshot) => {
      if (current !== opened) return;
      keepAlive(snapshot);
      emitSnapshot(snapshot);
      if (reopenWanted && idle(snapshot)) void tryReopen();
    });
    if (reopenWanted) void tryReopen();
  }

  // Reopen in place (E1: the selected execution@1 provider changed). The session's
  // environment, tools and prompt are bound when it opens; to switch them, the page session
  // closes on the SAME save-draft-close path as an app update (unfinished durable work such
  // as subagent and server tasks is kept and resumes) and opens again, without reloading the
  // page. It waits until no conversation is working, so no reply or command is cut off.
  let reopenWanted = null;
  let reopening = false;
  const idle = (snapshot) => !snapshot?.busy && !snapshot?.anyBusy;
  async function tryReopen() {
    if (!reopenWanted || reopening || !started || reloadingNow || blocked() || !foreground) return false;
    const previous = current;
    if (!previous) { reopenWanted = null; return false; }   // nothing open: the next open uses the new choice
    if (!idle(previous.snapshot)) return false;            // retried from the session's snapshots
    const reason = reopenWanted;
    reopenWanted = null;
    reopening = true;
    try {
      current = void 0;
      detach();
      emitSession(null, { previous, reason });
      const closing = closer.close(previous, transition);
      transition = closing.settled;
      try { await closing.result; } catch (cause) { report(cause); }
    } finally { reopening = false; }
    await reconcile();
    return true;
  }
  /**
   * Asks for the page session to close and open again in place (no page reload) as soon as
   * no conversation is working. reason (e.g. "execution") is passed to onSession listeners.
   * Returns a promise that settles after the attempt (true: reopened now, false: deferred or
   * nothing open). Repeated requests before the reopen collapse into one.
   */
  function reopenWhenIdle(reason = "reopen") {
    reopenWanted = reason;
    return transition.then(() => tryReopen());
  }

  function reconcile() {
    if (!started) return;
    if (!foreground && current) {
      const previous = current;
      current = void 0;
      detach();
      emitSession(null, { previous, reason: "background" });
      const closing = closer.close(previous, transition);
      transition = closing.settled;
      void closing.result.catch(report);
    }
    transition = transition.then(async () => {
      if (!foreground || current || blocked() || reloadingNow) return;
      closer.assertCanOpen();
      // Any fresh open resolves the current choices (execution@1 included); a reopen request
      // made before this point is satisfied by it. One made while opening re-arms it.
      reopenWanted = null;
      const opened = await open({ wanted: () => foreground, onHarness });
      if (!opened) return;
      if (!foreground) {
        await opened.close();
        return;
      }
      attach(opened);
    }).catch((cause) => {
      if (foreground) {
        try { options.onOpenError?.(cause); } catch (error) { report(error); }
      }
    });
    return transition;
  }

  // host.info known: the host's foreground state applies once, unless a lifecycle event
  // already arrived (was app.js `if (!lifecycleSeen) foreground = …`).
  function applyHost() {
    if (hostApplied) return;
    hostApplied = true;
    if (!lifecycleSeen) foreground = info()?.foreground !== false;
  }
  /** bridge: subscribes host.lifecycle/agent.stopped (once). hostInfo key present: host known. */
  function connect(update = {}) {
    if (update.sessionOptions) sessionOptions = update.sessionOptions;
    if ("hostInfo" in update) {
      hostInfo = update.hostInfo;
      applyHost();
    }
    const nextBridge = update.bridge;
    if (!nextBridge || bridge) return;
    bridge = nextBridge;
    bridge.subscribe((event) => {
      if (event.event !== "host.lifecycle") return;
      lifecycleSeen = true;
      foreground = event.foreground;
      reconcile();
    });
    bridge.subscribe((event) => {
      if (event.event !== "agent.stopped") return;
      const previous = current;
      if (!previous?.snapshot.busy) return;
      void previous.stop().then(() => {
        if (current === previous) options.onStopped?.(previous);
      }).catch((cause) => {
        if (current === previous) report(cause);
      });
    });
  }

  /** Host known: applies its initial foreground state (unless an event already did) and opens. */
  function start(update = {}) {
    if (typeof open !== "function") throw new TypeError("createAgentSessions needs open()");
    if ("hostInfo" in update) hostInfo = update.hostInfo;
    applyHost();
    started = true;
    startedBy ??= "page";
    reconcile();
    markBegun(transition);
    return transition;
  }

  /**
   * core-agent (step C3d): the first caller's opener starts the lifecycle (by: "core-agent"
   * or "bundled"); returns false and changes nothing once started.
   */
  function begin(opener, by) {
    if (typeof opener !== "function") throw new TypeError("begin needs open()");
    if (started) return false;
    open = opener;
    startedBy = by;
    start();
    return true;
  }

  // pi-durable 1.2+ (README "Errors", rule 1; CHANGELOG 1.2.0 "Breaking Changes"): a storage error ends
  // the Harness, which closes itself; every later call rejects with SessionFailed. "Reopen to recover:
  // commits are atomic, so the store is consistent." The failed session is closed on the transition
  // chain (draft saving may fail; that is reported) and a fresh one opens, at most 3 times a minute.
  const failures = [];
  function sessionFailed(session, cause) {
    report(cause);
    if (!session || current !== session || reloadingNow) return;
    const now = Date.now();
    while (failures.length && now - failures[0] > 60e3) failures.shift();
    failures.push(now);
    if (failures.length > 3) {
      report(new Error("The conversation storage keeps failing; not reopening again automatically."));
      return;
    }
    const previous = current;
    current = void 0;
    detach();
    emitSession(null, { previous, reason: "failed" });
    const closing = closer.close(previous, transition);
    transition = closing.settled;
    void closing.result.catch(report);
    void reconcile();
  }

  /** app-revisions closeSession: draft saved, session closed on the transition chain. */
  async function closeForReload(expected) {
    if (current !== expected) throw new Error("The conversation changed before the app update.");
    current = void 0;
    detach();
    emitSession(null, { previous: expected, reason: "reload" });
    const closing = closer.close(expected, transition);
    transition = closing.settled;
    await closing.result;
  }

  /** Save-close-reload for core replacements (§F.3), the same path as app updates. */
  async function reloadNow() {
    if (reloadingNow || blocked()) throw new Error("The app is already reloading.");
    if (!started || !foreground) throw new Error("Return to the app before reloading it.");
    const refusal = options.reloadRefusal?.();
    if (refusal) throw new Error(refusal);
    reloadingNow = true;
    try { options.onReloading?.(true); } catch (cause) { report(cause); }
    try {
      // An open or close in flight settles first; nothing new opens while reloading.
      await transition;
      if (!foreground) throw new Error("The app went to the background. Reload again when you return.");
      const late = options.reloadRefusal?.();
      if (late) throw new Error(late);
      if (current) await closeForReload(current);
      (options.reload ?? (() => globalThis.location.reload()))();
    } catch (cause) {
      reloadingNow = false;
      try { options.onReloading?.(false); } catch (error) { report(error); }
      reconcile();
      throw cause;
    }
  }

  function need() {
    if (!current) throw new Error(SESSION_NOT_OPEN_MESSAGE);
    return current;
  }
  const forwarded = Object.fromEntries(AGENT_SESSIONS_V1.methods.filter((name) => name !== "subscribe").map((name) => [name, (...args) => need()[name](...args)]));
  // agent.sessions@1 as provided by core-agent: the contract members, nothing else.
  const facade = Object.freeze({
    current: () => current ?? null,
    onSession(listener) {
      if (typeof listener !== "function") throw new TypeError("onSession needs a listener");
      sessionListeners.add(listener);
      return () => { sessionListeners.delete(listener); };
    },
    /** Follows the current session across reopen; called at once with an open session's snapshot. */
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("subscribe needs a listener");
      snapshotListeners.add(listener);
      if (current) listener(current.snapshot);
      return () => { snapshotListeners.delete(listener); };
    },
    /** The open session's snapshot, or undefined while none is open. */
    get snapshot() {
      return current?.snapshot;
    },
    /** false while the app is in the background (C7: the chat locks its controls). */
    get foreground() {
      return foreground;
    },
    ...forwarded
  });

  function needHarness() {
    if (!harnessHandle) throw new Error(SESSION_NOT_OPEN_MESSAGE);
    return harnessHandle;
  }
  const H = AGENT_HARNESS_V1;
  const harnessGroup = (group, members) => Object.freeze(Object.fromEntries(members.map((name) => [name, (...args) => needHarness()[group][name](...args)])));
  // agent.harness@1 as provided by core-agent: current()/onSession() plus the handle's
  // members, forwarded at call time to the current session's handle (so they follow the
  // session across reopen); they throw the not-open message while no handle exists.
  // onSession listeners persist across reopen and are not called for an already open
  // handle: read current() after subscribing. Values are getters for the same reason.
  const harnessFacade = {
    current: () => harnessHandle,
    onSession(listener) {
      if (typeof listener !== "function") throw new TypeError("onSession needs a listener");
      harnessListeners.add(listener);
      return () => { harnessListeners.delete(listener); };
    }
  };
  for (const name of H.values) Object.defineProperty(harnessFacade, name, { enumerable: true, get: () => needHarness()[name] });
  for (const name of H.methods) harnessFacade[name] = (...args) => needHarness()[name](...args);
  for (const name of H.hooks ?? []) harnessFacade[name] = (...args) => needHarness()[name](...args);
  harnessFacade.storage = harnessGroup("storage", H.storage);
  for (const group of ["models", "tools", "prompt"]) harnessFacade[group] = harnessGroup(group, Object.keys(H[group]));
  Object.freeze(harnessFacade);

  const controller = Object.freeze({
    facade,
    harness: harnessFacade,
    onHarness,
    sessionFailed,
    current: facade.current,
    onSession: facade.onSession,
    subscribe: facade.subscribe,
    get snapshot() {
      return current?.snapshot;
    },
    get foreground() {
      return foreground;
    },
    get reloading() {
      return reloadingNow;
    },
    /** Who began the lifecycle: "core-agent", "bundled", "page" (start()), or undefined. */
    get startedBy() {
      return startedBy;
    },
    /** The page's options for opening sessions (connect({sessionOptions})), read by core-agent. */
    get sessionOptions() {
      return sessionOptions;
    },
    /** Resolves once the lifecycle began, after the first open attempt settled. */
    begun,
    begin,
    connect,
    start,
    reconcile,
    closeForReload,
    reloadNow,
    reopenWhenIdle,
    /** A reopen is waiting for the conversations to become idle. */
    get reopenPending() {
      return reopenWanted !== null;
    }
  });
  connect({ bridge: options.bridge, ...("hostInfo" in options ? { hostInfo: options.hostInfo } : {}) });
  return controller;
}
