// Browser boot cover (apps/browser/browser-splash.js): covers at once, reveals when composition settled and the
// conversation is open, and always ends (error, recovery, timeout); paused while the user is asked something.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../apps/browser/browser-splash.js", import.meta.url), "utf8");

function run({ reduce = false } = {}) {
  const timers = []; let now = 0;
  const makeEl = () => ({ style: { cssText: "" }, children: [], attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; } });
  const prompt = { disabled: true };
  const root = makeEl();
  const win = { matchMedia: () => ({ matches: reduce }) };
  const ctx = { window: win, document: { documentElement: root, createElement: makeEl, getElementById: (id) => id === "prompt" ? prompt : null },
    Date: { now: () => now }, setTimeout: (f, ms) => { const t = { f, at: now + ms, on: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.on = false; }, setInterval: (f, ms) => { const t = { f, at: now + ms, every: ms, on: true }; timers.push(t); return t; }, clearInterval: (t) => { if (t) t.on = false; } };
  vm.runInNewContext(source, ctx);
  const advance = (ms) => { const end = now + ms; for (;;) { const t = timers.filter((x) => x.on && x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!t) break; now = t.at; if (t.every) t.at += t.every; else t.on = false; t.f(); } now = end; };
  return { root, prompt, splash: win.__sfSplash, advance, covered: () => root.children.length === 1 };
}

test("covers the page with the plain masthead in the look tokens, no inline script", () => {
  const { root } = run();
  const box = root.children[0];
  assert.match(box.style.cssText, /var\(--paper/); assert.match(box.style.cssText, /var\(--ink/);
  assert.equal(box.children[0].textContent, "SELF FORMING");
  assert.doesNotMatch(source.replace(/^\/\/.*$/gm, ""), /animation|keyframes/);
});

test("stays until composed and the conversation is open, then fades and goes", () => {
  const t = run();
  t.advance(1000); assert.ok(t.covered());
  t.splash.mark("composed"); t.advance(500); assert.ok(t.covered(), "composer still disabled");
  t.prompt.disabled = false; t.advance(300); assert.ok(t.splash.reason === "ready");
  t.advance(400); assert.ok(!t.covered());
});

test("an app without the composed hook still ends after a grace period", () => {
  const t = run(); t.prompt.disabled = false;
  t.advance(2000); assert.ok(t.covered());
  t.advance(1500); t.advance(500); assert.ok(!t.covered());
});

test("reduced motion removes it without fading; errors reveal at once; the timeout never leaves it stuck", () => {
  const a = run({ reduce: true }); a.splash.mark("composed"); a.prompt.disabled = false; a.advance(400);
  assert.ok(!a.covered());
  const b = run(); b.splash.reveal("error"); assert.ok(!b.covered());
  const c = run(); c.advance(14000); assert.ok(c.covered()); c.advance(2000); c.advance(500); assert.ok(!c.covered());
});

test("pause keeps the cover while the user is asked; resume restarts the clock", () => {
  const t = run(); t.splash.pause(); t.advance(60000); assert.ok(t.covered());
  t.splash.resume(); t.advance(14000); assert.ok(t.covered()); t.advance(2000); t.advance(500); assert.ok(!t.covered());
});
