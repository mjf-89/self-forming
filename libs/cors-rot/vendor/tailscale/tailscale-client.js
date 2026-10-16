// Tailscale in-page client glue.
//
// Wraps the Go->WASM Tailscale client (forked from tailscale.com/cmd/tsconnect/wasm)
// and exposes the same stream transport API used by the browser app's HTTP/1.1
// layer (see ../../http-stream.js): connect()/connectTls() return
// a stream with async write(Uint8Array), async read()->Uint8Array|undefined (EOF),
// and async close() (idempotent). Non-tailnet traffic is routed through the
// user's selected Tailscale exit node (CORS workaround transport "tailscale").
//
// Upstream: github.com/tailscale/tailscale cmd/tsconnect (BSD-3-Clause).
// See PROVENANCE.md for commit, patch and build details.

const WASM_URL = new URL('./tailscale.wasm', import.meta.url);
const EXEC_URL = new URL('./wasm_exec.js', import.meta.url);

let runtimePromise = null;

// loadRuntime instantiates the Go runtime + wasm module exactly once and
// resolves with the global newIPN(config) factory the wasm installs.
function loadRuntime() {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    if (typeof globalThis.Go !== 'function') {
      // wasm_exec.js is Go's non-module loader; it assigns globalThis.Go.
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = EXEC_URL.href;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load wasm_exec.js'));
        document.head.appendChild(s);
      });
    }
    const go = new globalThis.Go();
    let instance;
    try {
      const result = await WebAssembly.instantiateStreaming(fetch(WASM_URL), go.importObject);
      instance = result.instance;
    } catch (streamErr) {
      // Fallback for servers that don't send application/wasm.
      const bytes = await (await fetch(WASM_URL)).arrayBuffer();
      const result = await WebAssembly.instantiate(bytes, go.importObject);
      instance = result.instance;
    }
    // go.run resolves only when the Go program exits; the wasm blocks forever
    // keeping the runtime alive, so we must NOT await it.
    go.run(instance).catch((e) => { console.error('tailscale wasm exited:', e); });
    // Wait for the wasm main() to install newIPN on the global scope.
    for (let i = 0; i < 4000 && typeof globalThis.newIPN !== 'function'; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (typeof globalThis.newIPN !== 'function') {
      throw new Error('Tailscale wasm did not install newIPN');
    }
    return globalThis.newIPN;
  })();
  return runtimePromise;
}

// wrapStorage adapts a provided storage into the {getState, setState} shape the
// wasm expects (hex-encoded string values). Accepts:
//   - an object with getState(id)->string / setState(id, value)
//   - a Web Storage-like object with getItem/setItem
//   - undefined (in-memory, non-persistent)
function wrapStorage(storage) {
  if (storage && typeof storage.getState === 'function' && typeof storage.setState === 'function') {
    return storage;
  }
  if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') {
    return {
      getState: (id) => storage.getItem('ts-' + id) || '',
      setState: (id, value) => { storage.setItem('ts-' + id, value); },
    };
  }
  const mem = new Map();
  return {
    getState: (id) => mem.get(id) || '',
    setState: (id, value) => { mem.set(id, value); },
  };
}

// Deferred promise helper.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * createTailscaleClient creates and starts an in-page Tailscale node.
 *
 * Options:
 *   authKey?    - ephemeral reusable auth key (tskey-auth-...). If absent, an
 *                 interactive login URL is delivered via onLoginURL.
 *   controlURL? - control plane URL (defaults to login.tailscale.com).
 *   hostname?   - node hostname (defaults to a random words-based name).
 *   storage     - persistence for IPN state (see wrapStorage).
 *   onLoginURL(url) - called with the interactive login URL when needed.
 *   onStatus({state, netMap, exitNodes}) - called on state/netmap changes.
 *
 * Returns an object exposing:
 *   state                        - last known IPN state string.
 *   whenRunning()                - Promise resolving when state === 'Running'.
 *   exitNodes()                  - array of {id, name, ip, online}.
 *   setExitNode(idOrIP)          - Promise; selects an exit node.
 *   clearExitNode()              - Promise; clears the exit node.
 *   connect(host, port, timeoutMs)    - Promise<stream> (plain TCP).
 *   connectTls(host, port, timeoutMs) - Promise<stream> (TLS 1.2+, http/1.1).
 *   login() / logout()           - interactive login control.
 *   close()                      - stops the node (logout).
 */
export async function createTailscaleClient({
  authKey,
  controlURL,
  hostname,
  storage,
  onLoginURL,
  onStatus,
} = {}) {
  const newIPN = await loadRuntime();

  const config = { stateStorage: wrapStorage(storage) };
  if (typeof authKey === 'string' && authKey) config.authKey = authKey;
  if (typeof controlURL === 'string' && controlURL) config.controlURL = controlURL;
  if (typeof hostname === 'string' && hostname) config.hostname = hostname;

  const ipn = newIPN(config);

  let state = 'NoState';
  let netMap = null;
  const running = deferred();
  let settled = false;

  const emit = () => {
    try { onStatus?.({ state, netMap, exitNodes: safeExitNodes() }); }
    catch { /* status observers cannot break the client */ }
  };
  const safeExitNodes = () => {
    try { return ipn.exitNodes(); } catch { return []; }
  };

  // When no auth key is supplied, reaching NeedsLogin means we must kick off
  // interactive login to make the control client produce a login URL
  // (StartLoginInteractive). Guarded so we only do it once.
  let interactiveLoginStarted = false;

  ipn.run({
    notifyState(s) {
      state = s;
      if (s === 'Running' && !settled) { settled = true; running.resolve(); }
      if (s === 'NeedsLogin' && !config.authKey && !interactiveLoginStarted) {
        interactiveLoginStarted = true;
        try { ipn.login(); } catch { /* ignore */ }
      }
      emit();
    },
    notifyNetMap(json) {
      try { netMap = JSON.parse(json); } catch { /* ignore malformed */ }
      emit();
    },
    notifyBrowseToURL(url) {
      try { onLoginURL?.(url); } catch { /* ignore */ }
    },
    notifyPanicRecover(err) {
      console.error('Tailscale wasm panic recovered:', err);
    },
  });

  return {
    get state() { return state; },
    get netMap() { return netMap; },
    whenRunning: (timeoutMs = 120000) => {
      if (state === 'Running') return Promise.resolve();
      return Promise.race([
        running.promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out waiting for Tailscale to reach Running')), timeoutMs)),
      ]);
    },
    exitNodes: () => safeExitNodes(),
    exitNodeDiag: () => { try { return ipn.exitNodeDiag(); } catch { return null; } },
    setExitNode: (idOrIP) => Promise.resolve(ipn.setExitNode(String(idOrIP))),
    clearExitNode: () => Promise.resolve(ipn.clearExitNode()),
    connect: (host, port, timeoutMs) => Promise.resolve(ipn.dial(String(host), port, timeoutMs)),
    connectTls: (host, port, timeoutMs) => Promise.resolve(ipn.dialTLS(String(host), port, timeoutMs)),
    login: () => { try { ipn.login(); } catch { /* ignore */ } },
    logout: () => { try { ipn.logout(); } catch { /* ignore */ } },
    close: () => { try { ipn.logout(); } catch { /* ignore */ } },
  };
}

export default createTailscaleClient;
