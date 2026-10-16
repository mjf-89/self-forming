// Runner: node tests/browser-tor-real.mjs [--offline-only] [--url http://127.0.0.1:18765]
// Needs the harness in ../../build/browser-validation (playwright-core + downloaded chromium-headless-shell).
import { writeFileSync, readFileSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import { launch, ARGS } from '../../build/browser-validation/launch.mjs';
const base = process.argv.find((a) => a.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:18765';
const offlineOnly = process.argv.includes('--offline-only');
const outFile = fileURLToPath(new URL('../../build/browser-validation/result.json', import.meta.url));
const browser = await launch();
const page = await browser.newPage();
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`.slice(0, 400)));
page.on('pageerror', (e) => consoleLines.push('[pageerror] ' + String(e).slice(0, 400)));
page.on('requestfailed', (r) => consoleLines.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
await page.goto(`${base}/tests/browser-tor-real.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
const t0 = Date.now();
const timer = setInterval(() => console.error(`[${Math.round((Date.now() - t0) / 1000)}s] ` + await_steps()), 15000); let lastSteps = '';
function await_steps() { return lastSteps; }
const poll = setInterval(async () => { try { lastSteps = await page.evaluate(() => window.__results.steps.map((s) => `${s.name}:${s.ok ? 'ok' : s.error ? 'FAIL' : '…'}`).join(' | ')); } catch {} }, 3000);
let results, runnerError;
try { results = await page.evaluate((a) => window.runAll(a), { skipLive: offlineOnly }); }
catch (e) { runnerError = String(e); results = await page.evaluate(() => window.__results).catch(() => ({})); }
clearInterval(timer); clearInterval(poll);
const final = { browser: { name: 'chromium-headless-shell', version: browser.version(), executable: 'playwright 1.49.1 build 1148 (headless_shell)', args: ARGS }, pageUrl: `${base}/tests/browser-tor-real.html`, runnerError, consoleLines, results };
writeFileSync(outFile, JSON.stringify(final, null, 1));
for (const s of results.steps || []) console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${String(s.ms).padStart(7)}ms  ${s.name}${s.error ? '  -> ' + s.error : ''}`);
console.log('console lines:', consoleLines.length, ' result file:', outFile);
await browser.close();
process.exit((results.steps || []).every((s) => s.ok) && !runnerError ? 0 : 1);
