import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

// Real app, OAuth controller and Pi Harness. Only external authorization and
// token/model responses are simulated; no account or production server is used.
await mkdir('test-results', { recursive: true });
const directory = await mkdtemp(resolve('test-results', 'claude-login-'));
const accessToken = 'sk-ant-oat01-test-browser-never-real';
let authorization;
let authorizationCount = 0;
let tokenRequests = 0;
const modelRequests = [];
let browser;
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const transport = async (url, init) => {
  assert.equal(url, 'https://platform.claude.com/v1/oauth/token');
  tokenRequests++;
  const body = JSON.parse(init.body);
  assert.equal(body.grant_type, 'authorization_code');
  assert.equal(body.code, 'test-claude-authorization-code');
  assert.equal(body.client_id, authorization.searchParams.get('client_id'));
  assert.equal(body.redirect_uri, authorization.searchParams.get('redirect_uri'));
  assert.equal(body.state, authorization.searchParams.get('state'));
  assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
  return json({ access_token: accessToken, refresh_token: 'test-claude-refresh-never-real', expires_in: 3600, token_type: 'Bearer' });
};
const preview = await serve(undefined, 0, {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.anthropic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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
  const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
  context.setDefaultTimeout(15000);
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('https://claude.ai/oauth/authorize?**', async route => {
    authorization = new URL(route.request().url());
    authorizationCount++;
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Simulated Claude sign-in</title><p>Test only. No account is being accessed.</p>' });
  });
  await context.route('https://api.anthropic.com/**', async route => {
    const request = route.request();
    assert.equal(new URL(request.url()).pathname, '/v1/messages');
    assert.equal(request.headers().authorization, `Bearer ${accessToken}`);
    assert.equal(request.headers()['anthropic-dangerous-direct-browser-access'], 'true');
    const body = JSON.parse(request.postData());
    modelRequests.push(body);
    const events = [
      { type: 'message_start', message: { id: 'msg_claude_browser', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Connected Claude response.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    await route.fulfill({ contentType: 'text/event-stream', body: events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') });
  });
  const page = await context.newPage();
  await page.goto(preview.url);
  await page.locator('#prompt:enabled').waitFor({ state: 'attached' });
  await page.locator('#show-chat').click();
  const draft = 'Keep this draft until I choose Send.';
  await page.locator('#prompt').fill(draft);
  await page.locator('#composer-model').click();
  assert.equal(await page.locator('#thinking-settings').isVisible(), false);
  assert.equal(await page.locator('#chatgpt-account').isVisible(), false);
  assert.equal(await page.locator('#claude-account').isVisible(), false);
  await page.locator('#mode').selectOption('claude');
  assert.equal(await page.locator('#claude-account').isVisible(), true);
  assert.equal(await page.locator('#chatgpt-account').isVisible(), false);
  assert.equal(await page.locator('#claude-settings').isVisible(), false);
  assert.equal(await page.locator('#thinking-settings').isVisible(), false);

  async function startLogin() {
    const previous = authorizationCount;
    const opened = context.waitForEvent('page');
    await page.locator('#claude-login:enabled').click();
    await page.locator('#claude-code-form:visible').waitFor();
    await page.waitForFunction(() => document.querySelector('#claude-open').hasAttribute('href'));
    const popup = await opened;
    await popup.waitForURL('https://claude.ai/oauth/authorize?**');
    assert.equal(authorizationCount, previous + 1);
    assert.equal(authorization.searchParams.get('code'), 'true');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.match(authorization.searchParams.get('scope'), /user:inference/);
    assert.equal(await page.locator('#chatgpt-account').isVisible(), false);
  }
  await startLogin();
  await page.locator('#claude-code').fill('test-discard-on-cancel');
  await page.screenshot({ path: resolve('test-results/claude-code-login.png'), fullPage: true });
  await page.locator('#claude-cancel').click();
  await page.locator('#claude-login:enabled').waitFor();
  assert.equal(await page.locator('#claude-code-form').isVisible(), false);
  assert.equal(await page.locator('#claude-code').inputValue(), '');
  assert.equal(await page.locator('#claude-open').getAttribute('href'), null);
  assert.equal(tokenRequests, 0);

  await startLogin();
  await page.locator('#claude-code').fill('test-claude-authorization-code#wrong-attempt');
  await page.locator('#claude-code-submit').click();
  await page.locator('#claude-login:enabled').waitFor();
  assert.match(await page.locator('#claude-auth-status').innerText(), /different sign-in/);
  assert.equal(tokenRequests, 0);
  assert.equal(await page.locator('#claude-code').inputValue(), '');

  await startLogin();
  await page.locator('#claude-code').fill(`test-claude-authorization-code#${authorization.searchParams.get('state')}`);
  await page.locator('#claude-code-submit').click();
  await page.locator('#claude-logout:enabled').waitFor();
  await page.waitForFunction(() => document.querySelector('#mode').value === 'claude');
  assert.equal(tokenRequests, 1);
  assert.equal(await page.locator('#claude-code').inputValue(), '');
  assert.equal(await page.locator('#claude-code-form').isVisible(), false);
  assert.equal(await page.locator('#claude-model').inputValue(), 'claude-sonnet-4-6');
  assert.equal(await page.locator('#claude-settings').isVisible(), true);
  assert.equal(await page.locator('#thinking-settings').isVisible(), true);
  const supported = await page.evaluate(async () => {
    const { getThinkingEfforts } = await import('./session.js');
    return getThinkingEfforts({ mode: 'claude', modelId: document.querySelector('#claude-model').value });
  });
  assert.deepEqual(await page.locator('#thinking-effort option').evaluateAll(items => items.map(item => item.value)), ['', ...supported]);
  assert.equal(await page.locator('#thinking-effort').inputValue(), '');
  await page.locator('#thinking-effort').selectOption('high');
  const alternate = await page.evaluate(async () => {
    const { CLAUDE_MODELS, getThinkingEfforts } = await import('./session.js');
    return CLAUDE_MODELS.find(item => item.id !== 'claude-sonnet-4-6' && getThinkingEfforts({ mode: 'claude', modelId: item.id }).includes('low')).id;
  });
  await page.locator('#claude-model').selectOption(alternate);
  assert.equal(await page.locator('#thinking-effort').inputValue(), '');
  await page.locator('#thinking-effort').selectOption('low');
  await page.locator('#claude-model').selectOption('claude-sonnet-4-6');
  assert.equal(await page.locator('#thinking-effort').inputValue(), 'high');
  await page.locator('#mode').selectOption('openai');
  assert.equal(await page.locator('#thinking-settings').isVisible(), false, 'nonreasoning API model hides unsupported effort');
  assert.equal(await page.locator('#chatgpt-account').isVisible(), false);
  assert.equal(await page.locator('#claude-account').isVisible(), false);
  await page.locator('#mode').selectOption('claude');
  assert.equal(await page.locator('#thinking-effort').inputValue(), 'high');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.locator('#thinking-effort').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const bounds = await page.locator('#thinking-effort').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
  await page.screenshot({ path: resolve('test-results/claude-thinking-settings.png'), fullPage: true });
  await page.locator('#settings-close').click();
  assert.equal(await page.locator('#prompt').inputValue(), draft);
  assert.equal(modelRequests.length, 0, 'sign-in, model selection and navigation never send');
  assert.match(await page.locator('#composer-model-label').innerText(), /Sonnet/);
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('.message-assistant')?.textContent.includes('Connected Claude response.'));
  await page.locator('#prompt:enabled').waitFor();
  assert.equal(modelRequests.length, 1);
  assert.equal(modelRequests[0].model, 'claude-sonnet-4-6');
  assert.equal(modelRequests[0].thinking.type, 'adaptive');
  assert.equal(modelRequests[0].output_config.effort, 'high');
  assert.equal((await page.content()).includes(accessToken), false);
  const saved = await page.evaluate(() => ({ keys: Object.keys(localStorage), value: localStorage.getItem('self-forming.thinking.v1'), sessionKeys: Object.keys(sessionStorage) }));
  assert.deepEqual(saved.keys, ['self-forming.thinking.v1']);
  assert.deepEqual(saved.sessionKeys, []);
  assert.equal(saved.value.includes(accessToken), false);

  await page.reload();
  await page.locator('#prompt:enabled').waitFor({ state: 'attached' });
  await page.locator('#composer-model').click();
  await page.locator('#mode').selectOption('claude');
  await page.locator('#claude-logout:enabled').waitFor();
  assert.equal(await page.locator('#thinking-effort').inputValue(), 'high');
  await page.locator('#claude-model').selectOption(alternate);
  assert.equal(await page.locator('#thinking-effort').inputValue(), 'low');
  await page.locator('#claude-model').selectOption('claude-sonnet-4-6');
  await page.locator('#thinking-effort').selectOption('');
  await page.reload();
  await page.locator('#prompt:enabled').waitFor({ state: 'attached' });
  await page.locator('#composer-model').click();
  await page.locator('#mode').selectOption('claude');
  await page.locator('#claude-logout:enabled').waitFor();
  assert.equal(await page.locator('#thinking-effort').inputValue(), '', 'explicit model default persists');
  await page.locator('#claude-logout').click();
  await page.locator('#claude-login:enabled').waitFor();
  assert.equal(await page.locator('#claude-logout').isVisible(), false);
  assert.equal(await page.locator('#claude-settings').isVisible(), false);
  assert.equal(await page.locator('#thinking-settings').isVisible(), false);
  assert.equal(modelRequests.length, 1);
  assert.deepEqual(errors, []);
  console.log('PASS Claude browser: copy-code PKCE, cancellation and state rejection, catalog, model-specific thinking preferences, direct browser inference, narrow Settings, draft preservation, reload and logout.');
} finally { await browser?.close(); await preview.close(); }
