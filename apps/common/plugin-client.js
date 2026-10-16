// Immutable installed ESM only. This is a transport/composition adapter, not an
// authorization layer; imports and trusted plugin code may have arbitrary effects.
const ID = /^[a-z][a-z0-9-]{1,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const CREDENTIAL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LOADABLE = new Set(["installed", "active"]);
const EVENT = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const MAX_EVENT_MESSAGE = 1024 * 1024;

function entryPath(entry) {
  if (typeof entry !== "string" || !entry.startsWith("web/") || entry.includes("\\") || /[%?#\u0000-\u0020\u007f]/.test(entry)) {
    throw new Error("Plugin web.entry must be a canonical relative path beneath web/");
  }
  const parts = entry.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Invalid plugin web.entry path");
  return parts.map(encodeURIComponent).join("/");
}

export function pluginEntryUrl(plugin, base = "/assets/web/plugins/") {
  if (typeof plugin?.id !== "string" || !ID.test(plugin.id) || typeof plugin.hash !== "string" || !HASH.test(plugin.hash)) throw new Error("Invalid installed plugin id or SHA256 revision hash");
  return `${base}${plugin.id}/${plugin.hash}/${entryPath(plugin.web?.entry)}`;
}

function unavailable(error) {
  return error?.code === "METHOD_NOT_FOUND" || error?.error?.code === "METHOD_NOT_FOUND";
}
function validateMetadata(plugin) {
  if (typeof plugin?.id !== "string" || !ID.test(plugin.id) || typeof plugin.hash !== "string" || !HASH.test(plugin.hash)) throw new Error("Invalid installed plugin id or SHA256 revision hash");
  if (plugin.api !== undefined && plugin.api !== 1) throw new Error(`Unsupported plugin API ${plugin.api}; this host supports API 1`);
  if (typeof plugin.version !== "string" || !plugin.version) throw new Error("Installed plugin is missing its version");
  if (!plugin.web && !plugin.native) throw new Error("Plugin needs a web or native facet");
  if (!["scope", "page", "restart"].includes(plugin.reload)) throw new Error("Invalid plugin reload policy");
}

// ---- Native → page plugin events (host capability pluginEvents, APK 0.6.0+) ----
// A second WebMessage listener object, PiPlugins (main frame + app origin only), carries plugin
// events so the fixed PiNative validator never sees them (PluginEvents.kt documents the wire).
// The page announces which plugins it listens to; the host delivers only to the current page
// and drops (counts) everything else. Best effort: no replay, no buffering for later pages.
const channels = new WeakMap();

function pageToken() {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(bytes) : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * createPluginEventChannel({port, onError}) → {page, on(id, hash, event, callback) → off, stats()}
 * or null without a usable port. One channel per port and page; loadInstalledPlugins uses it
 * for ctx.native.on. callback(data, {event, seq, dropped}); `dropped` is the host's running
 * count of undelivered events (a gap detector, not a per-plugin number).
 */
export function createPluginEventChannel({ port, onError = () => {} } = {}) {
  if (!port || typeof port.postMessage !== "function") return null;
  if (channels.has(port)) return channels.get(port);
  const page = pageToken();
  const subscribers = new Map(); // plugin id -> Set<{hash, event, callback}>
  let announced = "", dropped = 0, delivered = 0;
  const report = (error, details) => { try { onError(error, details); } catch { /* reporting must not break delivery */ } };
  function receive(message) {
    const raw = message?.data;
    if (typeof raw !== "string" || raw.length > MAX_EVENT_MESSAGE) return;
    let value;
    try { value = JSON.parse(raw); } catch { return; }
    if (!value || typeof value !== "object" || value.page !== page) return; // another document's traffic
    if (Number.isSafeInteger(value.dropped)) dropped = value.dropped;
    if (value.type !== "event" || typeof value.plugin !== "string" || typeof value.event !== "string") return;
    const entries = subscribers.get(value.plugin);
    if (!entries) return;
    const info = Object.freeze({ event: value.event, seq: value.seq, dropped });
    for (const entry of [...entries]) {
      if (entry.hash !== value.hash || entry.event !== value.event || !entries.has(entry)) continue;
      delivered++;
      try { entry.callback(value.data, info); }
      catch (error) { report(error, { id: value.plugin, phase: "event" }); }
    }
  }
  function announce() {
    const plugins = [...subscribers.keys()].sort();
    const signature = plugins.join(",");
    if (signature === announced) return;
    announced = signature;
    try { port.postMessage(JSON.stringify({ type: "listen", page, plugins })); }
    catch (error) { report(error, { phase: "events" }); }
  }
  if (typeof port.addEventListener === "function") port.addEventListener("message", receive);
  else {
    const previous = port.onmessage;
    port.onmessage = (message) => { receive(message); if (typeof previous === "function") previous.call(port, message); };
  }
  function on(id, hash, event, callback) {
    if (!ID.test(id) || !HASH.test(hash)) throw new TypeError("Invalid plugin id or revision hash");
    if (typeof event !== "string" || !EVENT.test(event)) throw new TypeError("Plugin event names match [A-Za-z][A-Za-z0-9._:-]{0,63}");
    if (typeof callback !== "function") throw new TypeError("native.on requires a callback function");
    const entry = { hash, event, callback };
    if (!subscribers.has(id)) subscribers.set(id, new Set());
    subscribers.get(id).add(entry);
    announce();
    let active = true;
    return function off() {
      if (!active) return;
      active = false;
      const entries = subscribers.get(id);
      entries?.delete(entry);
      if (entries && !entries.size) subscribers.delete(id);
      announce();
    };
  }
  const channel = Object.freeze({ page, on, stats: () => ({ dropped, delivered, plugins: [...subscribers.keys()].sort() }) });
  channels.set(port, channel);
  return channel;
}

// ---- Installed plugin files (host capability pluginRead, APK 0.6.0+) ----
// plugins.read {id, hash, path} returns a file beneath web/ of the selected or this page's
// pinned revision (at most 1 MiB). The page CSP has no connect-src for its own origin, so this
// bridge method, not fetch, is how page code reads plugin files (e.g. packaged skills).
let pageFiles = null;

function decodeBase64(data) {
  const text = globalThis.atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** createPluginFileReader(bridge) → {read(id, hash, path) → Promise<Uint8Array>, readRaw(id, hash, path, encoding)}. */
export function createPluginFileReader(bridge) {
  if (!bridge || typeof bridge.call !== "function") throw new TypeError("A native bridge is required");
  async function readRaw(id, hash, path, encoding = "auto") {
    if (!ID.test(id) || !HASH.test(hash)) throw new TypeError("Invalid plugin id or revision hash");
    if (typeof path !== "string" || !path.startsWith("web/")) throw new TypeError("Plugin files are read beneath web/");
    const result = await bridge.call("plugins.read", { id, hash, path, encoding });
    if (result?.encoding === "text" && typeof result.text === "string") return result;
    if (result?.encoding === "base64" && typeof result.data === "string") return result;
    throw new Error("Invalid plugins.read response");
  }
  return Object.freeze({
    readRaw,
    async read(id, hash, path) {
      const result = await readRaw(id, hash, path, "base64");
      return result.encoding === "text" ? new TextEncoder().encode(result.text) : decodeBase64(result.data);
    }
  });
}

/** The page's reader once loadInstalledPlugins saw a host with pluginRead; otherwise null. */
export function pluginFiles() { return pageFiles; }

/**
 * Call once per page before runtime.start(). Native-only records are returned but
 * never registered as pretend JS service providers. Host blocked/failed/disabled
 * and restart-required revisions are not imported. No automatic retry or replay.
 *
 * adapters is the caller's existing library/adaptor bag (passed by identity).
 * Plugins receive ctx.pi = the host's frozen pi-durable bag (runtime ctx.pi or
 * adapters.pi) to build agent.extensions contributions without their own copy.
 * importModule is an injectable ESM loader for tests; production uses import(url).
 * eventPort is the PiPlugins object (tests inject one). Hosts without the capability
 * pluginEvents get ctx.native.events === false and a no-op ctx.native.on.
 * Loading happens inside setup so the runtime's readiness deadline covers imports.
 * Returns {available, plugins}; runtime.list() supplies subsequent web diagnostics.
 */
export async function loadInstalledPlugins({ runtime, bridge, hostInfo, adapters = {}, onError = () => {}, importModule = (url) => import(url), eventPort = globalThis.PiPlugins } = {}) {
  if (!runtime || typeof runtime.register !== "function") throw new TypeError("A plugin runtime is required");
  // Old hosts have no capability and must not receive unknown commands/events.
  if (!bridge || (hostInfo && hostInfo.capabilities?.plugins !== true)) return { available: false, plugins: [] };
  const capabilities = hostInfo?.capabilities ?? {};
  const files = capabilities.pluginRead === true ? createPluginFileReader(bridge) : null;
  pageFiles = files;
  const credentialsAvailable = capabilities.pluginCredentials === true;
  const httpAvailable = capabilities.httpAllowList === true;
  const eventsAvailable = capabilities.pluginEvents === true && typeof eventPort?.postMessage === "function";
  const events = () => createPluginEventChannel({ port: eventPort, onError });
  let response;
  try { response = await bridge.call("plugins.list", {}); }
  catch (error) {
    if (unavailable(error)) return { available: false, plugins: [] };
    throw error; // Transport loss is not evidence of an empty installed set.
  }
  if (response?.api !== 1) throw new Error(`Unsupported plugins API ${response?.api}; this client supports API 1`);
  if (!Array.isArray(response.plugins)) throw new Error("Invalid plugins.list response: plugins must be an array");
  const ids = new Set();
  for (const plugin of response.plugins) {
    if (ids.has(plugin?.id)) throw new Error(`Duplicate installed plugin id: ${plugin.id}`);
    ids.add(plugin?.id);
  }
  const plugins = [];
  for (const plugin of response.plugins) {
    const diagnostic = { id: plugin?.id, ...(typeof plugin?.name === "string" && plugin.name ? { name: plugin.name.slice(0, 80) } : {}), hash: plugin?.hash, state: plugin?.state, reason: plugin?.reason, web: Boolean(plugin?.web), registered: false };
    plugins.push(diagnostic);
    try {
      validateMetadata(plugin);
      if (hostInfo?.platform === "browser" && globalThis.__piBrowser?.safe) continue;
      if (plugin.enabled !== true || !LOADABLE.has(plugin.state)) continue;
      if (!plugin.web) continue; // Native-only packages are legal; management tools call them.
      const url = pluginEntryUrl(plugin, hostInfo?.platform === "browser" ? hostInfo.pluginAssetBase : undefined);
      // Copy primitive revision identity into the closure; list metadata is not a pointer.
      const { id, hash } = plugin;
      runtime.register({
        id, version: plugin.version, api: 1, reload: plugin.reload,
        provides: plugin.provides, requires: plugin.requires, uses: plugin.uses,
        async setup(ctx) {
          const module = await importModule(url);
          if (ctx.signal.aborted) return; // A late import must not run setup after stop/timeout.
          const setup = module.setup ?? module.default?.setup;
          if (typeof setup !== "function") throw new Error(`${id} must export setup(ctx) or default {setup}`);
          const native = Object.freeze({
            call(method, input = {}) {
              if (ctx.signal.aborted) return Promise.reject(new Error(`Plugin scope is closed: ${id}`));
              if (typeof method !== "string" || !method || !input || typeof input !== "object" || Array.isArray(input)) {
                return Promise.reject(new TypeError("native.call requires a method string and object input"));
              }
              // No cancellation claim: detachment leaves an in-flight mutation's
              // outcome unknown. Never retry it automatically.
              return bridge.call("plugins.call", { id, hash, method, input });
            },
            // Events this plugin's native module emits (PluginContext.emit). Released with the
            // plugin's scope; a no-op on hosts without the pluginEvents capability.
            events: eventsAvailable,
            on(event, callback) {
              if (typeof event !== "string" || !EVENT.test(event)) throw new TypeError("Plugin event names match [A-Za-z][A-Za-z0-9._:-]{0,63}");
              if (typeof callback !== "function") throw new TypeError("native.on requires a callback function");
              if (!eventsAvailable || ctx.signal.aborted) return () => {};
              const off = events().on(id, hash, event, callback);
              const release = () => { ctx.signal.removeEventListener("abort", release); off(); };
              ctx.signal.addEventListener("abort", release, { once: true });
              return release;
            },
            // This revision's own files beneath web/ (pluginRead hosts): {path, size, encoding, text|data}.
            readFile(path, { encoding = "auto" } = {}) {
              if (ctx.signal.aborted) return Promise.reject(new Error(`Plugin scope is closed: ${id}`));
              if (!files) return Promise.reject(new Error("Reading plugin files needs Self Forming 0.6.0 or later"));
              return files.readRaw(id, hash, path, encoding);
            }
          });
          const pi = ctx.pi ?? adapters.pi;
          // Encrypted per-plugin credentials (pluginCredentials hosts): auth.* with provider plugin:<id>:<name>.
          const credential = (name) => {
            if (ctx.signal.aborted) throw new Error(`Plugin scope is closed: ${id}`);
            if (typeof name !== "string" || !CREDENTIAL_NAME.test(name)) throw new TypeError("Credential names match [a-z0-9][a-z0-9._-]{0,63}");
            return `plugin:${id}:${name}`;
          };
          const credentials = credentialsAvailable ? Object.freeze({
            load: async (name) => bridge.call("auth.load", { provider: credential(name) }),
            save: async (name, record) => bridge.call("auth.save", { provider: credential(name), record }),
            clear: async (name) => bridge.call("auth.clear", { provider: credential(name) }),
            info: async (name) => bridge.call("auth.info", { provider: credential(name) })
          }) : undefined;
          // Native HTTP endpoint allow-list (httpAllowList hosts).
          const http = httpAvailable ? Object.freeze({
            allowList: Object.freeze({
              get: () => bridge.call("http.allowList.get", {}),
              set: ({ entries }) => bridge.call("http.allowList.set", { entries })
            })
          }) : undefined;
          return setup(Object.freeze({ ...ctx, native, adapters, ...(pi ? { pi } : {}), ...(credentials ? { credentials } : {}), ...(http ? { http } : {}) }));
        }
      });
      diagnostic.registered = true;
    } catch (error) {
      diagnostic.state = "failed";
      diagnostic.reason = error instanceof Error ? error.message : String(error);
      try { onError(error, { id: plugin?.id, phase: "load" }); } catch { /* Continue independent plugins. */ }
    }
  }
  return { available: true, plugins };
}
