import assert from 'node:assert/strict';
import { mkdir, mkdtemp, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

// Every external OAuth/model response is simulated; the browser, PKCE, ID-token
// signature verification, native-style callback, Pi Harness and UI are real.
await mkdir('test-results', { recursive: true });
const directory = await mkdtemp(resolve('test-results', 'login-'));
const { privateKey, publicKey } = await generateKeyPair('RS256');
const key = { ...await exportJWK(publicKey), kid: 'self-forming-test', alg: 'RS256', use: 'sig' };
const clientId = 'oaiapp_self_forming_browser_test';
const accessToken = 'test-browser-oauth-access-never-real';
let authorization;
let receivedAuth;
let authReady = new Promise(resolveAuth => { receivedAuth = resolveAuth; });
let modelRequests = 0;
let modelListFailure = false;
let modelListGate;
let revoked = false;
let browser;
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const transport = async (url, init) => {
  const requestBody = init.body ? await new Response(init.body).text() : undefined;
  if (url.endsWith('/.well-known/openid-configuration')) return json({ issuer: 'https://auth.openai.com',
    jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
  if (url.endsWith('/.well-known/jwks.json')) return json({ keys: [key] });
  if (url.endsWith('/api/accounts/oauth/token')) {
    const body = new URLSearchParams(requestBody);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('client_id'), clientId);
    assert.equal(body.get('code'), 'test-authorization-code');
    assert.equal(body.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
    assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
    const idToken = await new SignJWT({ email: 'demo@example.test', nonce: authorization.searchParams.get('nonce') })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid }).setIssuer('https://auth.openai.com').setAudience(clientId)
      .setSubject('test-account').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    return json({ access_token: accessToken, refresh_token: 'test-refresh-token', expires_in: 3600, token_type: 'Bearer',
      id_token: idToken, scope: 'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct' });
  }
  if (url.endsWith('/api/accounts/oauth/revoke')) {
    assert.equal(new URLSearchParams(requestBody).get('token'), 'test-refresh-token'); revoked = true;
    return new Response(null, { status: 200 });
  }
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${accessToken}`);
  if (url.endsWith('/v1/models')) {
    if (modelListGate) await modelListGate;
    if (modelListFailure) return new Response(JSON.stringify({ error: { message: 'dummy-provider-secret <script>never render this</script>' } }),
      { status: 503, headers: { 'content-type': 'application/json' } });
    return json({ models: [{ slug: 'self-forming-browser-model', display_name: 'Browser Test Model', visibility: 'list' }] });
  }
  assert.equal(url, 'https://api.openai.com/v1/responses');
  modelRequests++;
  const body = JSON.parse(requestBody);
  assert.equal(body.model, 'self-forming-browser-model');
  assert.equal(body.stream, true); assert.equal(body.store, false);
  assert.equal('max_output_tokens' in body, false);
  const item = { type: 'message', id: 'message_test', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Connected account response.', annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id: 'resp_test', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_text.delta', output_index: 0, delta: 'Connected account response.' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 8 } } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};
const preview = await serve(undefined, 0, {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
}, { auth: { directory, fetch: transport } });
try {
  let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (!executablePath) {
    try { await access(chromium.executablePath()); }
    catch {
      for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
        try { await access(candidate); executablePath = candidate; break; } catch { }
      }
    }
  }
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 430, height: 980 } });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  // Provider requests must use the preview's actual streamed native protocol.
  // A direct browser request is a regression, never a route to mock successfully.
  await context.route('https://api.openai.com/**', async route => {
    errors.push('Model request bypassed the native development transport');
    await route.abort();
  });
  await context.route('https://auth.openai.com/api/accounts/authorize?**', async route => {
    authorization = new URL(route.request().url());
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Simulated sign-in</title><p>Test only. No account is being accessed.</p>' });
    receivedAuth();
  });
  const page = await context.newPage();
  await page.goto(preview.url);
  await page.locator('#prompt:enabled').waitFor({ state: 'attached' });
  await page.locator('#composer-model').click();
  assert.equal(await page.locator('#chatgpt-account').isVisible(), false);
  assert.equal(await page.locator('#claude-account').isVisible(), false);
  await page.locator('#mode').selectOption('chatgpt');
  assert.equal(await page.locator('#chatgpt-account').isVisible(), true);
  assert.equal(await page.locator('#claude-account').isVisible(), false);
  assert.equal(await page.locator('#chatgpt-settings').isVisible(), false);
  assert.equal(await page.locator('#thinking-settings').isVisible(), false);
  await page.locator('#chatgpt-login:enabled').waitFor();
  await page.screenshot({ path: resolve('test-results/chatgpt-login.png'), fullPage: true });
  await page.locator('#chatgpt-login').click();
  await authReady;
  assert.equal(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorization.searchParams.get('agent_name_hint'), 'Self Forming');
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ code: 'test-authorization-code', state: 'wrong', client_id: clientId }).toString();
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(await page.locator('#chatgpt-cancel').isVisible(), true);
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  assert.equal((await fetch(callback)).status, 200);
  await page.waitForFunction(() => document.querySelector('#mode').value === 'chatgpt' && !document.querySelector('#chatgpt-model').disabled);
  assert.equal(await page.locator('#chatgpt-settings').isVisible(), true);
  assert.equal(await page.locator('#chatgpt-model').inputValue(), 'self-forming-browser-model');
  assert.match(await page.locator('#auth-status').innerText(), /demo@example.test/);
  assert.equal(modelRequests, 0);
  modelListFailure = true;
  let releaseModelList;
  modelListGate = new Promise(resolveList => { releaseModelList = resolveList; });
  await page.locator('#refresh-models:enabled').click();
  await page.waitForFunction(() => document.querySelector('#chatgpt-note').textContent.startsWith('Loading the models'));
  assert.equal(await page.locator('#chatgpt-note').isVisible(), true);
  assert.equal(await page.locator('#refresh-models').isDisabled(), true);
  releaseModelList(); modelListGate = undefined;
  await page.waitForFunction(() => document.querySelector('#chatgpt-note').textContent.includes('503'));
  assert.equal(await page.locator('#chatgpt-note').isVisible(), true);
  assert.match(await page.locator('#chatgpt-note').innerText(), /Refresh models to retry/);
  assert.match(await page.locator('#auth-status').innerText(), /Connected.*demo@example.test/);
  assert.equal(await page.locator('#chatgpt-logout').isVisible(), true);
  assert.equal(await page.locator('#chatgpt-login').isVisible(), false);
  assert.equal((await page.content()).includes('dummy-provider-secret'), false);
  modelListFailure = false;
  await page.locator('#refresh-models:enabled').click();
  await page.waitForFunction(() => !document.querySelector('#chatgpt-model').disabled && document.querySelector('#chatgpt-model').value === 'self-forming-browser-model');
  assert.equal(await page.locator('#chatgpt-note').innerText(), 'Development sign-in stays in memory until the local server stops.');
  assert.equal(modelRequests, 0);
  await page.locator('#settings-close').click();
  await page.locator('#show-chat').click();
  await page.locator('#prompt').fill('Hello through my ChatGPT account.');
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('.message-assistant')?.textContent.includes('Connected account response.'));
  await page.locator('#prompt:enabled').waitFor();
  assert.equal(modelRequests, 1);
  assert.equal((await page.content()).includes(accessToken), false);
  assert.deepEqual(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })), { local: [], session: [] });
  await page.reload();
  await page.locator('#prompt:enabled').waitFor({ state: 'attached' });
  await page.locator('#composer-model').click();
  await page.locator('#mode').selectOption('chatgpt');
  await page.locator('#chatgpt-logout:visible').waitFor();
  await page.locator('#chatgpt-logout:enabled').waitFor();
  await page.locator('#chatgpt-logout').click();
  await page.locator('#chatgpt-login:visible').waitFor();
  await page.locator('#chatgpt-login:enabled').waitFor();
  assert.equal(revoked, true);
  assert.equal(await page.locator('#chatgpt-settings').isVisible(), false);
  assert.equal(await page.locator('#thinking-settings').isVisible(), false);
  authReady = new Promise(resolveAuth => { receivedAuth = resolveAuth; });
  await page.locator('#chatgpt-login').click();
  await authReady;
  assert.equal(authorization.searchParams.get('client_id'), clientId);
  assert.equal(authorization.searchParams.has('agent_name_hint'), false);
  await page.locator('#chatgpt-cancel').click();
  await page.locator('#chatgpt-login:enabled').waitFor();
  assert.equal(await page.locator('#chatgpt-logout').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('PASS ChatGPT browser: login button, PKCE + signed identity, state rejection, inline model-list loading/error and refresh recovery, real Pi response, reload, sign-out, reauthorization and cancellation.');
} finally { await browser?.close(); await preview.close(); }
