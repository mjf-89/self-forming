// Real-Chromium smoke of the PRODUCTION browser edition (dist/browser on :8770): no injection, no shims.
// Run: serve dist/browser on 127.0.0.1:8770, then node tests/browser-tor-real.app.mjs
import { launch } from '../../build/browser-validation/launch.mjs';
const browser = await launch();
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)); });
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
const t0 = Date.now();
await page.goto('http://127.0.0.1:8770/', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => globalThis.__piBrowser?.network, null, { timeout: 60000 });
const ui = await page.evaluate(() => { const s = document.querySelector('[data-network-mode]'); return s && { value: s.value, options: [...s.options].map(o => o.value), status: document.querySelector('[data-network-status]')?.textContent }; });
console.log('settings control:', JSON.stringify(ui));
const result = await page.evaluate(async () => {
  const net = globalThis.__piBrowser.network;
  const out = { initial: await net.getStatus() };
  const time = async (name, fn) => { const t = performance.now(); try { out[name] = { ok: true, ...(await fn()), ms: Math.round(performance.now() - t) }; } catch (e) { out[name] = { ok: false, error: String(e?.message ?? e), code: e?.code, ms: Math.round(performance.now() - t) }; } };
  // auto mode: github.com is pre-routed through Tor; api.github.com (CORS-friendly) stays direct.
  await time('autoGitDiscovery', async () => { const r = await net.fetch('https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack', { headers: { 'user-agent': 'git/2.43.0' } }); const t = await r.text(); return { status: r.status, bytes: t.length, service: t.includes('# service=git-upload-pack') }; });
  await time('autoOpenAIDiscovery', async () => { const r = await net.fetch('https://auth.openai.com/.well-known/openid-configuration'); const j = await r.json(); return { status: r.status, issuer: j.issuer }; });
  await time('autoDirectCorsApi', async () => { const r = await net.fetch('https://api.github.com/zen'); return { status: r.status }; });
  await net.setMode('tor');
  await time('torIpCheck', async () => { const r = await net.fetch('https://check.torproject.org/api/ip'); return { status: r.status, body: await r.json() }; });
  out.final = await net.getStatus();
  await net.setMode('tailscale');
  return out;
});
console.log(JSON.stringify(result, null, 1));
console.log('console warnings/errors:', logs.slice(0, 12));
console.log('total', Date.now() - t0, 'ms');
await browser.close();
