import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { bytesToBase64, isRecord } from './wire.ts';

// Protocol adapted from Pi 1.0.4 auth/oauth/openai-chatgpt.ts (MIT). Platform
// callbacks use our host bridge; ID-token checks follow OpenAI's SIWC docs.
const ISSUER = 'https://auth.openai.com';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const RESOURCE = 'https://api.openai.com/v1';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const MAX_RECORD_BYTES = 64 * 1024;

export interface ChatGPTModel { id: string; name: string }
export interface ChatGPTAuthSnapshot { signedIn: boolean; busy: boolean; email?: string; message?: string }
export interface ChatGPTHost {
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  fetch: typeof fetch;
}
export interface ChatGPTAuth {
  readonly snapshot: ChatGPTAuthSnapshot;
  subscribe(listener: (snapshot: ChatGPTAuthSnapshot) => void): () => void;
  restore(): Promise<void>;
  login(options?: { newAccount?: boolean }): Promise<void>;
  cancel(): void;
  logout(): Promise<{ revoked: boolean }>;
  getAccessToken(signal?: AbortSignal): Promise<string>;
  listModels(signal?: AbortSignal): Promise<ChatGPTModel[]>;
}

interface Identity { issuer: typeof ISSUER; subject: string; clientId: string; email?: string }
interface Tokens { access: string; refresh: string; expires: number; scopes: string[]; idToken: string; nonce: string }
interface SavedRecord { version: 1; identity?: Identity; tokens?: Tokens }
interface CallbackListener { attemptId: string; redirectUri: string }
interface Discovery { jwks: string; revoke?: string }
class AuthFailure extends Error {}
function fail(message: string): never { throw new AuthFailure(message); }
const cancelled = (): DOMException => new DOMException('ChatGPT sign-in cancelled.', 'AbortError');
const string = (value: unknown, max = 32768): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

function safeError(error: unknown, fallback: string): Error {
  if (error instanceof AuthFailure) return error;
  if (error instanceof Error && error.name === 'AbortError') return cancelled();
  return new AuthFailure(fallback);
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(cancelled()); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function randomValue(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function trustedAuthEndpoint(value: unknown): string {
  if (!string(value, 2048)) return fail('OpenAI returned invalid sign-in configuration.');
  const url = new URL(value);
  if (url.origin !== ISSUER || url.username || url.password || url.search || url.hash) {
    return fail('OpenAI returned invalid sign-in configuration.');
  }
  return url.href;
}

function callbackUri(value: unknown): URL {
  if (!string(value, 2048)) return fail('The local sign-in callback is unavailable.');
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/auth/callback'
    || !url.port || url.username || url.password || url.search || url.hash) {
    return fail('The local sign-in callback is unavailable.');
  }
  return url;
}

function parseRecord(value: unknown): SavedRecord {
  if (value === null || value === undefined) return { version: 1 };
  if (!isRecord(value) || value.version !== 1 || new TextEncoder().encode(JSON.stringify(value)).length > MAX_RECORD_BYTES) {
    return fail('Saved ChatGPT sign-in data is invalid. Sign out and try again.');
  }
  const { identity, tokens } = value;
  if (identity !== undefined && (!isRecord(identity) || identity.issuer !== ISSUER || !string(identity.subject, 1024)
    || !string(identity.clientId, 1024) || identity.clientId === DYNAMIC_CLIENT
    || (identity.email !== undefined && !string(identity.email, 320)))) {
    return fail('Saved ChatGPT identity is invalid. Sign out and try again.');
  }
  if (tokens !== undefined && (!identity || !isRecord(tokens) || !string(tokens.access) || !string(tokens.refresh)
    || !string(tokens.idToken) || !string(tokens.nonce, 256) || typeof tokens.expires !== 'number' || !Number.isFinite(tokens.expires)
    || !Array.isArray(tokens.scopes) || !tokens.scopes.every((scope) => string(scope, 256)) || !tokens.scopes.includes(DIRECT_SCOPE))) {
    return fail('Saved ChatGPT credentials are invalid. Sign out and try again.');
  }
  return structuredClone({ version: 1, ...(identity ? { identity } : {}), ...(tokens ? { tokens } : {}) }) as SavedRecord;
}

/** Tokens stay in this closure and protected host storage, never in snapshots or Pi transcripts. */
export function createChatGPTAuth(options: { host: ChatGPTHost; onOpenUrl?: (url: string) => void }): ChatGPTAuth {
  const { host } = options;
  let record: SavedRecord = { version: 1 };
  let restored = false;
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let message: string | undefined;
  let loginController: AbortController | undefined;
  let attemptId: string | undefined;
  let discovery: Discovery | undefined;
  let snapshot: ChatGPTAuthSnapshot = Object.freeze({ signedIn: false, busy: false });
  const listeners = new Set<(snapshot: ChatGPTAuthSnapshot) => void>();
  const cancellations = new Map<string, Promise<void>>();

  const publish = () => {
    snapshot = Object.freeze({ signedIn: Boolean(record.tokens), busy: pending > 0,
      ...(record.identity?.email ? { email: record.identity.email } : {}), ...(message ? { message } : {}) });
    for (const listener of listeners) { try { listener(snapshot); } catch { /* Observers do not own auth state. */ } }
  };
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    pending++; publish();
    const result = tail.then(operation);
    const finished = result.finally(() => { pending--; publish(); });
    tail = finished.catch(() => {});
    return finished;
  };
  const restoreInside = async () => {
    if (restored) return;
    record = parseRecord(await host.call('auth.load'));
    restored = true;
    publish();
  };
  const save = async (next: SavedRecord) => {
    if (new TextEncoder().encode(JSON.stringify(next)).length > MAX_RECORD_BYTES) fail('ChatGPT credentials exceed the storage limit.');
    await host.call('auth.save', { record: next });
    record = next;
    publish();
  };
  const cancelAttempt = (id: string): Promise<void> => {
    let operation = cancellations.get(id);
    if (!operation) {
      operation = host.call('auth.cancel', { attemptId: id }).then(() => {}, () => {});
      cancellations.set(id, operation);
    }
    return operation;
  };
  const json = async (url: string, init: RequestInit, label: string): Promise<Record<string, unknown>> => {
    let response: Response;
    try { response = await host.fetch(url, { ...init, redirect: 'error' }); }
    catch (error) { throw safeError(error, `${label} could not connect. Try again.`); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return fail(`${label} failed (${response.status}). Please try signing in again.`);
    }
    try {
      const text = await response.text();
      const value: unknown = JSON.parse(text);
      if (!isRecord(value)) return fail(`${label} returned an invalid response.`);
      return value;
    } catch (error) { throw safeError(error, `${label} returned an invalid response.`); }
  };
  const discover = async (signal: AbortSignal): Promise<Discovery> => {
    if (discovery) return discovery;
    const value = await json(DISCOVERY, { signal }, 'ChatGPT sign-in configuration');
    if (value.issuer !== ISSUER) return fail('OpenAI returned an unexpected sign-in issuer.');
    discovery = { jwks: trustedAuthEndpoint(value.jwks_uri),
      ...(value.revocation_endpoint !== undefined ? { revoke: trustedAuthEndpoint(value.revocation_endpoint) } : {}) };
    return discovery;
  };
  const verifyIdentity = async (idToken: string, clientId: string, nonce: string | undefined, signal: AbortSignal): Promise<Identity> => {
    const metadata = await discover(signal);
    const jwks = await json(metadata.jwks, { signal }, 'ChatGPT identity verification');
    if (!Array.isArray(jwks.keys)) return fail('ChatGPT identity verification failed.');
    try {
      const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks as unknown as JSONWebKeySet), {
        issuer: ISSUER, audience: clientId, algorithms: ['RS256'], requiredClaims: ['iss', 'aud', 'exp', 'sub'],
      });
      if (!string(payload.sub, 1024) || (nonce !== undefined && payload.nonce !== nonce)
        || (payload.azp !== undefined && payload.azp !== clientId)
        || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) {
        return fail('ChatGPT identity verification failed.');
      }
      signal.throwIfAborted();
      return { issuer: ISSUER, clientId, subject: payload.sub,
        ...(string(payload.email, 320) ? { email: payload.email } : {}) };
    } catch (error) { throw safeError(error, 'ChatGPT identity verification failed.'); }
  };
  const tokenRequest = (body: URLSearchParams, signal: AbortSignal) => json(TOKEN, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body, signal,
  }, 'ChatGPT token request');
  const tokensFrom = (value: Record<string, unknown>, idToken: string, nonce: string): Tokens => {
    if (!string(value.access_token) || !string(value.refresh_token) || typeof value.expires_in !== 'number'
      || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || !string(value.scope, 4096)
      || (value.token_type !== undefined && String(value.token_type).toLowerCase() !== 'bearer')) {
      return fail('ChatGPT returned incomplete credentials. Try signing in again.');
    }
    const scopes = value.scope.split(/\s+/).filter(Boolean);
    if (!scopes.includes(DIRECT_SCOPE)) return fail('ChatGPT plan access was not granted. Sign in again and allow plan usage.');
    return { access: value.access_token, refresh: value.refresh_token,
      expires: Date.now() + value.expires_in * 1000 - 180000, scopes, idToken, nonce };
  };

  const controller: ChatGPTAuth = {
    get snapshot() { return snapshot; },
    subscribe(listener) { listeners.add(listener); listener(snapshot); return () => { listeners.delete(listener); }; },
    restore() {
      return serial(restoreInside).catch((error) => {
        const failure = safeError(error, 'Saved ChatGPT sign-in could not be loaded.');
        message = failure.message; publish(); throw failure;
      });
    },
    login(loginOptions = {}) {
      if (loginController) return Promise.reject(new AuthFailure('A ChatGPT sign-in is already in progress.'));
      const abort = new AbortController();
      loginController = abort;
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5 * 60 * 1000)]);
      return serial(async () => {
        await restoreInside();
        signal.throwIfAborted();
        message = 'Complete sign-in in your browser.'; publish();
        const previous = record;
        const selected = loginOptions.newAccount ? undefined : record.identity;
        const info = await abortable(host.call<{ hostId: string }>('auth.info'), signal);
        if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(info.hostId)) {
          fail('This installation has no valid ChatGPT host identity.');
        }
        const verifier = randomValue();
        const challenge = bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
          .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
        const state = randomValue();
        const nonce = randomValue();
        const listening = host.call<CallbackListener>('auth.listen', { state });
        let listener: CallbackListener;
        try { listener = await abortable(listening, signal); }
        catch (error) {
          // Do not permit a retry to race a listener that was still being created.
          await listening.then(async (late) => {
            if (string(late.attemptId)) { await cancelAttempt(late.attemptId); cancellations.delete(late.attemptId); }
          }, () => {});
          throw error;
        }
        if (!string(listener.attemptId, 1024)) fail('The local sign-in callback is unavailable.');
        attemptId = listener.attemptId;
        try {
          const redirect = callbackUri(listener.redirectUri).href;
          const url = new URL(AUTHORIZE);
          url.search = new URLSearchParams({ client_id: selected?.clientId ?? DYNAMIC_CLIENT,
            ext_agent_host_id: info.hostId, response_type: 'code', redirect_uri: redirect, resource: RESOURCE,
            scope: SCOPE, state, nonce, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
          if (!selected) url.searchParams.set('agent_name_hint', 'Self Forming');
          else {
            if (selected.email) url.searchParams.set('login_hint', selected.email);
            if (record.tokens?.idToken) url.searchParams.set('id_token_hint', record.tokens.idToken);
          }
          await abortable(host.call('auth.open', { attemptId: listener.attemptId, url: url.href }), signal);
          signal.throwIfAborted();
          options.onOpenUrl?.(url.href);
          const returned = await abortable(host.call<{ url: string }>('auth.wait', { attemptId: listener.attemptId }), signal);
          const callback = new URL(returned.url);
          const target = new URL(redirect);
          if (callback.origin !== target.origin || callback.pathname !== target.pathname || callback.hash || callback.username || callback.password
            || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== state) {
            fail('ChatGPT sign-in callback did not match this attempt.');
          }
          if (callback.searchParams.has('error')) fail('ChatGPT sign-in was not approved.');
          const code = callback.searchParams.get('code');
          const issued = callback.searchParams.get('client_id') ?? selected?.clientId;
          if (!string(code) || callback.searchParams.getAll('code').length !== 1 || !string(issued, 1024)
            || issued === DYNAMIC_CLIENT || callback.searchParams.getAll('client_id').length > 1
            || (selected && selected.clientId !== issued)) fail('ChatGPT returned an invalid registration callback.');
          const value = await tokenRequest(new URLSearchParams({ grant_type: 'authorization_code', client_id: issued,
            code, code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE }), signal);
          if (!string(value.id_token)) fail('ChatGPT did not return an identity token.');
          const tokens = tokensFrom(value, value.id_token, nonce);
          const identity = await verifyIdentity(value.id_token, issued, nonce, signal);
          if (selected && selected.subject !== identity.subject) fail('ChatGPT returned a different account. Choose a new account explicitly.');
          signal.throwIfAborted();
          await save({ version: 1, identity, tokens });
          // A cancellation during durable save must remove the just-written tokens before another operation starts.
          if (signal.aborted) {
            try { await save(previous); }
            catch { await host.call('auth.clear'); record = { version: 1 }; publish(); }
            throw cancelled();
          }
          message = 'Connected to ChatGPT.'; publish();
        } finally {
          await cancelAttempt(listener.attemptId);
          cancellations.delete(listener.attemptId);
          if (attemptId === listener.attemptId) attemptId = undefined;
        }
      }).catch((error) => {
        const failure = safeError(error, 'ChatGPT sign-in could not be completed. Please try again.');
        message = failure.message; publish(); throw failure;
      }).finally(() => { if (loginController === abort) loginController = undefined; });
    },
    cancel() {
      loginController?.abort();
      if (attemptId) void cancelAttempt(attemptId);
    },
    logout() {
      controller.cancel();
      return serial(async () => {
        // Even a corrupt saved record must be removable through Sign out.
        try { await restoreInside(); } catch { record = { version: 1 }; restored = true; }
        const old = record;
        record = { version: 1, ...(old.identity ? { identity: old.identity } : {}) };
        message = 'Signed out of ChatGPT.'; publish();
        try { await host.call('auth.save', { record }); }
        catch {
          await host.call('auth.clear');
          record = { version: 1 }; publish();
        }
        if (!old.tokens || !old.identity) return { revoked: true };
        try {
          const signal = AbortSignal.timeout(15000);
          const metadata = await discover(signal);
          if (!metadata.revoke) return { revoked: false };
          const response = await host.fetch(metadata.revoke, { method: 'POST', redirect: 'error', signal,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: old.tokens.refresh, token_type_hint: 'refresh_token', client_id: old.identity.clientId }) });
          await response.body?.cancel().catch(() => {});
          return { revoked: response.ok };
        } catch { return { revoked: false }; }
      }).catch((error) => {
        const failure = safeError(error, 'Saved ChatGPT credentials could not be cleared. Try signing out again.');
        message = failure.message; publish(); throw failure;
      });
    },
    getAccessToken(signal) {
      const operation = serial(async () => {
        await restoreInside();
        signal?.throwIfAborted();
        if (!record.identity || !record.tokens) return fail('Sign in with ChatGPT before sending a message.');
        // expires already includes the upstream three-minute safety margin.
        if (record.tokens.expires > Date.now()) return record.tokens.access;
        const previous = record;
        const identity = previous.identity!;
        const tokens = previous.tokens!;
        // Once refresh begins, persist its rotated token even if a waiting caller cancels.
        const refreshSignal = AbortSignal.timeout(15000);
        const value = await tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', client_id: identity.clientId,
          refresh_token: tokens.refresh, resource: RESOURCE }), refreshSignal);
        let nextIdentity = identity;
        let idToken = tokens.idToken;
        if (value.id_token !== undefined) {
          if (!string(value.id_token)) fail('ChatGPT returned an invalid identity token.');
          nextIdentity = await verifyIdentity(value.id_token, identity.clientId, undefined, refreshSignal);
          if (identity.subject !== nextIdentity.subject) fail('ChatGPT refresh returned a different account. Sign in again.');
          idToken = value.id_token;
        }
        const next = tokensFrom(value, idToken, tokens.nonce);
        await save({ version: 1, identity: nextIdentity, tokens: next });
        return next.access;
      }).catch((error) => { throw safeError(error, 'ChatGPT access could not be refreshed. Please sign in again.'); });
      return abortable(operation, signal);
    },
    async listModels(signal) {
      try {
        const access = await controller.getAccessToken(signal);
        const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20000)]);
        const value = await json(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${access}` }, signal: requestSignal }, 'ChatGPT model list');
        if (!Array.isArray(value.models)) return fail('ChatGPT returned an invalid model list.');
        const models = new Map<string, ChatGPTModel>();
        for (const model of value.models) {
          if (!isRecord(model) || model.visibility !== 'list' || !string(model.slug, 256)) continue;
          models.set(model.slug, { id: model.slug, name: string(model.display_name, 256) ? model.display_name : model.slug });
        }
        return [...models.values()];
      } catch (error) { throw safeError(error, 'Available ChatGPT models could not be loaded.'); }
    },
  };
  return controller;
}
