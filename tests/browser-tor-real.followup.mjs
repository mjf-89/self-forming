// Runner for follow-up live checks: node tests/browser-tor-real.followup.mjs [--url=http://127.0.0.1:18765]
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch, ARGS } from '../../build/browser-validation/launch.mjs';
const base = process.argv.find((a) => a.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:18765';
const outFile = fileURLToPath(new URL('../../build/browser-validation/result-followup.json', import.meta.url));
const useShim = process.argv.includes('--buffer-shim');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7) || null;
const outName = process.argv.find((a) => a.startsWith('--out='))?.slice(6) || null;
const outFile2 = outName ? fileURLToPath(new URL('../../build/browser-validation/' + outName, import.meta.url)) : useShim ? outFile : outFile.replace('result-followup.json', 'result-followup-noshim.json');
const browser = await launch();
const page = await browser.newPage();
// Record the actual bridge transport: every WebSocket URL and every RTCPeerConnection construction.
if (useShim) await page.addInitScript({ path: fileURLToPath(new URL('../../build/browser-validation/buffer-shim.js', import.meta.url)) }); // TEST-ONLY global Buffer (feross buffer@6.0.3)
await page.addInitScript(() => {
  const T = (window.__transport = { webSockets: [], rtcPeerConnections: 0, rtcDataChannels: 0 });
  const WS = window.WebSocket;
  window.WebSocket = new Proxy(WS, { construct(t, a) { T.webSockets.push(String(a[0])); return Reflect.construct(t, a); } });
  for (const n of ['RTCPeerConnection', 'webkitRTCPeerConnection']) if (window[n]) {
    const P = window[n]; window[n] = new Proxy(P, { construct(t, a) { T.rtcPeerConnections++; return Reflect.construct(t, a); } });
  }
});
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`.slice(0, 300)));
page.on('pageerror', (e) => consoleLines.push('[pageerror] ' + String(e).slice(0, 400)));
page.on('requestfailed', (r) => consoleLines.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
await page.goto(`${base}/tests/browser-tor-real.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
let last = ''; const t0 = Date.now();
const poll = setInterval(async () => { try { const s = await page.evaluate(() => (window.__followup?.steps || []).map((s) => `${s.name.slice(0, 40)}:${s.ok ? 'ok' : s.error ? 'FAIL' : '…'}`).join(' | ')); if (s !== last) { last = s; console.error(`[${Math.round((Date.now() - t0) / 1000)}s] ${s}`); } } catch {} }, 5000);
let results, runnerError;
try { results = await page.evaluate((o) => window.runFollowup(o), { only }); } catch (e) { runnerError = String(e); results = await page.evaluate(() => window.__followup).catch(() => ({})); }
clearInterval(poll);
const transport = await page.evaluate(() => window.__transport).catch(() => null);
const final = { browser: { name: 'chromium-headless-shell', version: browser.version(), args: ARGS }, bridgeTransportObserved: { ...transport, note: 'WebSocket URLs and RTCPeerConnection constructions observed in the page; the WASM labels its bridge hop "Snowflake (WebRTC)" in getCircuitRelays but that is only its own string.' }, runnerError, consoleLines, results };
final.bufferShimInjected = useShim;
writeFileSync(outFile2, JSON.stringify(final, null, 1));
for (const s of results?.steps || []) console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${String(s.ms).padStart(7)}ms  ${s.name}${s.error ? '  -> ' + s.error.slice(0, 300) : ''}`);
console.log('transport:', JSON.stringify(transport)); console.log('result file:', outFile2);
await browser.close();
process.exit((results?.steps || []).every((s) => s.ok) && !runnerError ? 0 : 1);
