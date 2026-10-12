import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeAuth } from '../packages/native-host/src/claude-auth.ts';
import type { ChatGPTHost } from '../packages/native-host/src/auth.ts';
import { deferred as gate } from './bridge-support.ts';

function fixture() {
  const records = new Map<string, unknown>([['chatgpt', { untouched: 'dummy-chatgpt-record' }]]);
  const state = { opened: gate<URL>(), requests: [] as Record<string, string>[], saved: [] as unknown[],
    status: 200, response: undefined as unknown, tokenGate: undefined as ReturnType<typeof gate<void>> | undefined,
    tokenStarted: gate<void>(), saveGate: undefined as ReturnType<typeof gate<void>> | undefined, saveStarted: gate<void>() };
  const host: ChatGPTHost = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      assert.equal(params.provider, 'claude');
      let result: unknown = null;
      if (method === 'auth.load') result = structuredClone(records.get('claude') ?? null);
      else if (method === 'auth.save') {
        state.saved.push(structuredClone(params.record)); records.set('claude', structuredClone(params.record));
        state.saveStarted.resolve(); if (state.saveGate) await state.saveGate.promise;
      } else if (method === 'auth.clear') records.delete('claude');
      else if (method === 'auth.openExternal') state.opened.resolve(new URL(String(params.url)));
      else assert.fail(`Unexpected operation ${method}`);
      return result as T;
    },
    async fetch(input, init) {
      const request = new Request(input, init);
      assert.equal(request.url, 'https://platform.claude.com/v1/oauth/token');
      assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'omit');
      assert.equal(request.headers.get('content-type'), 'application/json');
      const body = JSON.parse(await request.text()); state.requests.push(body); state.tokenStarted.resolve();
      assert.equal(body.client_id, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
      if (body.grant_type === 'authorization_code') {
        const url = await state.opened.promise;
        assert.equal(body.redirect_uri, 'https://platform.claude.com/oauth/code/callback');
        assert.equal(body.state, url.searchParams.get('state'));
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.code_verifier));
        assert.equal(Buffer.from(digest).toString('base64url'), url.searchParams.get('code_challenge'));
      }
      if (state.tokenGate) await state.tokenGate.promise;
      return Response.json(state.response ?? { access_token: 'dummy-access-secret', refresh_token: 'dummy-refresh-secret', expires_in: 3600, token_type: 'bearer' }, { status: state.status });
    },
  };
  return { state, records, host };
}
async function signIn(auth: ReturnType<typeof createClaudeAuth>, f: ReturnType<typeof fixture>, code?: (url: URL) => string) {
  const login = auth.login(); const url = await f.state.opened.promise;
  assert.equal(auth.snapshot.awaitingCode, true);
  assert.equal(auth.submitCode(code?.(url) ?? `dummy-code#${url.searchParams.get('state')}`), true);
  await login;
  return url;
}

test('Claude copy-code sign-in follows pinned PKCE protocol and stores credentials independently', async () => {
  const f = fixture(); const opened: string[] = []; const snapshots: unknown[] = [];
  const auth = createClaudeAuth({ host: f.host, onOpenUrl: url => opened.push(url) });
  auth.subscribe(value => snapshots.push(value)); await auth.restore();
  const url = await signIn(auth, f);
  assert.equal(url.origin + url.pathname, 'https://claude.ai/oauth/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload');
  assert.equal(opened.length, 1); assert.equal(auth.snapshot.signedIn, true); assert.equal(auth.snapshot.awaitingCode, false);
  assert.equal(auth.snapshot.busy, false); assert.equal(await auth.getAccessToken(), 'dummy-access-secret');
  assert.equal(JSON.stringify(snapshots).includes('dummy-access-secret'), false);
  assert.equal(JSON.stringify(snapshots).includes('dummy-refresh-secret'), false);
  assert.deepEqual(f.records.get('chatgpt'), { untouched: 'dummy-chatgpt-record' });
  const restored = createClaudeAuth({ host: f.host }); await restored.restore();
  assert.equal(await restored.getAccessToken(), 'dummy-access-secret'); assert.equal(f.state.requests.length, 1);
  assert.deepEqual(await restored.logout(), { revoked: false }); assert.equal(f.records.has('claude'), false);
  assert.deepEqual(f.records.get('chatgpt'), { untouched: 'dummy-chatgpt-record' });
});

test('Claude token parsing accepts additional response metadata beyond the credential storage size', async () => {
  const f = fixture();
  f.state.response = { access_token: 'dummy-access-secret', refresh_token: 'dummy-refresh-secret', expires_in: 3600,
    metadata: { supported_features: Array.from({ length: 4096 }, (_, index) => `fixture-feature-${index}`) } };
  assert.ok(new TextEncoder().encode(JSON.stringify(f.state.response)).byteLength > 64 * 1024);
  const auth = createClaudeAuth({ host: f.host });
  await signIn(auth, f);
  assert.equal(await auth.getAccessToken(), 'dummy-access-secret');
  const record = f.records.get('claude') as Record<string, unknown>;
  assert.equal(record.metadata, undefined);
  assert.ok(new TextEncoder().encode(JSON.stringify(record)).byteLength < 64 * 1024);
});

test('Claude code validation rejects wrong state and callback destinations before exchanging secrets', async t => {
  for (const value of ['dummy-code#wrong-state', 'https://attacker.invalid/callback?code=dummy-code', 'code=dummy&code=duplicate', '']) {
    await t.test(value || 'empty', async () => {
      const f = fixture(); const auth = createClaudeAuth({ host: f.host });
      await assert.rejects(signIn(auth, f, () => value));
      assert.equal(f.state.requests.length, 0); assert.equal(f.records.has('claude'), false);
      assert.equal(auth.snapshot.busy, false); assert.equal(auth.snapshot.awaitingCode, false);
    });
  }
  const f = fixture(); const auth = createClaudeAuth({ host: f.host });
  await signIn(auth, f, () => 'dummy-code'); // Upstream accepts a bare code and retains the original state.
  assert.equal(auth.snapshot.signedIn, true);
});

test('Claude cancellation unblocks code entry and a cancelled durable save rolls credentials back', async () => {
  const first = fixture(); const pendingAuth = createClaudeAuth({ host: first.host });
  const login = pendingAuth.login(); const rejected = assert.rejects(login, { name: 'AbortError' });
  await first.state.opened.promise; pendingAuth.cancel(); await rejected;
  assert.equal(pendingAuth.submitCode('dummy-code'), false); assert.equal(first.state.requests.length, 0);

  const f = fixture(); f.state.saveGate = gate<void>();
  const auth = createClaudeAuth({ host: f.host });
  const attempt = signIn(auth, f); const stopped = assert.rejects(attempt, { name: 'AbortError' });
  await f.state.saveStarted.promise; auth.cancel(); f.state.saveGate.resolve(); await stopped;
  assert.equal(auth.snapshot.signedIn, false);
  assert.deepEqual(f.records.get('claude'), { version: 1, provider: 'claude' });
});

test('Claude refresh is serialized and persists rotation after the requesting model call is cancelled', async () => {
  const f = fixture(); f.records.set('claude', { version: 1, provider: 'claude', tokens: { access: 'dummy-old', refresh: 'dummy-old-refresh', expires: 0 } });
  f.state.tokenGate = gate<void>(); f.state.response = { access_token: 'dummy-new', refresh_token: 'dummy-new-refresh', expires_in: 3600 };
  const auth = createClaudeAuth({ host: f.host }); const cancel = new AbortController();
  const first = assert.rejects(auth.getAccessToken(cancel.signal), { name: 'AbortError' });
  await f.state.tokenStarted.promise; const second = auth.getAccessToken(); cancel.abort(); await first;
  f.state.tokenGate.resolve(); assert.equal(await second, 'dummy-new'); assert.equal(f.state.requests.length, 1);
  assert.equal(f.state.requests[0].grant_type, 'refresh_token');
  assert.equal((f.records.get('claude') as any).tokens.refresh, 'dummy-new-refresh');
});

test('Claude errors and corrupt persisted records never expose returned secrets', async () => {
  const f = fixture(); f.state.status = 400; f.state.response = { error: 'dummy-access-secret dummy-refresh-secret' };
  const auth = createClaudeAuth({ host: f.host }); await assert.rejects(signIn(auth, f), /400/);
  assert.equal(JSON.stringify(auth.snapshot).includes('dummy-'), false); assert.equal(f.records.has('claude'), false);
  f.records.set('claude', { version: 1, provider: 'chatgpt', tokens: { access: 'dummy-secret' } });
  const restored = createClaudeAuth({ host: f.host }); await assert.rejects(restored.restore(), /invalid/);
  await restored.logout(); assert.equal(f.records.has('claude'), false);
});
