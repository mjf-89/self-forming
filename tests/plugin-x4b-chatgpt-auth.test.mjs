import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { assembleApp, tick } from './plugin-agent-support.mjs';

// Step X4b: ChatGPT sign-in lives in core-providers-chatgpt (chatgpt-auth.js, hand-ported from
// packages/native-host/src/auth.ts; the ID-token check is the vendored official jose build in
// lib/jose/). The same scenarios (sign-in, account switch, refresh, sign-out, cancel, bad saved data,
// failures, and forged/expired/mismatching ID tokens) run against the port and the createChatGPTAuth
// of the fixed native-host.js with a fake bridge host, a locally generated RSA test key and its JWKS;
// bridge calls, requests, snapshots, records and errors must be identical. Dummy values only, no network.
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
  ported = await app.load('builtin/core-providers-chatgpt/web/chatgpt-auth.js');
  original = await app.load('native-host.js');
  plugin = await app.load('builtin/core-providers-chatgpt/web/index.js');
});
after(async () => { await app?.remove(); });

const gate = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const outcome = async (promise) => { try { return { ok: await promise }; } catch (e) { return { error: e.name, message: e.message }; } };
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

// ---- locally generated test keys (never real) and a tiny signer used only by the test ----
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const text = (value) => b64u(new TextEncoder().encode(JSON.stringify(value)));
const rsa = async () => crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const good = await rsa();
const evil = await rsa();
const goodJwk = { ...(await crypto.subtle.exportKey('jwk', good.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
const ISSUER = 'https://auth.openai.com';
async function sign(claims, { key = good.privateKey, kid = 'test-key', alg = 'RS256' } = {}) {
  const input = `${text({ alg, typ: 'JWT', kid })}.${text(claims)}`;
  const signature = alg === 'HS256'
    ? new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode('dummy-hmac'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(input)))
    : alg === 'none' ? new Uint8Array() : new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input)));
  return `${input}.${b64u(signature)}`;
}

const HOST_ID = 'urn:uuid:11111111-2222-4333-8444-555555555555';
const REDIRECT = 'http://127.0.0.1:45678/auth/callback';
const CLIENT = 'dummy-client-id';
const IDENTITY = { issuer: ISSUER, subject: 'dummy-subject', clientId: CLIENT, email: 'dummy@example.test' };
const savedTokens = (over = {}) => ({ access: 'dummy-saved-access', refresh: 'dummy-saved-refresh', expires: Date.now() + 3600e3, scopes: ['openid', 'chatgpt.tokens.use.direct'], idToken: 'dummy.saved.id', nonce: 'dummy-nonce', ...over });
const signedIn = (over = {}) => ({ version: 1, identity: IDENTITY, tokens: savedTokens(over) });

/** One fixture: a fake bridge host recording every call and request; secrets are scrubbed in the log. */
function fixture({ saved } = {}) {
  const log = [];
  const state = { record: saved === undefined ? null : structuredClone(saved), opened: gate(), waitMode: 'auto', hostId: HOST_ID, attempts: 0, authorize: undefined,
    token: {}, idMode: 'valid', idOverride: undefined, tokenStatus: 200, tokenGate: undefined, saveGate: undefined, failSave: 0, failClear: false, failFetch: undefined,
    jwks: { keys: [goodJwk] }, discovery: { issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/oauth/revoke` },
    models: { models: [{ slug: 'm1', display_name: 'Model One', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }, { slug: 'm2', visibility: 'list' }, { slug: 'm1', visibility: 'list' }, 5] },
    revokeOk: true, subject: 'dummy-subject', callbackExtra: '', rejectWait: undefined, cancelled: [] };
  const scrub = (value) => JSON.parse(JSON.stringify(value ?? null, (key, v) => {
    if (key === 'nonce' || key === 'state') return '<nonce>';
    if (key === 'expires' && typeof v === 'number') return Math.round(v / 60000);
    if (typeof v !== 'string') return v;
    return v.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<jwt>').replace(/(state|nonce|code_challenge|code_verifier|id_token_hint)=[^&"]+/g, '$1=<x>');
  }));
  const host = {
    async call(method, params = {}) {
      log.push(['call', method, scrub(params)]);
      switch (method) {
        case 'auth.load': return structuredClone(state.record);
        case 'auth.save':
          if (state.saveGate) await state.saveGate.promise;
          if (state.failSave > 0) { state.failSave--; throw new Error('disk dummy-secret'); }
          state.record = structuredClone(params.record); return null;
        case 'auth.clear': if (state.failClear) throw new Error('nope'); state.record = null; return null;
        case 'auth.info': return { hostId: state.hostId };
        case 'auth.listen': state.attempts++; state.state = params.state; return { attemptId: `attempt-${state.attempts}`, redirectUri: state.redirectUri ?? REDIRECT };
        case 'auth.open': state.authorize = new URL(params.url); state.opened.resolve(state.authorize); return null;
        case 'auth.wait': {
          if (state.waitMode === 'hang') return new Promise((_, reject) => { state.rejectWait = reject; });
          const url = new URL(state.waitUrl ?? REDIRECT);
          if (!state.waitUrl) { url.searchParams.set('state', state.state); url.searchParams.set('code', 'dummy-code'); url.searchParams.set('client_id', CLIENT); }
          return { url: url.href + state.callbackExtra };
        }
        case 'auth.cancel': state.cancelled.push(params.attemptId); state.rejectWait?.(new Error('cancelled')); return null;
        default: return null;
      }
    },
    async fetch(input, init) {
      const request = new Request(input, init);
      const body = request.method === 'POST' ? await request.text() : '';
      log.push(['fetch', request.url, request.method, request.redirect, request.headers.get('content-type'), scrub(body), request.headers.get('authorization') ? 'bearer' : '']);
      if (state.failFetch) throw state.failFetch;
      const url = new URL(request.url);
      if (url.pathname === '/.well-known/openid-configuration') return Response.json(state.discovery);
      if (url.pathname === '/.well-known/jwks.json') return Response.json(state.jwks);
      if (url.pathname === '/oauth/revoke') return new Response(null, { status: state.revokeOk ? 200 : 500 });
      if (url.pathname === '/v1/models') return typeof state.models === 'string' ? new Response(state.models) : Response.json(state.models);
      if (url.pathname === '/api/accounts/oauth/token') {
        if (state.tokenGate) await state.tokenGate.promise;
        if (state.tokenStatus !== 200) return new Response('{}', { status: state.tokenStatus });
        const form = new URLSearchParams(body);
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: ISSUER, aud: form.get('client_id'), sub: state.subject, exp: now + 3600, iat: now, email: 'dummy@example.test',
          ...(form.get('grant_type') === 'authorization_code' ? { nonce: state.authorize?.searchParams.get('nonce') } : {}) };
        const modes = {
          valid: () => sign(claims), forged: () => sign(claims, { key: evil.privateKey }), expired: () => sign({ ...claims, exp: now - 600 }),
          wrongAud: () => sign({ ...claims, aud: 'other-client' }), wrongIss: () => sign({ ...claims, iss: 'https://evil.example' }),
          badNonce: () => sign({ ...claims, nonce: 'someone-elses-nonce' }), unknownKid: () => sign(claims, { kid: 'other-key' }),
          hs256: () => sign(claims, { alg: 'HS256' }), none: () => sign(claims, { alg: 'none' }), noSub: () => sign({ ...claims, sub: undefined }),
          azpMismatch: () => sign({ ...claims, azp: 'other-client' }), multiAud: () => sign({ ...claims, aud: [form.get('client_id'), 'x'] }),
          notBefore: () => sign({ ...claims, nbf: now + 3600 }), garbage: async () => 'not-a-jwt', absent: async () => undefined,
        };
        const idToken = state.idOverride ?? await modes[state.idMode]();
        return Response.json({ access_token: 'dummy-access-secret', refresh_token: 'dummy-refresh-secret', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct', token_type: 'Bearer',
          ...(idToken === undefined ? {} : { id_token: idToken }), ...state.token });
      }
      return new Response('?', { status: 404 });
    },
  };
  return { host, state, log };
}

async function scenarios(createChatGPTAuth) {
  const out = [];
  const run = async (label, setup, work) => {
    const f = fixture({ saved: setup });
    const opened = [];
    const auth = createChatGPTAuth({ host: f.host, onOpenUrl: (url) => opened.push(url.replace(/(state|nonce|code_challenge|id_token_hint)=[^&]+/g, '$1=<x>')) });
    const snapshots = [];
    auth.subscribe((s) => snapshots.push(s));
    const result = await work(auth, f);
    await settle();
    out.push([label, { result, snapshots, final: auth.snapshot, log: f.log, opened, record: JSON.parse(JSON.stringify(f.state.record ?? null, (k, v) => k === 'nonce' ? '<n>' : k === 'expires' ? Math.round(v / 60000) : /^eyJ/.test(v) ? '<jwt>' : v)), cancelled: f.state.cancelled }]);
  };
  const login = (opts) => async (a) => outcome(a.login(opts));
  const withState = (patch, opts) => async (a, f) => { Object.assign(f.state, patch); return outcome(a.login(opts)); };

  await run('restore: nothing saved', undefined, async (a) => outcome(a.restore()));
  await run('restore: signed in', signedIn(), async (a) => ({ r: await outcome(a.restore()), token: await outcome(a.getAccessToken()) }));
  await run('restore: identity only', { version: 1, identity: IDENTITY }, async (a) => outcome(a.restore()));
  for (const [label, record] of [['wrong version', { version: 2 }], ['array', []], ['foreign issuer', { version: 1, identity: { ...IDENTITY, issuer: 'https://x.test' } }],
    ['dynamic client', { version: 1, identity: { ...IDENTITY, clientId: 'dynamic_agent_client' } }], ['tokens without identity', { version: 1, tokens: savedTokens() }],
    ['missing direct scope', signedIn({ scopes: ['openid'] })], ['bad expiry', signedIn({ expires: 'soon' })], ['oversized', { version: 1, identity: { ...IDENTITY, email: 'a'.repeat(40000) } }]]) {
    await run(`restore: invalid ${label}`, record, async (a) => outcome(a.restore()));
  }
  await run('sign in (new account)', undefined, login());
  await run('sign in: opened URL is the authorize request', undefined, async (a, f) => {
    const p = a.login(); const url = await f.state.opened.promise; const r = await outcome(p);
    return { r, params: Object.fromEntries([...url.searchParams].filter(([k]) => !['state', 'nonce', 'code_challenge'].includes(k))), base: url.origin + url.pathname, method: url.searchParams.get('code_challenge_method') };
  });
  await run('sign in again as the same account', signedIn({ expires: 1 }), login());
  await run('sign in with newAccount', signedIn(), login({ newAccount: true }));
  await run('switch account (different subject rejected)', signedIn(), withState({ subject: 'another-subject' }));
  await run('switch account explicitly', signedIn(), withState({ subject: 'another-subject' }, { newAccount: true }));
  await run('sign in: different client than the saved one', signedIn(), withState({ waitUrl: `${REDIRECT}?code=c&client_id=other` }));
  for (const mode of ['forged', 'expired', 'wrongAud', 'wrongIss', 'badNonce', 'unknownKid', 'hs256', 'none', 'noSub', 'azpMismatch', 'multiAud', 'notBefore', 'garbage', 'absent']) {
    await run(`sign in rejected: ${mode} ID token`, undefined, withState({ idMode: mode }));
  }
  await run('sign in: forged token signed by the right kid but other key', undefined, async (a, f) => { f.state.jwks = { keys: [{ ...goodJwk, n: (await crypto.subtle.exportKey('jwk', evil.publicKey)).n }] }; f.state.idMode = 'valid'; return outcome(a.login()); });
  await run('sign in: JWKS without keys', undefined, withState({ jwks: {} }));
  await run('sign in: empty JWKS', undefined, withState({ jwks: { keys: [] } }));
  await run('sign in: unexpected issuer in discovery', undefined, withState({ discovery: { issuer: 'https://x.test', jwks_uri: `${ISSUER}/j` } }));
  await run('sign in: foreign JWKS endpoint', undefined, withState({ discovery: { issuer: ISSUER, jwks_uri: 'https://evil.example/jwks' } }));
  await run('sign in: token endpoint 400', undefined, withState({ tokenStatus: 400 }));
  await run('sign in: no plan scope', undefined, withState({ token: { scope: 'openid' } }));
  await run('sign in: incomplete credentials', undefined, withState({ token: { refresh_token: undefined } }));
  await run('sign in: not bearer', undefined, withState({ token: { token_type: 'mac' } }));
  await run('sign in: network failure', undefined, withState({ failFetch: new Error('offline dummy-secret') }));
  await run('sign in: save fails', undefined, withState({ failSave: 1 }));
  await run('sign in: bad host id', undefined, withState({ hostId: 'nope' }));
  await run('sign in: bad redirect URI', undefined, withState({ redirectUri: 'http://evil.example/auth/callback' }));
  for (const [label, waitUrl] of [['wrong state', `${REDIRECT}?state=other&code=c&client_id=${CLIENT}`], ['denied', null], ['no code', null], ['foreign origin', `http://127.0.0.1:1/auth/callback?code=c`], ['dynamic client', `${REDIRECT}?code=c&client_id=dynamic_agent_client`]]) {
    await run(`sign in rejected: callback ${label}`, undefined, async (a, f) => {
      if (waitUrl) f.state.waitUrl = waitUrl;
      else if (label === 'denied') f.state.callbackExtra = '&error=access_denied';
      else { const original = f.host.call; f.host.call = async (m, p) => m === 'auth.wait' ? { url: `${REDIRECT}?state=${f.state.state}&client_id=${CLIENT}` } : original(m, p); }
      return outcome(a.login());
    });
  }
  await run('second login while one is running', undefined, async (a, f) => {
    f.state.waitMode = 'hang';
    const first = a.login(); await f.state.opened.promise;
    const second = await outcome(a.login()); a.cancel();
    return { second, first: await outcome(first) };
  });
  await run('cancel while waiting for the browser', undefined, async (a, f) => {
    f.state.waitMode = 'hang';
    const p = a.login(); await f.state.opened.promise; await settle(); a.cancel();
    return outcome(p);
  });
  await run('cancel during the token request', undefined, async (a, f) => {
    f.state.tokenGate = gate();
    const p = a.login(); await f.state.opened.promise; await settle(); a.cancel(); f.state.tokenGate.resolve();
    return outcome(p);
  });
  await run('cancel during the save restores the previous record', signedIn(), async (a, f) => {
    await a.restore(); f.state.saveGate = gate();
    const p = a.login(); await f.state.opened.promise; await settle(); await settle(); a.cancel(); f.state.saveGate.resolve();
    return outcome(p);
  });
  await run('cancel with nothing running', undefined, async (a) => { a.cancel(); return 'ok'; });
  await run('expired token is refreshed (no id_token)', signedIn({ expires: 1 }), async (a, f) => { f.state.idMode = 'absent'; return { t1: await outcome(a.getAccessToken()), t2: await outcome(a.getAccessToken()) }; });
  await run('expired token is refreshed with a valid id_token', signedIn({ expires: 1 }), async (a) => outcome(a.getAccessToken()));
  for (const mode of ['forged', 'expired', 'wrongAud', 'garbage']) {
    await run(`refresh rejected: ${mode} ID token`, signedIn({ expires: 1 }), async (a, f) => { f.state.idMode = mode; return outcome(a.getAccessToken()); });
  }
  await run('refresh returns another account', signedIn({ expires: 1 }), async (a, f) => { f.state.subject = 'someone-else'; return outcome(a.getAccessToken()); });
  await run('refresh rejected by the server', signedIn({ expires: 1 }), async (a, f) => { f.state.tokenStatus = 401; return outcome(a.getAccessToken()); });
  await run('refresh while signed out', undefined, async (a) => outcome(a.getAccessToken()));
  await run('getAccessToken with an aborted signal', signedIn(), async (a) => outcome(a.getAccessToken(AbortSignal.abort())));
  await run('concurrent refreshes are serialised', signedIn({ expires: 1 }), async (a, f) => {
    f.state.tokenGate = gate();
    const both = Promise.all([outcome(a.getAccessToken()), outcome(a.getAccessToken())]);
    await settle(); f.state.tokenGate.resolve(); return both;
  });
  await run('list models', signedIn(), async (a) => outcome(a.listModels()));
  await run('list models: invalid list', signedIn(), async (a, f) => { f.state.models = { models: 'x' }; return outcome(a.listModels()); });
  await run('list models: signed out', undefined, async (a) => outcome(a.listModels()));
  await run('sign out (revokes)', signedIn(), async (a) => ({ restore: await outcome(a.restore()), logout: await outcome(a.logout()), token: await outcome(a.getAccessToken()) }));
  await run('sign out: revocation fails', signedIn(), async (a, f) => { f.state.revokeOk = false; return outcome(a.logout()); });
  await run('sign out: no revocation endpoint', signedIn(), async (a, f) => { f.state.discovery = { issuer: ISSUER, jwks_uri: `${ISSUER}/j` }; return outcome(a.logout()); });
  await run('sign out when not signed in', undefined, async (a) => outcome(a.logout()));
  await run('sign out with a corrupt record', { version: 9 }, async (a) => outcome(a.logout()));
  await run('sign out: save fails, clear used', signedIn(), async (a, f) => { f.state.failSave = 1; return outcome(a.logout()); });
  await run('sign out: save and clear fail', signedIn(), async (a, f) => { f.state.failSave = 1; f.state.failClear = true; return outcome(a.logout()); });
  await run('sign out cancels a running sign-in', undefined, async (a, f) => {
    f.state.waitMode = 'hang';
    const p = a.login(); await f.state.opened.promise; await settle();
    const logout = await outcome(a.logout()); return { logout, login: await outcome(p) };
  });
  await run('listener errors and unsubscribe', undefined, async (a) => {
    let calls = 0;
    const off = a.subscribe(() => { if (calls++) throw new Error('observer'); });
    const restored = await outcome(a.restore()); off(); await outcome(a.restore());
    return { restored, calls };
  });
  return out;
}

test('ported ChatGPT sign-in and the compiled one behave identically', { skip }, async () => {
  const left = await scenarios(ported.createChatGPTAuth);
  const right = await scenarios(original.createChatGPTAuth);
  assert.ok(left.length >= 70, `${left.length} scenarios`);
  assert.deepEqual(left.map(([l]) => l), right.map(([l]) => l));
  for (let i = 0; i < left.length; i++) { const a = JSON.stringify(left[i]), b = JSON.stringify(right[i]); if (a !== b) { let k = 0; while (a[k] === b[k]) k++; assert.fail(`${left[i][0]}\n port: ...${a.slice(Math.max(0, k - 150), k + 250)}\n orig: ...${b.slice(Math.max(0, k - 150), k + 250)}`); } }
  const by = (label) => left.find(([l]) => l === label)[1];
  assert.equal(by('sign in (new account)').result.ok, undefined);
  assert.equal(by('sign in (new account)').final.signedIn, true);
  assert.equal(by('sign in (new account)').record.identity.subject, 'dummy-subject');
  assert.equal(by('sign in again as the same account').final.signedIn, true);
  assert.equal(by('switch account explicitly').record.identity.subject, 'another-subject');
  assert.equal(by('switch account (different subject rejected)').result.message, 'ChatGPT returned a different account. Choose a new account explicitly.');
  assert.equal(by('sign in: opened URL is the authorize request').result.method, 'S256');
  assert.equal(by('sign out (revokes)').final.signedIn, false);
  assert.equal(by('sign out (revokes)').result.logout.ok.revoked, true);
  assert.equal(by('refresh rejected by the server').final.signedIn, true);
  assert.equal(by('list models').result.ok.length, 2);
  // Every bad ID token is rejected, identically, and nothing is stored.
  for (const mode of ['forged', 'expired', 'wrongAud', 'wrongIss', 'badNonce', 'unknownKid', 'hs256', 'none', 'noSub', 'azpMismatch', 'multiAud', 'notBefore', 'garbage']) {
    const s = by(`sign in rejected: ${mode} ID token`);
    assert.equal(s.result.error !== undefined, true, mode);
    assert.equal(s.final.signedIn, false, mode);
    assert.equal(s.record, null, mode);
  }
  assert.equal(by('sign in rejected: forged ID token').result.message, 'ChatGPT identity verification failed.');
  assert.equal(by('sign in rejected: expired ID token').result.message, 'ChatGPT identity verification failed.');
  assert.equal(by('refresh rejected: forged ID token').result.error, 'Error');
});

test('credentials never appear in snapshots, errors or console output', { skip }, async () => {
  const seen = [];
  const spies = ['log', 'error', 'warn', 'info', 'debug'].map((name) => { const old = console[name]; console[name] = (...args) => seen.push(args); return () => { console[name] = old; }; });
  try {
    for (const create of [ported.createChatGPTAuth]) {
      const f = fixture();
      const auth = create({ host: f.host });
      const snapshots = [];
      auth.subscribe((s) => snapshots.push(JSON.stringify(s)));
      await auth.login();
      const refresh = fixture({ saved: signedIn({ expires: 1, access: 'dummy-access-secret', refresh: 'dummy-refresh-secret' }) });
      refresh.state.tokenStatus = 500;
      const bad = await outcome(create({ host: refresh.host }).getAccessToken());
      const rejected = fixture(); rejected.state.idMode = 'forged';
      const forged = await outcome(create({ host: rejected.host }).login());
      assert.doesNotMatch(JSON.stringify([snapshots, bad, forged, seen]), /dummy-access-secret|dummy-refresh-secret|eyJ/);
    }
  } finally { spies.forEach((restore) => restore()); }
});

test('fallback: native-host.js createChatGPTAuth is used only when chatgpt-auth.js cannot load', { skip }, async () => {
  const errors = [];
  const old = console.error; console.error = (...args) => errors.push(args);
  try {
    assert.equal(await plugin.loadChatGPTAuth({ load: () => Promise.reject(new Error('broken')) }), original.createChatGPTAuth);
    assert.equal(await plugin.loadChatGPTAuth({ load: async () => ({}) }), original.createChatGPTAuth);
  } finally { console.error = old; }
  assert.equal(errors.length, 2);
  assert.equal(await plugin.loadChatGPTAuth(), ported.createChatGPTAuth);
});

test('sources: plain JavaScript on the vendored jose, no static native-host.js import, app.js uses the plugin', async () => {
  const dir = new URL('../plugins/core-providers-chatgpt/web/', import.meta.url);
  const source = await readFile(new URL('chatgpt-auth.js', dir), 'utf8');
  assert.deepEqual(source.match(/^import .*$/gm), ['import { createLocalJWKSet, jwtVerify } from "./lib/jose/index.js";']);
  assert.doesNotMatch(source, /^import type|\bimplements\b|\breadonly\b|<T>|\bas const\b|: Promise<|\bas unknown\b/m);
  assert.doesNotMatch(source, /importKey|subtle\.verify|RSASSA/); // no verifier of our own
  const version = JSON.parse(await readFile(new URL('lib/jose/../../../../../node_modules/jose/package.json', dir), 'utf8').catch(() => '{"version":"6.2.12"}')).version;
  assert.equal(version, '6.2.12');
  assert.match(await readFile(new URL('lib/jose/VERSION.md', dir), 'utf8'), /jose 6\.2\.12/);
  assert.match(await readFile(new URL('../../../third-party/jose.LICENSE', dir), 'utf8'), /MIT License/);
  assert.ok((await readdir(new URL('lib/jose/', dir))).includes('index.js'));
  const appSource = await readFile(new URL('../apps/common/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(appSource, /import \{[^}]*createChatGPTAuth/);
  assert.match(appSource, /coreChatGPT\.loadChatGPTAuth\(\)/);
});
