// Test support for Track A step A2 (core agent tools as built-in plugins): opens the
// real session.js (offline demo model, memory storage) in fixed host configurations
// and reads back exactly which tools each model request was offered.
// Mocked hosts only: no Android device, network, account or real execution service.
import { createHash } from 'node:crypto';
import { until } from './plugin-agent-support.mjs';

export const STORED = {
  // Default (host selection, nothing stored).
  default: undefined,
  // What Settings → Plugins writes (an unknown plugin excluded).
  pluginExcluded: { extensions: { remove: [{ name: 'plugin-agent-fixture' }] } },
  // An explicit list (not written by the app, but pi-durable supports it).
  explicit: { extensions: [{ name: 'self-forming-prompts' }, { name: 'self-forming-native' }] },
  // A subagent-like configuration: subagents removed, explicit tool names.
  subagentLike: { extensions: { remove: [{ name: 'self-forming-subagents' }] }, tools: ['read', 'bash', 'javascript', 'app_update', 'plugins', 'workspace_read'].map((name) => ({ name })) },
  // Opting into an installed but unselected core extension by name.
  addWorkspace: { extensions: { add: [{ name: 'self-forming-workspace' }] } }
};

function memoryEnv({ backgroundExecution, shell }) {
  const files = new Map();
  const ok = (value) => ({ ok: true, value });
  const fail = (path) => ({ ok: false, error: Object.assign(new Error(`No such file: ${path}`), { code: 'not_found', path }) });
  return {
    id: 'test-env', cwd: '/workspace', home: '/workspace', backgroundExecution, files, ...shell ? { shell } : {},
    async exec() { return ok({ exitCode: 0 }); },
    async absolutePath(path) { return ok(path.startsWith('/') ? path : `/workspace/${path}`); },
    async canonicalPath() { return { ok: false, error: { code: 'not_supported' } }; },
    async joinPath(parts) { return ok(parts.join('/').replace(/\/+/g, '/').replace(/\/[^/]+\/\.\.$/, '') || '/'); },
    async exists(path) { return ok(files.has(path) || path === '/workspace'); },
    async cleanup() {},
    async writeFile(path, data) { files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data)); return ok(undefined); },
    async readTextFile(path) { return files.has(path) ? ok(files.get(path)) : fail(path); },
    async readBinaryFile(path) { return files.has(path) ? ok(new TextEncoder().encode(files.get(path))) : fail(path); },
    async openBinaryReader(path) {
      if (!files.has(path)) return fail(path);
      const bytes = new TextEncoder().encode(files.get(path));
      return ok({ async info() { return ok({ size: bytes.length, mtimeMs: 0 }); }, async read(offset, length) { return ok(bytes.slice(offset, offset + length)); }, async close() {} });
    },
    async stat(path) { return files.has(path) ? ok({ kind: 'file', size: files.get(path).length, mtimeMs: 0 }) : fail(path); },
    async createDir() { return ok(undefined); },
    async mkdir() { return ok(undefined); }
  };
}

const call = async (method) => { throw Object.assign(new Error(`unexpected bridge call ${method}`), { code: 'UNSUPPORTED' }); };
// Each configuration: the host info global, session options and the expected offline demo tools.
export const CONFIGURATIONS = {
  offline: () => ({ hostInfo: undefined, options: {} }),
  native: () => ({
    hostInfo: { platform: 'android', capabilities: { executionEnv: true, backgroundExecution: true, secrets: true, plugins: true, apkInstall: true, editableApp: true } },
    options: {
      env: memoryEnv({ backgroundExecution: true }), bridge: { call, subscribe: () => () => {} },
      appRevision: { info: async () => ({ sourcePath: '/src' }), stage: async () => ({ revision: 'r1' }), onStaged() {} },
      apkInstaller: { call: async () => ({ text: 'ok' }) }
    }
  }),
  nativeMinimal: () => ({
    hostInfo: { platform: 'android', capabilities: { executionEnv: true } },
    options: { env: memoryEnv({ backgroundExecution: false }), bridge: { call, subscribe: () => () => {} } }
  }),
  browser: () => ({
    // E1: the session's environment is the Linux execution@1 provider (exec-linux).
    hostInfo: { platform: 'browser', capabilities: { executionEnv: true, linuxShell: true, editableApp: true } },
    options: {
      env: memoryEnv({ backgroundExecution: false, shell: { id: 'bash', language: 'bash', name: 'Linux (Bash)' } }), bridge: { call, subscribe: () => () => {} },
      appRevision: { info: async () => ({ sourcePath: '/src' }), stage: async () => ({ revision: 'r1' }), onStaged() {} }
    }
  }),
  browserNoLinux: () => ({
    // E1: no Linux on the page: the JavaScript execution@1 provider (exec-js).
    hostInfo: { platform: 'browser', capabilities: { executionEnv: true } },
    options: { env: memoryEnv({ backgroundExecution: false, shell: { id: 'javascript', language: 'javascript', name: 'JavaScript' } }), bridge: { call, subscribe: () => () => {} } }
  })
};

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** Tool definitions (name + hash of description/parameters) offered to each request, oldest first. */
export async function offeredDefinitions(storage, conversationId, context) {
  const entries = [];
  let cursor;
  do {
    const page = await storage.scanEntries({ conversationId }, 100, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  entries.sort((a, b) => a.id - b.id);
  let offered = [];
  const requests = [];
  for (const record of entries) {
    if (record.kind !== 'pi.system') continue;
    const full = (await storage.entry?.(record.id, context))?.entry ?? record;
    for (const message of full.model ?? []) {
      const removed = new Set((message.toolsRemoved ?? []).map((tool) => typeof tool === 'string' ? tool : tool.name));
      offered = offered.filter((tool) => !removed.has(tool.name));
      for (const tool of message.toolsAdded ?? []) offered.push({ name: tool.name, hash: digest(tool) });
    }
    requests.push(offered.map((tool) => `${tool.name}#${tool.hash}`));
  }
  return requests;
}

/**
 * Opens session.js in one configuration, optionally with a stored pi.agent for the
 * main conversation, sends one offline message and returns the first request's tools
 * (name#definition-hash, in the offered order) plus the reply's tool results.
 */
export async function toolsFor({ pd, ai, chord, session }, name, { stored, agentExtensions, hostInfoOverride, onOpen } = {}) {
  const context = chord.BACKGROUND_CONTEXT;
  const { hostInfo, options } = CONFIGURATIONS[name]();
  const storage = new (class extends pd.MemoryStorage { async close() {} })();
  if (stored) {
    // An earlier app version saved this pi.agent (names only, as configure() persists them).
    const seed = await pd.Harness.open(storage, { models: ai.createModels(), registry: pd.createRegistry() }, context);
    const root = await seed.root(context);
    await root.configure(stored, context);
    await seed.close(context);
  }
  const saved = globalThis.__piHostInfo;
  globalThis.__piHostInfo = hostInfoOverride ?? hostInfo;
  let opened;
  try {
    opened = await session.openAppSession({ storage, toolchain: false, demoTokensPerSecond: 0, ...options, ...(agentExtensions ? { agentExtensions } : {}) });
    const main = opened.snapshot.conversation.id;
    await onOpen?.(opened);
    const before = opened.snapshot.messages.length;
    await opened.send('hello tools');
    await until(() => !opened.snapshot.busy && opened.snapshot.messages.length > before + 1 && opened.snapshot.messages.at(-1)?.role === 'assistant', `reply did not finish (${name})`);
    const requests = await offeredDefinitions(storage, main, context);
    const results = opened.snapshot.messages.filter((message) => message.role === 'tool').map((message) => `${message.toolName}${message.error ? '!' : ''}`);
    return { tools: requests[0], results, final: opened.snapshot.messages.at(-1).text };
  } finally {
    await opened?.close();
    globalThis.__piHostInfo = saved;
  }
}
