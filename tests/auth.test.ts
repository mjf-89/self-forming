import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JWTPayload } from 'jose';
import { createChatGPTAuth } from '../packages/native-host/src/auth.ts';
import { authFixture, gate } from './auth-support.ts';

test('ChatGPT login verifies RS256 identity, PKCE, direct scope and account model availability', async () => {
  const { state, host } = authFixture();
  const opened: string[] = [];
  const auth = createChatGPTAuth({ host, onOpenUrl: (url) => opened.push(url) });
  const snapshots: unknown[] = [];
  auth.subscribe((snapshot) => snapshots.push(snapshot));
  await auth.restore();
  await auth.login();
  const url = new URL(opened[0]);
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), 'Self Forming');
  assert.equal(url.searchParams.get('ext_agent_host_id'), 'urn:uuid:cf505977-a72c-4b09-a9b8-ad98f3f25f3f');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.snapshot.signedIn, true);
  assert.equal(auth.snapshot.email, 'person@example.test');
  assert.equal(auth.snapshot.busy, false);
  assert.equal(await auth.getAccessToken(), 'mock-access-secret');
  assert.equal(state.saved.identity.subject, 'user_test');
  assert.equal(state.saved.identity.clientId, 'oaiapp_test_client');
  assert.equal(state.cancelled.length, 1);
  assert.equal(JSON.stringify(snapshots).includes('mock-access-secret'), false);
  assert.equal(JSON.stringify(snapshots).includes('mock-refresh-secret'), false);
  assert.equal(JSON.stringify(snapshots).includes(state.saved.tokens.idToken), false);
  assert.deepEqual(await auth.listModels(), [{ id: 'gpt-account', name: 'Account model' }, { id: 'fallback-name', name: 'fallback-name' }]);
  const restored = createChatGPTAuth({ host });
  await restored.restore();
  assert.equal(restored.snapshot.signedIn, true);
  assert.equal(await restored.getAccessToken(), 'mock-access-secret');
  assert.equal(state.tokenCalls, 1);
});

test('ChatGPT model discovery accepts a valid catalog larger than 1 MiB', async () => {
  const { host } = authFixture();
  const original = host.fetch.bind(host);
  const models = Array.from({ length: 8192 }, (_, index) => ({
    slug: `generated-model-${index}`,
    display_name: `Generated model ${index} for local code editing, repository maintenance and general assistance`,
    visibility: 'list',
  }));
  const body = JSON.stringify({ models });
  assert.ok(new TextEncoder().encode(body).byteLength > 1024 * 1024);
  host.fetch = async (input, init) => new Request(input, init).url === 'https://api.openai.com/v1/models'
    ? new Response(body, { headers: { 'content-type': 'application/json' } }) : original(input, init);
  const auth = createChatGPTAuth({ host });
  await auth.login();
  const available = await auth.listModels();
  assert.equal(available.length, models.length);
  for (const index of [0, models.length - 1])
    assert.deepEqual(available[index], { id: models[index].slug, name: models[index].display_name });
});

test('invalid callback states, locations and missing client IDs never reach token exchange', async (t) => {
  for (const [name, change] of [
    ['state', (url: URL) => { url.searchParams.set('state', 'other-attempt'); return url; }],
    ['origin', (url: URL) => { url.hostname = 'localhost'; return url; }],
    ['client', (url: URL) => { url.searchParams.delete('client_id'); return url; }],
    ['denied', (url: URL) => { url.searchParams.set('error', 'access_denied'); return url; }],
  ] as const) await t.test(name, async () => {
    const { state, host } = authFixture();
    state.callback = change;
    const auth = createChatGPTAuth({ host });
    await assert.rejects(auth.login());
    assert.equal(state.tokenCalls, 0);
    assert.equal(state.saved, null);
    assert.equal(auth.snapshot.signedIn, false);
    assert.equal(state.cancelled.length, 1);
  });
});

test('signature, issuer, audience, expiration, nonce and subject are checked before credentials are saved', async (t) => {
  for (const [name, claims] of [
    ['issuer', { iss: 'https://untrusted.example' }], ['audience', { aud: 'other-client' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 60 }], ['nonce', { nonce: 'wrong-nonce' }],
    ['missing nonce', { nonce: undefined }], ['subject', { sub: '' }],
    ['multiple audiences require azp', { aud: ['oaiapp_test_client', 'other-client'] }],
  ] as [string, JWTPayload][]) await t.test(name, async () => {
    const { state, host } = authFixture();
    state.claims = claims;
    const auth = createChatGPTAuth({ host });
    await assert.rejects(auth.login(), /identity verification failed/);
    assert.equal(state.saved, null);
    assert.equal(auth.snapshot.signedIn, false);
  });
  const { state, host } = authFixture();
  state.corruptSignature = true;
  await assert.rejects(createChatGPTAuth({ host }).login(), /identity verification failed/);
  assert.equal(state.saved, null);
});

test('discovery cannot redirect key lookup off the trusted OpenAI origin; direct scope is mandatory', async () => {
  const foreign = authFixture();
  foreign.state.jwksUrl = 'https://untrusted.example/jwks';
  await assert.rejects(createChatGPTAuth({ host: foreign.host }).login(), /invalid sign-in configuration/);
  assert.equal(foreign.state.fetched.some((url) => url.includes('untrusted')), false);
  const scoped = authFixture();
  scoped.state.scope = 'openid profile email';
  await assert.rejects(createChatGPTAuth({ host: scoped.host }).login(), /plan access was not granted/);
  assert.equal(scoped.state.saved, null);
});

test('reauthorization reuses verified client mapping and rejects identity or client changes', async () => {
  const { state, host } = authFixture();
  const auth = createChatGPTAuth({ host });
  await auth.login();
  const previousIdToken = state.saved.tokens.idToken;
  state.omitCallbackClient = true;
  await auth.login();
  assert.equal(state.authorization!.searchParams.get('client_id'), state.clientId);
  assert.equal(state.authorization!.searchParams.has('agent_name_hint'), false);
  assert.equal(state.authorization!.searchParams.get('id_token_hint'), previousIdToken);
  const previous = structuredClone(state.saved);
  state.subject = 'different-user';
  await assert.rejects(auth.login(), /different account/);
  assert.deepEqual(state.saved, previous);
  state.subject = 'user_test';
  state.omitCallbackClient = false;
  state.callback = (url) => { url.searchParams.set('client_id', 'different-client'); return url; };
  await assert.rejects(auth.login(), /invalid registration/);
  assert.deepEqual(state.saved, previous);
  state.callback = undefined;
  state.clientId = 'oaiapp_new_account'; state.subject = 'another-user';
  await auth.login({ newAccount: true });
  assert.equal(state.authorization!.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(state.authorization!.searchParams.has('id_token_hint'), false);
  assert.equal(state.saved.identity.subject, 'another-user');
});

test('logout removes every token, revokes the newest refresh token and retains non-secret identity mapping', async () => {
  const { state, host } = authFixture();
  const auth = createChatGPTAuth({ host });
  await auth.login();
  assert.deepEqual(await auth.logout(), { revoked: true });
  assert.equal(state.saved.tokens, undefined);
  assert.equal(state.saved.identity.clientId, state.clientId);
  assert.equal(state.revoked[0].get('token'), 'mock-refresh-secret');
  assert.equal(state.revoked[0].get('token_type_hint'), 'refresh_token');
  assert.equal(auth.snapshot.signedIn, false);
  await assert.rejects(auth.getAccessToken(), /Sign in with ChatGPT/);
  await auth.login();
  assert.equal(state.authorization!.searchParams.get('client_id'), state.clientId);
  assert.equal(state.authorization!.searchParams.has('id_token_hint'), false);
  state.revokeStatus = 503;
  assert.deepEqual(await auth.logout(), { revoked: false });
  assert.equal(state.saved.tokens, undefined);
});

test('concurrent refresh is serialized and caller cancellation never discards a rotated token', async () => {
  const { state, host } = authFixture();
  await createChatGPTAuth({ host }).login();
  state.saved.tokens.expires = 0;
  const auth = createChatGPTAuth({ host });
  state.refreshGate = gate();
  const abort = new AbortController();
  const first = assert.rejects(auth.getAccessToken(abort.signal), { name: 'AbortError' });
  await state.refreshStarted.promise;
  const second = auth.getAccessToken();
  abort.abort(); await first;
  state.refreshGate.resolve();
  assert.equal(await second, 'mock-rotated-access');
  assert.equal(state.refreshCalls, 1);
  assert.equal(state.saved.tokens.refresh, 'mock-rotated-refresh');
});

test('logout waits for an active rotation and no late refresh can resurrect saved tokens', async () => {
  const { state, host } = authFixture();
  await createChatGPTAuth({ host }).login();
  state.saved.tokens.expires = 0;
  const auth = createChatGPTAuth({ host });
  state.refreshGate = gate();
  const refresh = auth.getAccessToken();
  await state.refreshStarted.promise;
  const logout = auth.logout();
  state.refreshGate.resolve();
  await refresh;
  assert.deepEqual(await logout, { revoked: true });
  assert.equal(state.revoked[0].get('token'), 'mock-rotated-refresh');
  assert.equal(state.saved.tokens, undefined);
  assert.equal(auth.snapshot.signedIn, false);
});

test('cancelled login rejects promptly, cancels its listener and ignores a late callback', async () => {
  const { state, host } = authFixture();
  const auth = createChatGPTAuth({ host });
  state.waitGate = gate();
  const login = assert.rejects(auth.login(), { name: 'AbortError' });
  await state.waitStarted.promise;
  auth.cancel();
  await login;
  assert.ok(state.cancelled.includes('attempt-1'));
  state.waitGate.resolve();
  await Promise.resolve();
  assert.equal(state.tokenCalls, 0);
  assert.equal(state.saved, null);
  assert.equal(auth.snapshot.busy, false);
});

test('a retry cannot overtake native callback cleanup after cancellation', async () => {
  const { state, host } = authFixture();
  const original = host.call.bind(host);
  const cleanupStarted = gate();
  const cleanupDone = gate();
  host.call = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    if (method === 'auth.cancel') { cleanupStarted.resolve(); await cleanupDone.promise; }
    return original<T>(method, params);
  };
  const auth = createChatGPTAuth({ host });
  state.waitGate = gate();
  let settled = false;
  const login = assert.rejects(auth.login(), { name: 'AbortError' }).then(() => { settled = true; });
  await state.waitStarted.promise;
  auth.cancel();
  await cleanupStarted.promise;
  await assert.rejects(auth.login(), /already in progress/);
  assert.equal(settled, false);
  cleanupDone.resolve();
  await login;
  state.waitGate.resolve(); state.waitGate = undefined;
  await auth.login();
  assert.equal(auth.snapshot.signedIn, true);
  assert.equal(state.sequence, 2);
});

test('expiry already includes the safety margin, without a second premature refresh window', async () => {
  const { state, host } = authFixture();
  await createChatGPTAuth({ host }).login();
  state.saved.tokens.expires = Date.now() + 120000;
  const auth = createChatGPTAuth({ host });
  assert.equal(await auth.getAccessToken(), 'mock-access-secret');
  assert.equal(state.refreshCalls, 0);
});

test('cancellation during saving restores the previous account instead of leaving a new session', async () => {
  const { state, host } = authFixture();
  const auth = createChatGPTAuth({ host });
  await auth.login();
  const previous = structuredClone(state.saved);
  state.clientId = 'oaiapp_new_account'; state.subject = 'another-user';
  state.saveGate = gate(); state.saveStarted = gate();
  const login = assert.rejects(auth.login({ newAccount: true }), { name: 'AbortError' });
  await state.saveStarted.promise;
  auth.cancel();
  state.saveGate.resolve();
  await login;
  assert.deepEqual(state.saved, previous);
  assert.equal(await auth.getAccessToken(), previous.tokens.access);
});

test('server and storage errors are sanitized and failed writes never mark login successful', async () => {
  const denied = authFixture();
  denied.state.tokenStatus = 400;
  const auth = createChatGPTAuth({ host: denied.host });
  await assert.rejects(auth.login(), (error: unknown) => error instanceof Error && !error.message.includes('mock-') && error.message.includes('(400)'));
  assert.equal(JSON.stringify(auth.snapshot).includes('mock-'), false);
  const broken = authFixture();
  broken.state.saveFailure = true;
  const second = createChatGPTAuth({ host: broken.host });
  await assert.rejects(second.login(), /could not be completed/);
  assert.equal(broken.state.saved, null);
  assert.equal(second.snapshot.signedIn, false);
});
