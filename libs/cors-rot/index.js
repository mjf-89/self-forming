// cors-rot — the browser networking stack of Self Forming, as a source-only library.
// Experimental and unaudited. See ./README.md for what it is, how it works, and its security notes.
//
// Two transports only: 'tailscale' (default; the user's own exit node) and 'tor' (Tor over
// Snowflake). While 'tor' is selected, a Snowflake proxy runs to give back to the network.
//
//   import { createCorsRot } from './cors-rot/index.js';
//   const net = createCorsRot({ transport: 'tailscale' });
//   const response = await net.fetch('https://example.org/');   // standard streaming Response
//
// All vendored WASM/assets are resolved relative to import.meta.url, so this folder can be copied
// anywhere and served as static files (serve .wasm as application/wasm).
import { createBrowserNetwork, createTorClientOptions } from './network.js';
import { createTailscaleManager } from './tailscale.js';
import { createSnowflakeProxy } from './snowflake.js';

// Lower-level building blocks, re-exported for advanced callers and tests.
export { createBrowserNetwork, createTorClientOptions } from './network.js';
export { createConnectionPool, poolKey, requestHttp, validateHeaders, validateHttpUrl } from './http-stream.js';
export { createTailscaleManager } from './tailscale.js';
export { createSnowflakeProxy } from './snowflake.js';
export { loadTorDirectory, saveTorDirectory } from './tor-cache.js';
export { createGitHttp } from './git-http.js';

/**
 * createCorsRot(options) -> a bundled networking stack.
 *
 * options:
 *   transport   'tailscale' (default) | 'tor'
 *   tailscale   { storage, hostname, authKey } forwarded to the Tailscale manager. authKey (optional) is a
 *               pre-authorized key (string, or a function returning one / a promise of one); without it the
 *               node asks for the interactive sign-in link (status.loginURL). Never logged or exposed.
 *   tor         { ... }                       forwarded to the network (timeoutMs, maxRedirects, ...)
 *   onStatus    (snapshot) => void            network status observer
 *   timeoutMs   per setup stage; in an HTTP exchange, the longest time without data (default 120000)
 *   nativeFetch fetch used for same-origin and WASM asset loading (default globalThis.fetch)
 *   keepAlive   false to disable connection pooling
 *   document    DOM document for the Snowflake frame (default globalThis.document)
 *
 * Returns:
 *   fetch(input, init)          standard streaming Response through the selected transport
 *   fetchTor(input, init)       explicit Tor, regardless of the selected transport
 *   connect(host, port, {tls})  raw stream through the selected transport
 *   preconnect(url)             warm a connection into the keep-alive pool
 *   warmUp()                    start the selected transport in the background (a failing start is
 *                               reported in getStatus().tailscaleStartError / torState, never unhandled)
 *   setTransport(name)          'tailscale' | 'tor'
 *   getStatus()                 status snapshot (includes `transport`)
 *   subscribe(cb)               status subscription; returns an unsubscribe function
 *   tailscale                   { start, stop, dispose, setAuthKey, getStatus, subscribe, setExitNode, login, logout }
 *   tor                         { stop }  releases the Tor client; the next Tor use bootstraps a new one
 *   snowflakeProxy              { getStatus, subscribe, stop, dispose }
 *   stop()                      stops the Tor client, the Tailscale node and the Snowflake proxy frame
 *   dispose()                   stop() + drop all listeners/pools; create a new instance afterwards
 *   network                     the lower-level network object (fetchTor, getMode, ...)
 */
export function createCorsRot({
  transport = 'tailscale',
  tailscale = {},
  tor = {},
  onStatus,
  timeoutMs,
  nativeFetch,
  keepAlive,
  document = globalThis.document,
} = {}) {
  const ts = createTailscaleManager(tailscale);
  const network = createBrowserNetwork({
    mode: transport,
    tailscale: ts,
    onStatus,
    nativeFetch,
    ...(keepAlive === undefined ? {} : { keepAlive }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...tor,
  });
  const snowflakeProxy = createSnowflakeProxy({ network, document });

  const stopProxy = () => snowflakeProxy.stop();
  return {
    fetch: (input, init) => network.fetch(input, init),
    fetchTor: (input, init) => network.fetchTor(input, init),
    connect: (host, port, options) => network.connect(host, port, options),
    preconnect: (url) => network.preconnect(url),
    warmUp: () => network.warmUp(),
    setTransport: (name) => network.setMode(name),
    getStatus: () => network.getStatus(),
    subscribe: (cb) => network.subscribe(cb),
    stop: async () => { await Promise.all([network.stopTor(), ts.stop()]); stopProxy(); },
    dispose: async () => { snowflakeProxy.dispose(); await Promise.all([network.dispose(), ts.dispose()]); },
    tor: { stop: () => network.stopTor() },
    tailscale: {
      start: () => ts.start(),
      stop: () => ts.stop(),
      dispose: () => ts.dispose(),
      setAuthKey: (key) => ts.setAuthKey(key),
      getStatus: () => ts.getStatus(),
      subscribe: (cb) => ts.subscribe(cb),
      setExitNode: (id) => ts.setExitNode(id),
      login: () => ts.login(),
      logout: () => ts.logout(),
    },
    snowflakeProxy,
    network,
  };
}
