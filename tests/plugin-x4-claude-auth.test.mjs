import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { assembleApp, tick } from './plugin-agent-support.mjs';

// Step X4: Claude sign-in lives in core-providers-claude (claude-auth.js, hand-ported from
// packages/native-host/src/claude-auth.ts). The same scenarios (sign-in, code forms, cancel,
// refresh, sign-out, bad saved data, failures) run against the ported controller and the
// createClaudeAuth of the fixed native-host.js with a fake host; the bridge calls, token
// requests, snapshots and errors must be identical. Dummy values only, no network.
if (!AbortSignal.any) AbortSignal.any = (signals) => { // Node 18
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
};
const available = existsSync(new URL('../dist/app/native-host.js', import.meta.url));
const skip = available ? false : 'dist/app/native-host.js is not present';

let app, ported, original, plugin;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  ported = await app.load('builtin/core-providers-claude/web/claude-auth.js');
  original = await app.load('native-host.js');
  plugin = await app.load('builtin/core-providers-claude/web/index.js');
});
after(async () => { await app?.remove(); });

const gate = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const DUMMY = { access_token: 'dummy-access-secret', refresh_token: 'dummy-refresh-secret', expires_in: 3600, token_type: 'bearer' };

/** One fixture: the host records every call; secrets are replaced by markers in the log. */
function fixture({ saved } = {}) {
  const log = [];
  const state = { record: saved === undefined ? null : structuredClone(saved), opened: gate(), status: 200, response: DUMMY, tokenGate: undefined, saveGate: undefined, failSave: 0, failClear: false, verifier: '' };
  const scrub = (value) => JSON.parse(JSON.stringify(value ?? null, (_k, v) => typeof v === 'string'
    ? v.split(state.verifier || '\u0000').join('<verifier>').replace(/code_challenge=[^&]+/, 'code_challenge=<c>').replace(/"code_challenge":"[^"]+"/, '"code_challenge":"<c>"')
    : v));
  const host = {
    async call(method, params = {}) {
      if (method === 'auth.openExternal') { const url = new URL(params.url); state.verifier = url.searchParams.get('state'); state.opened.resolve(url); }
      log.push(['call', method, scrub(params)]);
      if (method === 'auth.load') return structuredClone(state.record);
      if (method === 'auth.save') {
        if (state.saveGate) await state.saveGate.promise;
        if (state.failSave > 0) { state.failSave--; throw new Error('disk dummy-secret'); }
        state.record = structuredClone(params.record); return null;
      }
      if (method === 'auth.clear') { if (state.failClear) throw new Error('nope'); state.record = null; return null; }
      return null;
    },
    async fetch(input, init) {
      const request = new Request(input, init);
      const body = JSON.parse(await request.text());
      log.push(['fetch', request.url, request.method, request.redirect, request.credentials, request.headers.get('content-type'), scrub(body)]);
      if (state.tokenGate) await state.tokenGate.promise;
      if (state.response instanceof Error) throw state.response;
      return typeof state.response === 'string' ? new Response(state.response, { status: state.status }) : Response.json(state.response, { status: state.status });
    }
  };
  return { host, state, log };
}

const outcome = async (promise) => { try { return { ok: await promise }; } catch (e) { return { error: e.name, message: e.message }; } };
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };

async function scenarios(createClaudeAuth) {
  const out = [];
  const run = async (label, setup, work) => {
    const f = fixture({ saved: setup });
    const opened = [];
    const auth = createClaudeAuth({ host: f.host, onOpenUrl: (url) => opened.push(url.replace(/(state|code_challenge)=[^&]+/g, '$1=<x>')) });
    const snapshots = [];
    auth.subscribe((s) => snapshots.push(s));
    const result = await work(auth, f);
    await settle();
    out.push([label, { result, snapshots, final: auth.snapshot, log: f.log, opened, record: f.state.record }]);
  };
  const ok = { tokens: { access: 'a1', refresh: 'r1', expires: Date.now() + 3600e3 }, version: 1, provider: 'claude' };
  const expired = { ...ok, tokens: { access: 'a1', refresh: 'r1', expires: Date.now() - 1000 } };
  const signIn = async (auth, f, code = (url) => `dummy-code#${url.searchParams.get('state')}`) => {
    const login = auth.login(); const url = await f.state.opened.promise;
    const accepted = auth.submitCode(code(url));
    return { accepted, login: await outcome(login) };
  };

  await run('restore: nothing saved', undefined, async (a) => outcome(a.restore()));
  await run('restore: saved tokens', ok, async (a) => ({ r: await outcome(a.restore()), token: await outcome(a.getAccessToken()) }));
  await run('restore: invalid saved shapes', { version: 2 }, async (a) => outcome(a.restore()));
  await run('restore: invalid tokens', { version: 1, provider: 'claude', tokens: { access: 'x' } }, async (a) => outcome(a.restore()));
  await run('restore: foreign provider', { version: 1, provider: 'other' }, async (a) => outcome(a.restore()));
  await run('sign in with code#state', undefined, async (a, f) => signIn(a, f));
  await run('sign in with callback URL', undefined, async (a, f) => signIn(a, f, (url) => `https://platform.claude.com/oauth/code/callback?code=dummy&state=${url.searchParams.get('state')}`));
  await run('sign in with code=&state=', undefined, async (a, f) => signIn(a, f, (url) => `code=dummy&state=${url.searchParams.get('state')}`));
  await run('sign in with bare code', undefined, async (a, f) => signIn(a, f, () => '  dummy-bare-code  '));
  for (const [label, code] of [['wrong state', () => 'dummy#other-state'], ['two hashes', () => 'a#b#c'], ['whitespace code', () => 'two words'],
    ['foreign callback', () => 'https://evil.example/oauth/code/callback?code=x'], ['error callback', () => 'https://platform.claude.com/oauth/code/callback?error=access_denied&code=x'],
    ['credentials in URL', () => 'https://u:p@platform.claude.com/oauth/code/callback?code=x'], ['duplicate code', () => 'code=a&code=b'], ['empty', () => ''], ['bad URL', () => 'http://']]) {
    await run(`sign in rejected: ${label}`, undefined, async (a, f) => signIn(a, f, code));
  }
  await run('sign in: token endpoint 400', undefined, async (a, f) => { f.state.status = 400; return signIn(a, f); });
  await run('sign in: incomplete credentials', undefined, async (a, f) => { f.state.response = { access_token: 'x' }; return signIn(a, f); });
  await run('sign in: not bearer', undefined, async (a, f) => { f.state.response = { ...DUMMY, token_type: 'mac' }; return signIn(a, f); });
  await run('sign in: not JSON', undefined, async (a, f) => { f.state.response = 'oops'; return signIn(a, f); });
  await run('sign in: network failure', undefined, async (a, f) => { f.state.response = new Error('offline dummy-secret'); return signIn(a, f); });
  await run('sign in: save fails', undefined, async (a, f) => { f.state.failSave = 1; return signIn(a, f); });
  await run('submitCode without sign-in / non-string', undefined, async (a) => [a.submitCode('x'), a.submitCode(5)]);
  await run('second login while one is running', undefined, async (a, f) => {
    const first = a.login(); await f.state.opened.promise;
    const second = await outcome(a.login());
    a.cancel();
    return { second, first: await outcome(first) };
  });
  await run('cancel while waiting for the code', undefined, async (a, f) => {
    const login = a.login(); await f.state.opened.promise; await settle(); a.cancel();
    return outcome(login);
  });
  await run('cancel during the token request', undefined, async (a, f) => {
    f.state.tokenGate = gate();
    const login = a.login(); const url = await f.state.opened.promise; a.submitCode(`c#${url.searchParams.get('state')}`);
    await settle(); a.cancel(); f.state.tokenGate.resolve();
    return outcome(login);
  });
  await run('cancel during the save restores the previous record', ok, async (a, f) => {
    await a.restore();
    f.state.saveGate = gate();
    const login = a.login(); const url = await f.state.opened.promise; a.submitCode(`c#${url.searchParams.get('state')}`);
    await settle(); a.cancel(); f.state.saveGate.resolve();
    return outcome(login);
  });
  await run('expired token is refreshed and rotated', expired, async (a) => ({ t1: await outcome(a.getAccessToken()), t2: await outcome(a.getAccessToken()) }));
  await run('refresh rejected', expired, async (a, f) => { f.state.status = 401; return outcome(a.getAccessToken()); });
  await run('refresh while signed out', undefined, async (a) => outcome(a.getAccessToken()));
  await run('getAccessToken with an aborted signal', ok, async (a) => outcome(a.getAccessToken(AbortSignal.abort())));
  await run('concurrent refreshes are serialised', expired, async (a, f) => {
    f.state.tokenGate = gate();
    const both = Promise.all([outcome(a.getAccessToken()), outcome(a.getAccessToken())]);
    await settle(); f.state.tokenGate.resolve();
    return both;
  });
  await run('sign out', ok, async (a) => ({ restore: await outcome(a.restore()), logout: await outcome(a.logout()), token: await outcome(a.getAccessToken()) }));
  await run('sign out with a corrupt record', { version: 9 }, async (a) => outcome(a.logout()));
  await run('sign out fails to clear', ok, async (a, f) => { f.state.failClear = true; return outcome(a.logout()); });
  await run('sign out cancels a running sign-in', undefined, async (a, f) => {
    const login = a.login(); await f.state.opened.promise; await settle();
    const logout = await outcome(a.logout());
    return { logout, login: await outcome(login) };
  });
  await run('listener errors and unsubscribe', undefined, async (a) => {
    const initial = (() => { try { a.subscribe(() => { throw new Error('observer'); }); return 'subscribed'; } catch (e) { return e.message; } })();
    let calls = 0;
    const off = a.subscribe(() => { if (calls++) throw new Error('observer'); }); // later throws are swallowed
    const restored = await outcome(a.restore()); off(); await outcome(a.restore());
    return { initial, restored, calls };
  });
  return out;
}

test('ported Claude sign-in and the compiled one behave identically', { skip }, async () => {
  const left = await scenarios(ported.createClaudeAuth);
  const right = await scenarios(original.createClaudeAuth);
  assert.ok(left.length >= 35, `${left.length} scenarios`);
  assert.deepEqual(left.map(([l]) => l), right.map(([l]) => l));
  for (let i = 0; i < left.length; i++) {
    // Expiry timestamps depend on the clock: compare them rounded to the minute.
    const norm = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'expires' && typeof x === 'number') ? Math.round(x / 60000) : x));
    assert.deepEqual(norm(left[i]), norm(right[i]), left[i][0]);
  }
  const by = (label) => left.find(([l]) => l === label)[1];
  assert.equal(by('sign in with code#state').result.login.ok, undefined);
  assert.equal(by('sign in with code#state').final.signedIn, true);
  assert.equal(by('sign out').final.signedIn, false);
  assert.equal(by('sign in rejected: wrong state').result.login.message, 'This Claude code belongs to a different sign-in. Try again.');
  assert.ok(by('sign out').log.some(([k, m]) => k === 'call' && m === 'auth.clear'));
});

test('credentials never appear in snapshots, errors or console output', { skip }, async () => {
  const seen = [];
  const spies = ['log', 'error', 'warn', 'info', 'debug'].map((name) => { const old = console[name]; console[name] = (...args) => seen.push(args); return () => { console[name] = old; }; });
  try {
    for (const create of [ported.createClaudeAuth]) {
      const f = fixture();
      const auth = create({ host: f.host });
      const snapshots = [];
      auth.subscribe((s) => snapshots.push(JSON.stringify(s)));
      const login = auth.login(); const url = await f.state.opened.promise;
      auth.submitCode(`c#${url.searchParams.get('state')}`); await login;
      f.state.status = 500; f.state.response = { error: 'dummy-access-secret dummy-refresh-secret' };
      auth.cancel();
      const refresh = fixture({ saved: { version: 1, provider: 'claude', tokens: { access: 'x', refresh: 'y', expires: 1 } } });
      refresh.state.status = 500; refresh.state.response = 'dummy-access-secret';
      const bad = await outcome(create({ host: refresh.host }).getAccessToken());
      const text = JSON.stringify([snapshots, bad, seen]);
      assert.doesNotMatch(text, /dummy-access-secret|dummy-refresh-secret|"access":"x"|"refresh":"y"/);
    }
  } finally { spies.forEach((restore) => restore()); }
});

test('fallback: native-host.js createClaudeAuth is used only when claude-auth.js cannot load', { skip }, async () => {
  const errors = [];
  const old = console.error; console.error = (...args) => errors.push(args);
  try {
    assert.equal(await plugin.loadClaudeAuth({ load: () => Promise.reject(new Error('broken')) }), original.createClaudeAuth);
    assert.equal(await plugin.loadClaudeAuth({ load: async () => ({}) }), original.createClaudeAuth);
  } finally { console.error = old; }
  assert.equal(errors.length, 2);
  assert.equal(await plugin.loadClaudeAuth(), ported.createClaudeAuth);
});

test('sources: plain JavaScript, no static native-host.js import for Claude sign-in, app.js uses the plugin', { skip }, async () => {
  const source = await readFile(new URL('../plugins/core-providers-claude/web/claude-auth.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import /m);
  assert.doesNotMatch(source, /^import type|\bimplements\b|\breadonly\b|<T>|\bas const\b/m);
  const appSource = await readFile(new URL('../apps/common/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(appSource, /createClaudeAuth\s*[,}]|import \{[^}]*createClaudeAuth/);
  assert.match(appSource, /coreClaude\.loadClaudeAuth\(\)/);
  assert.doesNotMatch(appSource, /import \{ createChatGPTAuth/);
});
