import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import type { ChatGPTHost } from '../packages/native-host/src/auth.ts';
import { bytesToBase64 } from '../packages/native-host/src/wire.ts';

const keyPair = generateKeyPair('RS256', { extractable: true });
export const AUTH_ORIGIN = 'https://auth.openai.com';
export const DIRECT_SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export function gate() {
  let resolve!: (value?: void) => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

export function authFixture() {
  const state = {
    saved: null as any,
    authorization: undefined as URL | undefined,
    listener: undefined as { attemptId: string; redirectUri: string; state: string } | undefined,
    clientId: 'oaiapp_test_client', subject: 'user_test', sequence: 0, tokenCalls: 0, refreshCalls: 0,
    cancelled: [] as string[], savedRecords: [] as any[], fetched: [] as string[], revoked: [] as URLSearchParams[],
    callback: undefined as ((url: URL) => URL) | undefined,
    claims: {} as JWTPayload,
    corruptSignature: false,
    scope: DIRECT_SCOPE,
    jwksUrl: `${AUTH_ORIGIN}/.well-known/jwks.json`,
    revokeStatus: 200,
    tokenStatus: 200,
    omitCallbackClient: false,
    saveFailure: false,
    waitGate: undefined as ReturnType<typeof gate> | undefined,
    waitStarted: gate(),
    refreshGate: undefined as ReturnType<typeof gate> | undefined,
    refreshStarted: gate(),
    saveGate: undefined as ReturnType<typeof gate> | undefined,
    saveStarted: gate(),
  };
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const host: ChatGPTHost = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      let value: unknown = null;
      if (method === 'auth.info') value = { hostId: 'urn:uuid:cf505977-a72c-4b09-a9b8-ad98f3f25f3f', storage: 'memory' };
      else if (method === 'auth.load') value = structuredClone(state.saved);
      else if (method === 'auth.save') {
        state.saveStarted.resolve();
        if (state.saveGate) await state.saveGate.promise;
        if (state.saveFailure) throw new Error('host error containing mock-access-secret');
        state.saved = structuredClone(params.record);
        state.savedRecords.push(structuredClone(params.record));
      } else if (method === 'auth.clear') state.saved = null;
      else if (method === 'auth.listen') {
        state.listener = { attemptId: `attempt-${++state.sequence}`, redirectUri: `http://127.0.0.1:${48000 + state.sequence}/auth/callback`, state: String(params.state) };
        value = state.listener;
      } else if (method === 'auth.open') state.authorization = new URL(String(params.url));
      else if (method === 'auth.wait') {
        state.waitStarted.resolve();
        if (state.waitGate) await state.waitGate.promise;
        const callback = new URL(state.listener!.redirectUri);
        callback.searchParams.set('code', 'mock-single-use-code');
        callback.searchParams.set('state', state.listener!.state);
        if (!state.omitCallbackClient) callback.searchParams.set('client_id', state.clientId);
        value = { url: (state.callback?.(callback) ?? callback).href };
      } else if (method === 'auth.cancel') state.cancelled.push(String(params.attemptId));
      else throw new Error(`Unexpected host method ${method}`);
      return value as T;
    },
    async fetch(input, init) {
      const request = new Request(input, init);
      state.fetched.push(request.url);
      if (request.url === `${AUTH_ORIGIN}/.well-known/openid-configuration`) {
        return reply({ issuer: AUTH_ORIGIN, jwks_uri: state.jwksUrl, revocation_endpoint: `${AUTH_ORIGIN}/api/accounts/oauth/revoke` });
      }
      if (request.url === `${AUTH_ORIGIN}/.well-known/jwks.json`) {
        return reply({ keys: [{ ...await exportJWK((await keyPair).publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }] });
      }
      if (request.url === `${AUTH_ORIGIN}/api/accounts/oauth/revoke`) {
        state.revoked.push(new URLSearchParams(await request.text()));
        return reply({}, state.revokeStatus);
      }
      if (request.url === 'https://api.openai.com/v1/models') {
        assert.match(request.headers.get('authorization') ?? '', /^Bearer mock-/);
        return reply({ models: [
          { slug: 'gpt-account', display_name: 'Account model', visibility: 'list' },
          { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
          { slug: 'fallback-name', visibility: 'list' },
        ] });
      }
      assert.equal(request.url, `${AUTH_ORIGIN}/api/accounts/oauth/token`);
      state.tokenCalls++;
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get('resource'), 'https://api.openai.com/v1');
      assert.equal(body.get('client_id'), state.clientId);
      if (state.tokenStatus !== 200) return reply({ error: 'mock-access-secret mock-refresh-secret' }, state.tokenStatus);
      if (body.get('grant_type') === 'refresh_token') {
        state.refreshCalls++;
        state.refreshStarted.resolve();
        if (state.refreshGate) await state.refreshGate.promise;
        return reply({ access_token: 'mock-rotated-access', refresh_token: 'mock-rotated-refresh', expires_in: 3600, scope: state.scope, token_type: 'Bearer' });
      }
      assert.equal(body.get('redirect_uri'), state.authorization!.searchParams.get('redirect_uri'));
      assert.equal(body.get('code'), 'mock-single-use-code');
      const challenge = bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')!))))
        .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      assert.equal(challenge, state.authorization!.searchParams.get('code_challenge'));
      const payload: JWTPayload = { iss: AUTH_ORIGIN, aud: state.clientId, sub: state.subject,
        exp: Math.floor(Date.now() / 1000) + 3600, nonce: state.authorization!.searchParams.get('nonce'), email: 'person@example.test', ...state.claims };
      let idToken = await new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign((await keyPair).privateKey);
      if (state.corruptSignature) {
        const parts = idToken.split('.');
        parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
        idToken = parts.join('.');
      }
      return reply({ access_token: 'mock-access-secret', refresh_token: 'mock-refresh-secret', id_token: idToken,
        token_type: 'Bearer', expires_in: 3600, scope: state.scope });
    },
  };
  return { state, host };
}
