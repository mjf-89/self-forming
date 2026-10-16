// Endpoint configuration of the openai-compatible plugin: base URLs, model lists and
// optional API keys. Plain data, no DOM.
//
// - Config (no secrets) lives in localStorage under STORAGE_KEY (PERMANENT name), or in
//   memory when the page has no localStorage. Shape v1: {version: 1, endpoints: [{slug,
//   label, baseUrl, models: null | [{id, name?, contextWindow?, maxTokens?}], discovered:
//   [{id, name?, contextWindow?, maxTokens?}], keyRequired, images, contextWindow?,
//   maxTokens?, compat?, allowListed?}]}. models null = list from GET <baseUrl>/models.
// - API keys are plugin credentials: record {apiKey} under "plugin:openai-compatible:<slug>"
//   through ctx.credentials (load/save/clear by name; host lane pluginCredentials, 0.6.0).
//   Without that lane keys are held in memory for this page only. Keys never appear in
//   list()/describe() results, errors, logs or the agent tool.
// - Transport: http(s)://127.0.0.1 or localhost (any port) → "page" (page fetch; the app's
//   CSP allows loopback). Other hosts need https → "host" (the native fetch, which only
//   reaches endpoints in the native HTTP allow-list; add() lists the base URL through
//   ctx.http.allowList when the host has the lane). Plain http to another machine is
//   refused: neither the CSP nor the native policy can reach it.
export const PROVIDER_ID = "openai-compatible";
export const STORAGE_KEY = "self-forming.plugin.openai-compatible.v1";
export const DEFAULT_CONTEXT_WINDOW = 32768;
export const DEFAULT_MAX_TOKENS = 4096;
export const MAX_ENDPOINTS = 16;
export const MAX_MODELS = 500;
const FRESH_MS = 30000;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost"]); // what the page CSP (connect-src) allows
// Generic OpenAI-compatible servers (llama-server, Ollama, vLLM, LM Studio): only the
// widely supported request fields. An endpoint's own compat overrides these.
export const DEFAULT_COMPAT = Object.freeze({
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
  supportsUsageInStreaming: true,
  supportsStrictMode: false
});
const COMPAT_KEYS = new Set(["supportsStore", "supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming", "supportsFinishReason", "maxTokensField", "requiresToolResultName", "requiresAssistantAfterToolResult", "requiresThinkingAsText", "supportsStrictMode", "sendSessionAffinityHeaders", "sessionAffinityFormat", "cacheControlFormat", "openRouterRouting", "vllmPriority"]);

const text = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
const message = (error) => error instanceof Error ? error.message : String(error);
const positive = (value) => Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** Checks a base URL; → {baseUrl, transport: "page" | "host", host}. Throws a user-facing reason. */
export function parseBaseUrl(value) {
  const raw = text(value, 2048);
  if (!raw) throw new Error("Give the endpoint's base URL, e.g. http://127.0.0.1:8080/v1.");
  let url;
  try { url = new URL(raw); } catch { throw new Error(`"${raw.slice(0, 200)}" is not a URL. Use e.g. http://127.0.0.1:8080/v1.`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The base URL must start with http:// or https://.");
  if (url.username || url.password) throw new Error("Do not put a user name or password in the URL; save the API key separately.");
  if (url.search || url.hash) throw new Error("The base URL cannot have a query (?…) or fragment (#…).");
  const path = url.pathname.replace(/\/+$/, "");
  if (path.split("/").some((part) => part === "." || part === "..") || /%2f|%5c/i.test(path)) throw new Error("The base URL path is not allowed.");
  const loopback = LOOPBACK.has(url.hostname);
  if (!loopback && url.protocol !== "https:") throw new Error("Plain http only works for this phone (127.0.0.1 or localhost). Use https for other machines.");
  const baseUrl = `${url.protocol}//${url.host}${path}`;
  return { baseUrl, transport: loopback ? "page" : "host", host: url.hostname };
}

/** A slug for a new endpoint (credential name and model id prefix; PERMANENT once used). */
export function slugFor(label, baseUrl, taken) {
  let base = text(label, 64).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "");
  if (!base) {
    const url = new URL(baseUrl);
    base = LOOPBACK.has(url.hostname) ? `local-${url.port || (url.protocol === "https:" ? "443" : "80")}` : url.hostname.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  }
  base = base.slice(0, 56) || "endpoint";
  let slug = base, n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  return slug;
}

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); }, removeItem: (key) => { values.delete(key); } };
}
function cleanModels(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const entry = typeof item === "string" ? { id: item } : item;
    const id = text(entry?.id, 300);
    if (!id || seen.has(id) || /[\u0000-\u001f]/.test(id)) continue;
    seen.add(id);
    result.push({ id, ...(text(entry.name, 200) ? { name: text(entry.name, 200) } : {}), ...(positive(entry.contextWindow) ? { contextWindow: entry.contextWindow } : {}), ...(positive(entry.maxTokens) ? { maxTokens: entry.maxTokens } : {}) });
    if (result.length >= MAX_MODELS) break;
  }
  return result;
}
function cleanCompat(compat) {
  if (!compat || typeof compat !== "object") return undefined;
  const result = {};
  for (const [key, value] of Object.entries(compat)) if (COMPAT_KEYS.has(key) && value !== undefined) result[key] = value;
  return Object.keys(result).length ? result : undefined;
}
function cleanEndpoint(value) {
  const slug = text(value?.slug, 64);
  if (!SLUG.test(slug)) return undefined;
  let parsed;
  try { parsed = parseBaseUrl(value.baseUrl); } catch { return undefined; }
  return {
    slug,
    label: text(value.label, 80) || slug,
    baseUrl: parsed.baseUrl,
    transport: parsed.transport,
    models: cleanModels(value.models),
    discovered: cleanModels(value.discovered) ?? [],
    keyRequired: value.keyRequired === true,
    images: value.images === true,
    ...(positive(value.contextWindow) ? { contextWindow: value.contextWindow } : {}),
    ...(positive(value.maxTokens) ? { maxTokens: value.maxTokens } : {}),
    ...(cleanCompat(value.compat) ? { compat: cleanCompat(value.compat) } : {}),
    ...(value.allowListed === true ? { allowListed: true } : {})
  };
}

/** Entries of GET <baseUrl>/models: OpenAI {data:[{id}]}, plus the extra fields servers add. */
export function parseModelList(body) {
  const items = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
  return cleanModels(items.map((item) => {
    if (typeof item === "string") return { id: item };
    const id = item?.id ?? item?.model ?? item?.name;
    const contextWindow = positive(item?.max_model_len) ?? positive(item?.context_length) ?? positive(item?.meta?.n_ctx) ?? positive(item?.context_window);
    const maxTokens = positive(item?.top_provider?.max_completion_tokens) ?? positive(item?.max_completion_tokens);
    return { id, ...(typeof item?.name === "string" && item.name !== id ? { name: item.name } : {}), ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}) };
  })) ?? [];
}

/**
 * createEndpointStore({storage, credentials, http, pageFetch}) → store.
 * credentials: {load(name), save(name, record), clear(name)} (plugin credential lane) or
 * undefined (keys in memory only). http: {fetch?, allowList?: {get(), set(entries)}}.
 */
export function createEndpointStore({ storage, credentials, http, pageFetch = (...args) => globalThis.fetch(...args) } = {}) {
  const store = storage ?? memoryStorage();
  const listeners = new Set();
  const keys = new Map(); // slug -> key | null (loaded), never leaves this closure except into request headers
  const failures = new Map(); // slug -> last discovery error (user-facing text)
  const fresh = new Map(); // slug -> time of the last successful discovery (liveModels skips it for FRESH_MS)
  let sessionFetch; // the transport of the last opened session (native fetch on Android)
  let closed = false;
  let config = read();

  function read() {
    let parsed;
    try { parsed = JSON.parse(store.getItem(STORAGE_KEY) ?? "null"); } catch { parsed = null; }
    const endpoints = [];
    const seen = new Set();
    for (const value of Array.isArray(parsed?.endpoints) ? parsed.endpoints : []) {
      const endpoint = cleanEndpoint(value);
      if (!endpoint || seen.has(endpoint.slug)) continue;
      seen.add(endpoint.slug);
      endpoints.push(endpoint);
    }
    return { version: 1, endpoints };
  }
  function write(next) {
    config = next;
    try { store.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* kept in memory for this page */ }
    notify();
  }
  function notify() {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* a listener must not break the store */ }
    }
  }
  const find = (slug) => config.endpoints.find((endpoint) => endpoint.slug === slug);
  const requireEndpoint = (slug) => {
    const endpoint = find(text(slug, 64));
    if (!endpoint) throw new Error(`There is no OpenAI-compatible endpoint "${text(slug, 64)}".`);
    return endpoint;
  };
  const replace = (endpoint) => write({ ...config, endpoints: config.endpoints.map((item) => item.slug === endpoint.slug ? endpoint : item) });

  // ---- keys ----
  async function keyFor(slug) {
    if (keys.has(slug)) return keys.get(slug) ?? undefined;
    if (!credentials) return undefined;
    let record = null;
    try { record = await credentials.load(slug); } catch { record = null; }
    const key = typeof record?.apiKey === "string" && record.apiKey ? record.apiKey : null;
    keys.set(slug, key);
    return key ?? undefined;
  }
  function checkedKey(key) {
    const value = typeof key === "string" ? key.trim() : "";
    if (!value) throw new Error("The API key is empty.");
    if (value.length > 4096 || /[\s\u0000-\u001f]/.test(value)) throw new Error("That does not look like an API key (no spaces or line breaks).");
    return value;
  }
  async function setKey(slug, key) {
    const endpoint = requireEndpoint(slug);
    const value = checkedKey(key);
    if (credentials) await credentials.save(endpoint.slug, { apiKey: value });
    keys.set(endpoint.slug, value);
    fresh.delete(endpoint.slug); // the server may list other models for this key
    notify();
    return { slug: endpoint.slug, keySaved: true, keyStorage: credentials ? "encrypted" : "memory" };
  }
  async function clearKey(slug) {
    const endpoint = requireEndpoint(slug);
    if (credentials) await credentials.clear(endpoint.slug);
    keys.set(endpoint.slug, null);
    fresh.delete(endpoint.slug);
    notify();
    return { slug: endpoint.slug, keySaved: false };
  }
  /** The key for one request; a required key that is missing is a user-facing error. */
  async function requestKey(endpoint) {
    const key = await keyFor(endpoint.slug);
    if (!key && endpoint.keyRequired) throw new Error(`Save the API key for ${endpoint.label} first.`);
    return key;
  }

  // ---- transport ----
  /** A fetch for discovery requests of one endpoint (page fetch for loopback, the host's otherwise). */
  function discoveryFetch(endpoint) {
    if (endpoint.transport === "page") return pageFetch;
    const native = http?.fetch ?? sessionFetch;
    if (!native) throw new Error(`Open a chat first: ${endpoint.label} is reached through the app's network connection.`);
    return native;
  }
  function unreachable(endpoint, error) {
    if (error?.name === "AbortError") return error;
    return new Error(`Could not reach ${endpoint.label} at ${endpoint.baseUrl} (${message(error).slice(0, 200)}). Check that the server is running.`);
  }

  // ---- models ----
  function modelOf(endpoint, entry) {
    return {
      id: `${endpoint.slug}/${entry.id}`,
      requestModelId: entry.id,
      name: `${entry.name ?? entry.id} (${endpoint.label})`,
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: endpoint.baseUrl,
      reasoning: false,
      input: endpoint.images ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: endpoint.contextWindow ?? entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: endpoint.maxTokens ?? entry.maxTokens ?? DEFAULT_MAX_TOKENS,
      compat: { ...DEFAULT_COMPAT, ...endpoint.compat }
    };
  }
  const entriesOf = (endpoint) => endpoint.models ?? endpoint.discovered;
  /** Last-known models of every endpoint (static catalog). */
  const catalog = () => config.endpoints.flatMap((endpoint) => entriesOf(endpoint).map((entry) => modelOf(endpoint, entry)));
  /** "<slug>/<remote id>" → {endpoint, remoteId} | undefined. */
  function split(modelId) {
    const value = String(modelId ?? "");
    const slash = value.indexOf("/");
    if (slash <= 0) return undefined;
    return { slug: value.slice(0, slash), remoteId: value.slice(slash + 1), endpoint: find(value.slice(0, slash)) };
  }
  /** The model for a stored id, from the current config (also for ids the server no longer lists). */
  function modelFor(modelId) {
    const parts = split(modelId);
    if (!parts?.endpoint || !parts.remoteId) return undefined;
    const entry = entriesOf(parts.endpoint).find((item) => item.id === parts.remoteId) ?? { id: parts.remoteId };
    return modelOf(parts.endpoint, entry);
  }
  async function discover(slug, { signal } = {}) {
    const endpoint = requireEndpoint(slug);
    const fetch = discoveryFetch(endpoint);
    const key = await keyFor(endpoint.slug);
    const headers = { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
    let response;
    try {
      response = await fetch(`${endpoint.baseUrl}/models`, { method: "GET", headers, ...(signal ? { signal } : {}) });
    } catch (error) {
      const reason = unreachable(endpoint, error);
      failures.set(endpoint.slug, reason.message);
      throw reason;
    }
    if (!response.ok) {
      void response.body?.cancel?.().catch?.(() => {});
      const reason = new Error(`${endpoint.label} refused the model list (HTTP ${response.status})${response.status === 401 || response.status === 403 ? ": check its API key" : ""}.`);
      failures.set(endpoint.slug, reason.message);
      throw reason;
    }
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    const discovered = parseModelList(body);
    if (!discovered.length) {
      const reason = new Error(`${endpoint.label} listed no models. Add the model ids by hand.`);
      failures.set(endpoint.slug, reason.message);
      throw reason;
    }
    failures.delete(endpoint.slug);
    fresh.set(endpoint.slug, Date.now());
    const current = find(endpoint.slug);
    if (current && JSON.stringify(current.discovered) !== JSON.stringify(discovered)) replace({ ...current, discovered });
    return discovered;
  }
  /**
   * Live models of every endpoint: manual lists as they are, discovered lists refreshed
   * (a server that is down keeps its last-known list). Throws when nothing is usable.
   */
  async function liveModels(signal) {
    if (!config.endpoints.length) throw new Error(NO_ENDPOINT);
    const errors = [];
    for (const endpoint of [...config.endpoints]) {
      if (endpoint.models) continue;
      if (Date.now() - (fresh.get(endpoint.slug) ?? -Infinity) < FRESH_MS) continue;
      try { await discover(endpoint.slug, { signal }); } catch (error) { errors.push(error); }
    }
    const list = catalog();
    if (!list.length) throw errors[0] ?? new Error(NO_ENDPOINT);
    return list;
  }

  // ---- endpoints ----
  async function allow(endpoint) {
    if (endpoint.transport !== "host" || !http?.allowList) return { ...endpoint };
    const current = await http.allowList.get();
    const entries = Array.isArray(current?.entries) ? current.entries : [];
    if (entries.includes(endpoint.baseUrl)) return { ...endpoint };
    await http.allowList.set({ entries: [...entries, endpoint.baseUrl] });
    return { ...endpoint, allowListed: true };
  }
  async function disallow(endpoint) {
    if (!endpoint.allowListed || !http?.allowList) return;
    if (config.endpoints.some((other) => other.slug !== endpoint.slug && other.baseUrl === endpoint.baseUrl)) return;
    const current = await http.allowList.get();
    const entries = Array.isArray(current?.entries) ? current.entries : [];
    if (entries.includes(endpoint.baseUrl)) await http.allowList.set({ entries: entries.filter((entry) => entry !== endpoint.baseUrl) });
  }
  /** add({baseUrl, label?, models?, keyRequired?, images?, contextWindow?, maxTokens?, compat?, apiKey?}) → describe(). */
  async function add(input = {}) {
    if (closed) throw new Error("The OpenAI-compatible plugin was stopped.");
    const parsed = parseBaseUrl(input.baseUrl);
    if (config.endpoints.length >= MAX_ENDPOINTS) throw new Error(`At most ${MAX_ENDPOINTS} endpoints can be configured.`);
    if (config.endpoints.some((endpoint) => endpoint.baseUrl === parsed.baseUrl)) throw new Error(`${parsed.baseUrl} is already configured.`);
    const slug = input.slug !== undefined ? text(input.slug, 64) : slugFor(input.label, parsed.baseUrl, new Set(config.endpoints.map((endpoint) => endpoint.slug)));
    if (!SLUG.test(slug)) throw new Error("The endpoint name may use lowercase letters, digits, dots, underscores and hyphens.");
    if (find(slug)) throw new Error(`There is already an endpoint "${slug}".`);
    let endpoint = cleanEndpoint({
      slug, label: input.label, baseUrl: parsed.baseUrl,
      models: input.models === undefined || input.models === null ? null : input.models,
      keyRequired: input.keyRequired ?? parsed.transport === "host",
      images: input.images, contextWindow: input.contextWindow, maxTokens: input.maxTokens, compat: input.compat
    });
    if (endpoint.models && !endpoint.models.length) throw new Error("The model list is empty.");
    if (input.apiKey !== undefined) checkedKey(input.apiKey);
    endpoint = await allow(endpoint);
    write({ ...config, endpoints: [...config.endpoints, endpoint] });
    if (input.apiKey !== undefined) await setKey(slug, input.apiKey);
    if (!endpoint.models) {
      try { await discover(slug); } catch { /* reported by describe(): lastError */ }
    }
    return describeOne(find(slug));
  }
  async function update(slug, patch = {}) {
    const endpoint = requireEndpoint(slug);
    const next = cleanEndpoint({
      ...endpoint,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.models !== undefined ? { models: patch.models } : {}),
      ...(patch.keyRequired !== undefined ? { keyRequired: patch.keyRequired } : {}),
      ...(patch.images !== undefined ? { images: patch.images } : {}),
      ...(patch.contextWindow !== undefined ? { contextWindow: patch.contextWindow } : {}),
      ...(patch.maxTokens !== undefined ? { maxTokens: patch.maxTokens } : {}),
      ...(patch.compat !== undefined ? { compat: patch.compat } : {})
    });
    replace(next);
    return describeOne(next);
  }
  async function remove(slug) {
    const endpoint = requireEndpoint(slug);
    await disallow(endpoint);
    if (credentials) {
      try { await credentials.clear(endpoint.slug); } catch { /* nothing stored */ }
    }
    keys.delete(endpoint.slug);
    failures.delete(endpoint.slug);
    fresh.delete(endpoint.slug);
    write({ ...config, endpoints: config.endpoints.filter((item) => item.slug !== endpoint.slug) });
    return { removed: endpoint.slug };
  }
  function describeOne(endpoint) {
    const saved = keys.has(endpoint.slug) ? Boolean(keys.get(endpoint.slug)) : undefined;
    return {
      slug: endpoint.slug,
      label: endpoint.label,
      baseUrl: endpoint.baseUrl,
      transport: endpoint.transport === "page" ? "page (this phone)" : "app network (allow-list)",
      models: entriesOf(endpoint).map((entry) => `${endpoint.slug}/${entry.id}`),
      modelSource: endpoint.models ? "manual" : "server",
      keyRequired: endpoint.keyRequired,
      ...(saved !== undefined ? { keySaved: saved } : {}),
      keyStorage: credentials ? "encrypted" : "memory",
      ...(failures.has(endpoint.slug) ? { lastError: failures.get(endpoint.slug) } : {})
    };
  }
  async function list() {
    for (const endpoint of config.endpoints) await keyFor(endpoint.slug);
    return config.endpoints.map(describeOne);
  }

  return Object.freeze({
    // provider side
    catalog, modelFor, split, liveModels, requestKey, keyFor,
    lastError: (slug) => failures.get(slug),
    endpoints: () => config.endpoints.slice(),
    get: find,
    useSessionFetch(fetch) { if (typeof fetch === "function") sessionFetch = fetch; },
    // management (service openai-compatible.endpoints@1 and the agent tool)
    list, add, update, remove, setKey, clearKey,
    refresh: (slug, options) => discover(slug, options).then(() => describeOne(requireEndpoint(slug))),
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("subscribe expects a function");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() { closed = true; listeners.clear(); keys.clear(); }
  });
}
export const NO_ENDPOINT = "Add an OpenAI-compatible endpoint first (its base URL, e.g. http://127.0.0.1:8080/v1).";
