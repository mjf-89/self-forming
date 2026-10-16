// Tailscale transport manager for the browser edition: an in-page Tailscale node (Go->WASM,
// vendor/tailscale) that joins the user's tailnet and sends requests out through the user's own
// exit node (Settings -> Network -> "Through my Tailscale exit node").
//  - The 38 MB client loads only when Tailscale mode is used (start()).
//  - Login state is kept in this browser (localStorage), so reloads do not ask to sign in again.
//  - The chosen exit node is remembered; with exactly one online exit node it is chosen automatically.
//  - Sign-in is either the interactive link (loginURL in the status) or, optionally, a pre-authorized
//    auth key (`authKey`, a string or a function returning one). The key is handed to the client only; it is
//    never kept in the status, never persisted by this module and scrubbed from any error text.
//  - stop() releases the node (see below) so that a later start() works again.
const STATE_PREFIX = "self-forming.tailscale.state.";
const EXIT_KEY = "self-forming.tailscale.exit-node";

export function createTailscaleManager({ storage = globalThis.localStorage, hostname = "self-forming-browser", authKey: initialAuthKey, loadClient } = {}) {
  let authKey = typeof initialAuthKey === "function" || (typeof initialAuthKey === "string" && initialAuthKey) ? initialAuthKey : undefined;
  let generation = 0;        // bumped by stop(): callbacks of an older client are ignored
  let client;
  let starting;
  let state = "off";        // off | loading | NoState | NeedsLogin | NeedsMachineAuth | Starting | Running | Stopped | error
  let loginURL;
  let exitNodes = [];
  let error;
  let appliedExit;           // exit node id/ip currently applied to the running client
  const listeners = new Set();

  const read = (key) => { try { return storage?.getItem(key) ?? ""; } catch { return ""; } };
  const write = (key, value) => { try { value ? storage?.setItem(key, value) : storage?.removeItem(key); } catch { /* not persisted */ } };
  const chosenExit = () => read(EXIT_KEY);
  const view = () => ({ state, loginURL, usingAuthKey: Boolean(authKey), exitNodes: exitNodes.map((n) => ({ ...n })), selectedExitNode: chosenExit() || null, appliedExitNode: appliedExit ?? null, error });
  const notify = () => { for (const listener of listeners) { try { listener(view()); } catch { /* UI only */ } } };
  const nodeStorage = {
    getState: (id) => read(STATE_PREFIX + id),
    setState: (id, value) => write(STATE_PREFIX + id, value),
  };

  async function applyExit() {
    if (!client || state !== "Running") return;
    let wanted = chosenExit();
    const online = exitNodes.filter((n) => n.online);
    if (!wanted && online.length === 1) { wanted = online[0].id; write(EXIT_KEY, wanted); }
    if (!wanted || wanted === appliedExit) return;
    try { await client.setExitNode(wanted); appliedExit = wanted; error = undefined; }
    catch (cause) { error = `Could not use that exit node: ${cause?.message ?? cause}`; }
    notify();
  }

  // Error text must never carry the auth key.
  const scrub = (cause, key) => {
    let message = String(cause?.message ?? cause);
    if (key) message = message.split(key).join("[auth key]");
    return message.replace(/tskey-[A-Za-z0-9_-]+/g, "[auth key]");
  };

  function start() {
    if (starting) return starting;
    const mine = ++generation;
    const attempt = (async () => {
      state = "loading"; error = undefined; notify();
      const createTailscaleClient = loadClient ?? (await import("./vendor/tailscale/tailscale-client.js")).createTailscaleClient;
      const key = typeof authKey === "function" ? await authKey() : authKey;
      const options = {
        storage: nodeStorage,
        hostname,
        onLoginURL: (url) => { if (mine === generation) { loginURL = url; notify(); } },
        onStatus: (s) => {
          if (mine !== generation) return;
          state = s.state;
          exitNodes = Array.isArray(s.exitNodes) ? s.exitNodes : [];
          if (state === "Running") { loginURL = undefined; void applyExit(); }
          notify();
        },
      };
      if (typeof key === "string" && key) options.authKey = key;
      let created;
      try { created = await createTailscaleClient(options); }
      catch (cause) { throw Object.assign(new Error(scrub(cause, key)), { code: cause?.code }); }
      if (mine !== generation) { try { await created?.close?.(); } catch { /* ignore */ } throw new Error("Tailscale was stopped while starting"); }
      client = created;
      return client;
    })().catch((cause) => {
      if (mine !== generation) throw cause; // stop() already reset the state (and a newer start may be running)
      starting = undefined;
      state = "error"; error = scrub(cause); notify();
      throw cause;
    });
    starting = attempt;
    return attempt;
  }

  /**
   * Stops the node and releases what it holds (the WASM client, its connections) so that a later start()
   * creates a fresh node. Safe to call at any time, repeatedly, also while start() is still running (that
   * start() then rejects). Note: the client's close() logs the node out of the tailnet, so after stop() the
   * next start() needs the auth key or a new sign-in link; the locally stored node state is cleared.
   * The status goes back to "off". Listeners stay subscribed.
   */
  async function stop() {
    const pending = starting, current = client;
    generation++;                                   // ignore anything the old client still reports
    client = undefined; starting = undefined;
    state = "off"; loginURL = undefined; exitNodes = []; error = undefined; appliedExit = undefined;
    if (pending && !current) { try { await pending; } catch { /* the aborted start rejects; nothing to release */ } }
    try { await current?.close?.(); } catch { /* already closed */ }
    try { for (const key of Object.keys(storage ?? {})) if (key.startsWith(STATE_PREFIX)) storage.removeItem(key); } catch { /* ignore */ }
    notify();
  }

  return {
    start,
    stop,
    /** stop() and drop every status listener; the manager can still be started again. */
    async dispose() { await stop(); listeners.clear(); },
    /** Sets (or with a falsy value removes) the auth key used by the NEXT start(). Never read back. */
    setAuthKey(key) { authKey = typeof key === "function" || (typeof key === "string" && key) ? key : undefined; notify(); },
    getStatus: view,
    subscribe(listener) { listeners.add(listener); listener(view()); return () => listeners.delete(listener); },
    /** The client when it can carry traffic right now (signed in, exit node applied), else undefined. */
    readyClient: () => (client && state === "Running" && appliedExit ? client : undefined),
    /** Resolves with a client ready to carry internet traffic, or fails with what the user must do. */
    async getClient() {
      await start();
      if (state === "NeedsLogin" || state === "NeedsMachineAuth") {
        throw Object.assign(new Error("Sign in to Tailscale in Settings → Network first."), { code: "TAILSCALE_LOGIN" });
      }
      if (state !== "Running") await client.whenRunning(60000);
      await applyExit();
      if (!appliedExit) {
        throw Object.assign(new Error(exitNodes.some((n) => n.online)
          ? "Choose a Tailscale exit node in Settings → Network."
          : "No Tailscale exit node is online in your tailnet (or your access rules don't allow this device to use one)."), { code: "TAILSCALE_EXIT_NODE" });
      }
      return client;
    },
    async setExitNode(id) {
      write(EXIT_KEY, id || "");
      appliedExit = undefined;
      if (!id) { try { await client?.clearExitNode(); } catch { /* ignore */ } notify(); return; }
      await applyExit();
    },
    login() { client?.login(); },
    async logout() {
      try { client?.logout(); } catch { /* ignore */ }
      appliedExit = undefined; loginURL = undefined;
      try { for (const key of Object.keys(storage ?? {})) if (key.startsWith(STATE_PREFIX)) storage.removeItem(key); } catch { /* ignore */ }
      notify();
      // Ask for a fresh login link so the user can sign in again (or with another account).
      setTimeout(() => { try { client?.login(); } catch { /* ignore */ } }, 1000);
    },
  };
}
