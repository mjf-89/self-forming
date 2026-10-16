import type { ChatGPTHost } from './auth.ts';
import { bytesToBase64, isRecord } from './wire.ts';

// Pi 1.0.4 auth/oauth/anthropic.ts copy-code PKCE protocol (MIT). The host
// supplies protected provider storage and opens the system browser.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE = 'https://claude.ai/oauth/authorize';
const TOKEN = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT = 'https://platform.claude.com/oauth/code/callback';
const SCOPE = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const PROVIDER = 'claude';
const MAX_RECORD = 64 * 1024;

interface Tokens { access: string; refresh: string; expires: number }
interface Saved { version: 1; provider: typeof PROVIDER; tokens?: Tokens }
export interface ClaudeAuthSnapshot { signedIn: boolean; busy: boolean; awaitingCode: boolean; message?: string }
export interface ClaudeAuth {
  readonly snapshot: ClaudeAuthSnapshot;
  subscribe(listener: (snapshot: ClaudeAuthSnapshot) => void): () => void;
  restore(): Promise<void>;
  login(): Promise<void>;
  submitCode(value: string): boolean;
  cancel(): void;
  logout(): Promise<{ revoked: boolean }>;
  getAccessToken(signal?: AbortSignal): Promise<string>;
}
class AuthFailure extends Error {}
const fail = (message: string): never => { throw new AuthFailure(message); };
const aborted = () => new DOMException('Claude sign-in cancelled.', 'AbortError');
const valid = (value: unknown, max = 32768): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const empty = (): Saved => ({ version: 1, provider: PROVIDER });
const encodedSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function safeError(error: unknown, fallback: string): Error {
  if (error instanceof AuthFailure) return error;
  if (error instanceof Error && error.name === 'AbortError') return aborted();
  return new AuthFailure(fallback);
}
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(aborted()); }
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(aborted()); };
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { signal.removeEventListener('abort', cancel); resolve(value); },
      error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}
function parseRecord(value: unknown): Saved {
  if (value == null) return empty();
  if (!isRecord(value) || value.version !== 1 || value.provider !== PROVIDER || encodedSize(value) > MAX_RECORD) {
    return fail('Saved Claude sign-in data is invalid. Sign out and try again.');
  }
  const tokens = value.tokens;
  if (tokens !== undefined && (!isRecord(tokens) || !valid(tokens.access) || !valid(tokens.refresh)
    || typeof tokens.expires !== 'number' || !Number.isFinite(tokens.expires))) {
    return fail('Saved Claude credentials are invalid. Sign out and try again.');
  }
  return structuredClone({ ...empty(), ...(tokens ? { tokens } : {}) }) as Saved;
}
function parseCode(input: string, verifier: string): string {
  if (!valid(input, 8192)) return fail('Paste the code Claude shows after sign-in.');
  const value = input.trim();
  let code: string | null | undefined;
  let state: string | null | undefined;
  if (/^https?:/i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { return fail('Claude returned an invalid sign-in code.'); }
    if (url.origin + url.pathname !== REDIRECT || url.username || url.password || url.hash) {
      return fail('Claude returned an unexpected callback. Paste its authorization code instead.');
    }
    if (url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('state').length > 1 || url.searchParams.has('error')) {
      return fail('Claude sign-in was not approved.');
    }
    code = url.searchParams.get('code'); state = url.searchParams.get('state');
  } else if (value.includes('#')) {
    const parts = value.split('#');
    if (parts.length !== 2) return fail('Claude returned an invalid sign-in code.');
    [code, state] = parts;
  } else if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    if (params.getAll('code').length !== 1 || params.getAll('state').length > 1) return fail('Claude returned an invalid sign-in code.');
    code = params.get('code'); state = params.get('state');
  } else code = value;
  if (state && state !== verifier) return fail('This Claude code belongs to a different sign-in. Try again.');
  if (!valid(code, 4096) || /\s/.test(code)) return fail('Claude returned an invalid sign-in code.');
  return code;
}

/** Provider credentials never enter snapshots, messages or editable app storage. */
export function createClaudeAuth(options: { host: ChatGPTHost; onOpenUrl?: (url: string) => void }): ClaudeAuth {
  const { host } = options;
  let record = empty();
  let restored = false;
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let message: string | undefined;
  let loginController: AbortController | undefined;
  let receiveCode: ((value: string) => void) | undefined;
  let snapshot: ClaudeAuthSnapshot = Object.freeze({ signedIn: false, busy: false, awaitingCode: false });
  const listeners = new Set<(snapshot: ClaudeAuthSnapshot) => void>();
  const publish = () => {
    snapshot = Object.freeze({ signedIn: Boolean(record.tokens), busy: pending > 0, awaitingCode: Boolean(receiveCode), ...(message ? { message } : {}) });
    for (const listener of listeners) { try { listener(snapshot); } catch { /* Observers do not own credentials. */ } }
  };
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    pending++; publish();
    const result = tail.then(operation).finally(() => { pending--; publish(); });
    tail = result.catch(() => {});
    return result;
  };
  const restoreInside = async () => {
    if (restored) return;
    record = parseRecord(await host.call('auth.load', { provider: PROVIDER }));
    restored = true; publish();
  };
  const save = async (next: Saved) => {
    if (encodedSize(next) > MAX_RECORD) fail('Claude credentials exceed the storage limit.');
    await host.call('auth.save', { provider: PROVIDER, record: next });
    record = next; publish();
  };
  const tokenRequest = async (body: Record<string, string>, signal: AbortSignal): Promise<Tokens> => {
    let response: Response;
    try {
      response = await host.fetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body), signal, redirect: 'error', credentials: 'omit' });
    } catch (error) { throw safeError(error, 'Claude sign-in could not connect. Try again.'); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return fail(`Claude token request failed (${response.status}). Please sign in again.`); }
    try {
      const text = await response.text();
      const value: unknown = JSON.parse(text);
      if (!isRecord(value) || !valid(value.access_token) || !valid(value.refresh_token) || typeof value.expires_in !== 'number'
        || !Number.isFinite(value.expires_in) || value.expires_in <= 0
        || (value.token_type !== undefined && String(value.token_type).toLowerCase() !== 'bearer')) {
        return fail('Claude returned incomplete credentials. Please sign in again.');
      }
      return { access: value.access_token, refresh: value.refresh_token, expires: Date.now() + value.expires_in * 1000 - 5 * 60 * 1000 };
    } catch (error) { throw safeError(error, 'Claude returned invalid credentials.'); }
  };
  const controller: ClaudeAuth = {
    get snapshot() { return snapshot; },
    subscribe(listener) { listeners.add(listener); listener(snapshot); return () => { listeners.delete(listener); }; },
    restore() { return serial(restoreInside).catch(error => {
      const failure = safeError(error, 'Saved Claude sign-in could not be loaded.'); message = failure.message; publish(); throw failure;
    }); },
    login() {
      if (loginController) return Promise.reject(new AuthFailure('A Claude sign-in is already in progress.'));
      const abort = new AbortController(); loginController = abort;
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5 * 60 * 1000)]);
      return serial(async () => {
        await restoreInside(); signal.throwIfAborted();
        const previous = record;
        const verifier = bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
        const challenge = bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
          .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
        const url = new URL(AUTHORIZE);
        url.search = new URLSearchParams({ code: 'true', client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT,
          scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256', state: verifier }).toString();
        const codePromise = new Promise<string>(resolve => { receiveCode = resolve; });
        message = 'Sign in with Claude, then paste the code shown in your browser.'; publish();
        await abortable(host.call('auth.openExternal', { provider: PROVIDER, url: url.href }), signal);
        signal.throwIfAborted(); options.onOpenUrl?.(url.href);
        const code = parseCode(await abortable(codePromise, signal), verifier);
        receiveCode = undefined; message = 'Connecting to Claude…'; publish();
        const tokens = await tokenRequest({ grant_type: 'authorization_code', client_id: CLIENT_ID,
          code, state: verifier, redirect_uri: REDIRECT, code_verifier: verifier }, signal);
        signal.throwIfAborted();
        await save({ ...empty(), tokens });
        if (signal.aborted) {
          try { await save(previous); } catch { await host.call('auth.clear', { provider: PROVIDER }); record = empty(); publish(); }
          throw aborted();
        }
        message = 'Connected to Claude.'; publish();
      }).catch(error => {
        const failure = safeError(error, 'Claude sign-in could not be completed. Please try again.');
        message = failure.message; publish(); throw failure;
      }).finally(() => { receiveCode = undefined; if (loginController === abort) loginController = undefined; publish(); });
    },
    submitCode(value) {
      if (!receiveCode || typeof value !== 'string') return false;
      const receive = receiveCode; receiveCode = undefined; publish(); receive(value); return true;
    },
    cancel() { loginController?.abort(); receiveCode = undefined; publish(); },
    logout() {
      controller.cancel();
      return serial(async () => {
        await host.call('auth.clear', { provider: PROVIDER });
        record = empty(); restored = true; message = 'Signed out of Claude on this device.'; publish();
        // Pi's Claude flow provides no documented token revocation operation.
        return { revoked: false };
      }).catch(error => {
        const failure = safeError(error, 'Saved Claude credentials could not be cleared. Try again.');
        message = failure.message; publish(); throw failure;
      });
    },
    getAccessToken(signal) {
      const operation = serial(async () => {
        await restoreInside(); signal?.throwIfAborted();
        if (!record.tokens) return fail('Sign in with Claude before sending a message.');
        if (record.tokens.expires > Date.now()) return record.tokens.access;
        // Persist a rotated refresh token even when one waiting model call is cancelled.
        const tokens = await tokenRequest({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: record.tokens.refresh }, AbortSignal.timeout(30000));
        await save({ ...empty(), tokens });
        return tokens.access;
      }).catch(error => { throw safeError(error, 'Claude access could not be refreshed. Please sign in again.'); });
      return abortable(operation, signal);
    },
  };
  return controller;
}
