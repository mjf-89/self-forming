// All credentials below are invented fixtures; no account, storage or network access.
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createBrowserOAuth, parseChatGPTCallback, sanitizeChatGPTRecord, loadChatGPTRecord, CHATGPT_CALLBACK, MAX_CALLBACK_LENGTH } from "../plugins/core-providers-chatgpt/web/browser-oauth.js";
globalThis.crypto ??= webcrypto;
const { createChatGPTAuth } = await import("../dist/app/native-host.js");
const state = "s".repeat(43);
const callback = (extra = "", expected = state) => `${CHATGPT_CALLBACK}?state=${expected}&code=dummy-code&client_id=dummy-issued-client${extra}`;
const authorize = () => `https://auth.openai.com/api/accounts/authorize?state=${state}&redirect_uri=${encodeURIComponent(CHATGPT_CALLBACK)}`;
const memory = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) }; };
function adapter() {
  let clock = 1000, expire, cleared = 0;
  const oauth = createBrowserOAuth({ now: () => clock, setTimer: fn => { expire = fn; return 1; }, clearTimer: () => cleared++, crypto: { randomUUID: () => "dummy-attempt" } });
  const call = (method, params) => oauth.methods[method](params);
  const listener = call("auth.listen", { state });
  return { oauth, call, listener, open: () => call("auth.open", { ...listener, url: authorize() }), expire: () => expire(), advance: () => { clock += 300001; }, cleared: () => cleared };
}

test("strict callback validation and sanitized protocol fields", () => {
  assert.equal(parseChatGPTCallback(callback("&unexpected=dummy"), state).url, callback());
  for (const bad of [
    "dummy-code", "/auth/callback?code=dummy", callback().replace("127.0.0.1", "localhost"),
    callback().replace("1455", "1456"), callback().replace("http:", "https:"),
    callback().replace("127.0.0.1", "127.0.0.1.evil.invalid"), callback().replace("127.0.0.1", "user@127.0.0.1"),
    callback().replace("/auth/callback", "/other/../auth/callback"), callback().replace("/auth/callback", "/auth/%63allback"),
    callback("#"), callback("#fragment"), callback("&state=duplicate"), callback("&code=duplicate"),
    callback("&client_id=duplicate"), callback("&error=a&error=b"), callback("", "wrong"),
    callback().replace("dummy-code", ""), callback().replace("dummy-code", "%00"), callback().replace("dummy-code", "%zz"), callback().replace("dummy-code", "%ff"),
    callback().replace("dummy-issued-client", "dynamic_agent_client"), ` ${callback()}`, `${callback()}\n`,
    callback() + "x".repeat(MAX_CALLBACK_LENGTH),
  ]) assert.throws(() => parseChatGPTCallback(bad, state), { code: "AUTH_ERROR" });
  assert.deepEqual(parseChatGPTCallback(callback("&error=access_denied&error_description=never-reflect"), state), { denied: true });
  assert.throws(() => parseChatGPTCallback(callback("&error=denied", "wrong"), state), /does not match/);
});

test("single-use callback / wait, retry malformed paste, no callback fetch", async () => {
  const a = adapter();
  a.open();
  const wait = a.call("auth.wait", a.listener);
  assert.throws(() => a.call("auth.wait", a.listener), /already been claimed/);
  assert.throws(() => a.oauth.submit(callback("", "wrong")), /does not match/);
  a.oauth.submit(callback());
  assert.equal((await wait).url, callback());
  assert.throws(() => a.oauth.submit(callback()), /not waiting/);
  a.call("auth.cancel", a.listener);
  assert.throws(() => a.oauth.submit(callback()), /no longer pending/);
  assert.equal(a.cleared(), 1);
});

test("callback may arrive before wait; cancellation, timeout, disposal and stale IDs", async () => {
  const early = adapter(); early.open(); early.oauth.submit(callback());
  assert.equal((await early.call("auth.wait", early.listener)).url, callback()); early.oauth.dispose();
  for (const action of [a => a.call("auth.cancel", a.listener), a => a.expire(), a => a.oauth.dispose()]) {
    const a = adapter(); a.open(); const wait = a.call("auth.wait", a.listener);
    a.call("auth.cancel", { attemptId: "stale-id" });
    action(a);
    await assert.rejects(wait, /cancelled|timed out/);
    assert.throws(() => a.oauth.submit(callback()), /no longer pending/);
  }
  const elapsed = adapter(); elapsed.open(); elapsed.advance();
  assert.throws(() => elapsed.oauth.submit(callback()), /no longer pending/);
  const denied = adapter(); denied.open(); const wait = denied.call("auth.wait", denied.listener);
  denied.oauth.submit(callback("&error=denied&error_description=never-reflect"));
  await assert.rejects(wait, e => e.message === "ChatGPT sign-in was not approved. Start again.");
});

test("authorization launch validates fixed endpoint, state and redirect", () => {
  for (const bad of [authorize().replace("auth.openai.com", "evil.invalid"), authorize().replace("authorize?", "token?"), authorize() + "#fragment", authorize() + "&state=duplicate", authorize().replace(state, "wrong"), authorize().replace("1455", "1456")]) {
    const a = adapter(); assert.throws(() => a.call("auth.open", { ...a.listener, url: bad }), /Invalid ChatGPT/); a.oauth.dispose();
  }
  const a = adapter(); a.open(); assert.throws(() => a.open(), /already prepared/); a.oauth.dispose();
});

const record = () => ({ version: 1, identity: { issuer: "https://auth.openai.com", subject: "dummy-subject", clientId: "dummy-issued-client" }, tokens: { access: "dummy-access", refresh: "dummy-refresh", idToken: "dummy-id-token", nonce: "dummy-nonce", expires: 123456789, scopes: ["chatgpt.tokens.use.direct"] } });
test("storage strips transient/unknown properties and rejects malformed/oversize data without echo", () => {
  const r = record(); r.callbackUrl = "never-save"; r.verifier = "never-save"; r.identity.extra = "never-save"; r.tokens.code = "never-save";
  assert.deepEqual(sanitizeChatGPTRecord(r), record());
  const clean = sanitizeChatGPTRecord(r); r.tokens.scopes.push("extra"); assert.equal(clean.tokens.scopes.length, 1);
  assert.deepEqual(sanitizeChatGPTRecord({ version: 1 }), { version: 1 });
  for (const value of [{}, [], { version: 1, tokens: record().tokens }, { ...record(), tokens: { ...record().tokens, expires: Infinity } }, { ...record(), extra: "x".repeat(65536) }]) assert.throws(() => sanitizeChatGPTRecord(value), /Saved ChatGPT/);
  const storage = memory(); storage.setItem("auth", "private-malformed-test-data");
  assert.throws(() => loadChatGPTRecord(storage, "auth"), e => !e.message.includes("private-malformed"));
  storage.setItem("auth", JSON.stringify(record())); assert.deepEqual(loadChatGPTRecord(storage, "auth"), record());
});

// Run the unchanged bundled controller against the manual adapter and mock endpoints.
const keyPair = webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const b64 = value => Buffer.from(value).toString("base64url");
async function fixture({ failDiscovery = false, tokenFailure = false, gateExchange = false } = {}) {
  const oauth = createBrowserOAuth(); const storage = memory();
  let ready; const opened = new Promise(resolve => { ready = resolve; });
  let authorization; let tokenCalls = 0; let release;
  const held = new Promise(resolve => { release = resolve; });
  let started; const exchangeStarted = new Promise(resolve => { started = resolve; });
  oauth.subscribe(s => { if (s.url) { authorization = new URL(s.url); ready(); } });
  const { privateKey, publicKey } = await keyPair;
  const jwk = { ...await webcrypto.subtle.exportKey("jwk", publicKey), kid: "dummy-key", alg: "RS256", use: "sig" };
  async function idToken() {
    const encoded = `${b64(JSON.stringify({ alg: "RS256", kid: "dummy-key" }))}.${b64(JSON.stringify({ iss: "https://auth.openai.com", aud: "dummy-issued-client", sub: "dummy-subject", exp: 4102444800, nonce: authorization.searchParams.get("nonce") }))}`;
    return `${encoded}.${b64(await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(encoded)))}`;
  }
  const host = {
    async call(method, params = {}) {
      if (oauth.methods[method]) return oauth.methods[method](params);
      if (method === "auth.info") return { hostId: "urn:uuid:11111111-1111-4111-8111-111111111111" };
      if (method === "auth.load") return loadChatGPTRecord(storage, "auth");
      if (method === "auth.save") return storage.setItem("auth", JSON.stringify(sanitizeChatGPTRecord(params.record)));
      if (method === "auth.clear") return storage.removeItem("auth");
      throw new Error("Unexpected mocked host call");
    },
    async fetch(url, init) {
      assert.equal(init.redirect, "error");
      if (url === "https://auth.openai.com/api/accounts/oauth/token") {
        tokenCalls++; started(); if (gateExchange) await held;
        assert.equal(init.method, "POST");
        const body = new URLSearchParams(init.body);
        assert.equal(body.get("client_id"), "dummy-issued-client");
        assert.equal(body.get("code"), "dummy-code");
        assert.equal(body.get("redirect_uri"), CHATGPT_CALLBACK);
        assert.equal(body.get("resource"), "https://api.openai.com/v1");
        assert.equal(body.get("grant_type"), "authorization_code");
        const verifier = body.get("code_verifier"); assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(b64(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))), authorization.searchParams.get("code_challenge"));
        if (tokenFailure) return new Response("dummy-private-response-not-for-display", { status: 400 });
        return Response.json({ access_token: "dummy-access", refresh_token: "dummy-refresh", expires_in: 3600, id_token: await idToken(), scope: "openid chatgpt.tokens.use.direct", token_type: "Bearer" });
      }
      if (url === "https://auth.openai.com/.well-known/openid-configuration") {
        if (failDiscovery) throw new TypeError("dummy-internal-network-detail");
        return Response.json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/.well-known/jwks.json" });
      }
      if (url === "https://auth.openai.com/.well-known/jwks.json") return Response.json({ keys: [jwk] });
      throw new TypeError("Model CORS blocked (mock)");
    },
  };
  const auth = createChatGPTAuth({ host });
  const submit = () => oauth.submit(callback("", authorization.searchParams.get("state")));
  return { auth, oauth, opened, submit, storage, tokenCalls: () => tokenCalls, exchangeStarted, release, authorization: () => authorization };
}

test("real fixed controller PKCE exchange + identity verification, sanitized save, model CORS remains separate", async () => {
  const f = await fixture(); const login = f.auth.login(); await f.opened;
  const url = f.authorization(); assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.match(url.searchParams.get("state"), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(url.searchParams.get("state"), url.searchParams.get("nonce"));
  f.submit(); await login;
  assert.equal(f.auth.snapshot.signedIn, true); assert.equal(await f.auth.getAccessToken(), "dummy-access");
  const saved = JSON.parse(f.storage.getItem("auth")); assert.deepEqual(Object.keys(saved).sort(), ["identity", "tokens", "version"]);
  assert.ok(!f.storage.getItem("auth").includes("dummy-code")); assert.equal(f.tokenCalls(), 1);
  await assert.rejects(f.auth.listModels(), /could not connect/); assert.equal(f.auth.snapshot.signedIn, true);
  f.oauth.dispose();
});

test("cancel before paste or during exchange cannot save tokens", async () => {
  for (const during of [false, true]) {
    const f = await fixture({ gateExchange: during }); const login = f.auth.login(); await f.opened;
    if (during) { f.submit(); await f.exchangeStarted; }
    f.auth.cancel(); f.release(); await assert.rejects(login, /cancelled/);
    assert.equal(f.storage.getItem("auth"), null); assert.equal(f.auth.snapshot.signedIn, false); f.oauth.dispose();
  }
});

test("CORS-blocked discovery / rejected token exchange fail closed, sanitized errors, no saved credentials", async () => {
  for (const options of [{ failDiscovery: true }, { tokenFailure: true }]) {
    const f = await fixture(options); const login = f.auth.login(); await f.opened; f.submit();
    await assert.rejects(login, e => !e.message.includes("dummy-") && /could not connect|failed \(400\)/.test(e.message));
    assert.equal(f.storage.getItem("auth"), null); assert.equal(f.auth.snapshot.signedIn, false); f.oauth.dispose();
  }
});

test("real browser bridge exposes manual flow and sanitizes storage without making network requests", async () => {
  const { createBrowserHost } = await import("../apps/browser/browser-host.js");
  const { Vfs } = await import("../plugins/core-execution/web/browser/browser-vfs.js");
  const { createNativeBridge } = await import("../dist/app/native-host.js");
  const previous = globalThis.localStorage;
  globalThis.localStorage = memory();
  let host, bridge, vfs;
  try {
    vfs = await Vfs.open({ backend: { async open() {}, async loadMeta() { return []; }, async readContent() { return undefined; }, async save() {}, close() {} } });
    host = await createBrowserHost({ vfs, network: { fetch() { throw new Error("Unexpected network access"); } } });
    bridge = createNativeBridge(host.transport);
    const listener = await bridge.call("auth.listen", { state });
    await bridge.call("auth.open", { ...listener, url: authorize() });
    const wait = bridge.call("auth.wait", listener);
    host.oauth.submit(callback());
    assert.equal((await wait).url, callback());
    await bridge.call("auth.cancel", listener);
    await bridge.call("auth.save", { record: { ...record(), callback: "never-save", verifier: "never-save" } });
    assert.deepEqual(await bridge.call("auth.load"), record());
    const dummyClaude = { version: 1, provider: "claude", tokens: { access: "dummy-claude" } };
    await bridge.call("auth.save", { provider: "claude", record: dummyClaude });
    assert.deepEqual(await bridge.call("auth.load", { provider: "claude" }), dummyClaude);
    await bridge.call("auth.clear"); assert.equal(await bridge.call("auth.load"), null);
  } finally {
    bridge?.close(); host?.dispose(); await vfs?.flush();
    if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous;
  }
});

test("browser-only UI hook; Android/shared login remains fixed; no alternate transport or URL logging", async () => {
  const main = await readFile(new URL("../apps/browser/browser-main.js", import.meta.url), "utf8");
  const source = await readFile(new URL("../plugins/core-providers-chatgpt/web/browser-oauth.js", import.meta.url), "utf8");
  const shared = await readFile(new URL("../apps/common/app.js", import.meta.url), "utf8");
  assert.match(main, /mountBrowserOAuth\(host.oauth\)/);
  assert.match(shared, /auth = (createChatGPTAuth\(|\(await coreChatGPT\.loadChatGPTAuth\(\)\)\()/);
  assert.ok(!shared.includes("browser-oauth"));
  assert.ok(!/console\.|fetch\(/.test(source));
  assert.match(source, /never in chat/); assert.match(source, /not in a secure vault/);
  assert.match(source, /noopener noreferrer/); assert.match(source, /input.value = ""/);
});
