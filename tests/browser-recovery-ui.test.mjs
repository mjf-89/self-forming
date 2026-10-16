// Browser edition: the fixed recovery bar (browser-recovery-ui.js) with a small fake DOM.
// Real-browser CSS immunity is checked by ../build/browser-recovery/smoke.mjs (headless Chromium).
import test from "node:test";
import assert from "node:assert/strict";

const ui = await import("../apps/browser/browser-recovery-ui.js");

class FakeStyle {
  constructor() { this.props = new Map(); }
  setProperty(name, value, priority = "") { this.props.set(name, [value, priority]); }
  getPropertyValue(name) { return this.props.get(name)?.[0] ?? ""; }
  getPropertyPriority(name) { return this.props.get(name)?.[1] ?? ""; }
  removeProperty(name) { this.props.delete(name); }
}
class FakeNode {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.listeners = {}; this.parentNode = null; this.style = new FakeStyle(); this._text = ""; }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  append(...nodes) { for (const n of nodes) { n.parentNode?.children.splice(n.parentNode.children.indexOf(n), 1); n.parentNode = this; this.children.push(n); } }
  replaceChildren(...nodes) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  click() { if (!this.disabled) for (const fn of this.listeners.click ?? []) fn({}); }
  attachShadow(init) { this.shadowInit = init; this.shadow = new FakeNode("#shadow"); return this.shadow; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  *walk() { yield this; for (const c of this.children) yield* c.walk(); if (this.shadow) yield* this.shadow.walk(); }
}
function fakeDocument() {
  const html = new FakeNode("html"), body = new FakeNode("body");
  html.append(body);
  return { documentElement: html, body, createElement: (tag) => new FakeNode(tag) };
}
function fakeTimers() {
  const timers = new Map();
  let id = 0;
  return { timers, setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimer: (t) => timers.delete(t),
    fire() { for (const [k, t] of [...timers]) { timers.delete(k); t.fn(); } } };
}
const find = (root, action) => [...root.walk()].find((n) => n.getAttribute?.("data-action") === action);
const bar = (root) => [...root.walk()].find((n) => n.className === "bar");
const tick = () => new Promise((r) => setTimeout(r, 0));

test("noticeModel: startup, update (Undo · Keep · Recovery), alert, error", () => {
  assert.equal(ui.noticeModel({}), null);
  const startup = ui.noticeModel({ failed: {} });
  assert.equal(startup.text, "The app didn't start properly");
  assert.deepEqual(startup.actions.map((a) => a.id), ["recovery", "dismiss"]);
  const update = ui.noticeModel({ update: { revision: "r-0123456789abcdef" } });
  assert.equal(update.text, "App updated to revision r-01234567");
  assert.deepEqual(update.actions.map((a) => a.id), ["undo", "keep", "recovery", "dismiss"]);
  assert.deepEqual(ui.noticeModel({ failed: {}, update: { revision: "r-1" } }).actions.map((a) => a.id), ["undo", "recovery", "dismiss"]);
  assert.equal(ui.noticeModel({ alert: { text: "Revision r-1 stopped responding; restored the previous version." } }).text, "Revision r-1 stopped responding; restored the previous version");
  assert.match(ui.noticeModel({ update: { revision: "r-1" }, error: "nope" }).text, /Could not undo/);
});

test("host: <sf-recovery> on <html>, inline !important guards, closed shadow root; restored on removal", () => {
  const document = fakeDocument();
  document.documentElement.style.setProperty("display", "grid", "");
  const t = fakeTimers();
  const notices = ui.createRecoveryNotices({ document, recoveryUrl: "https://x/recovery.html", setTimer: t.setTimer, clearTimer: t.clearTimer, MutationObserver: undefined });
  notices.failed("boom");
  const host = notices.element();
  assert.equal(host.tagName, "SF-RECOVERY");
  assert.equal(host.parentNode, document.documentElement, "outside <body>");
  assert.deepEqual(host.shadowInit, { mode: "closed" });
  const style = host.getAttribute("style");
  for (const prop of ["display", "visibility", "position", "inset", "z-index", "opacity", "transform", "filter", "clip-path", "pointer-events", "width", "height"]) {
    assert.match(style, new RegExp(`(?:^|; )${prop}: [^;]+ !important`), prop);
  }
  assert.match(style, /z-index: 2147483647 !important/);
  assert.match(style, /pointer-events: auto !important/);
  assert.deepEqual(document.documentElement.style.props.get("display"), ["block", "important"]);
  assert.equal(find(host, "recovery").href, "https://x/recovery.html");
  assert.match(bar(host).textContent, /didn't start properly[\s\S]*boom/);
  assert.equal(bar(host).getAttribute("role"), "alert");
  find(host, "dismiss").click();
  assert.equal(notices.element(), undefined);
  assert.equal(host.parentNode, null);
  assert.deepEqual(document.documentElement.style.props.get("display"), ["grid", ""], "root guard restored");
});

test("startup watchdog: banner after the deadline unless ready; ready removes it", () => {
  const document = fakeDocument();
  const t = fakeTimers();
  const notices = ui.createRecoveryNotices({ document, recoveryUrl: "r", setTimer: t.setTimer, clearTimer: t.clearTimer });
  notices.expectReady(ui.STARTUP_READY_MS);
  assert.equal([...t.timers.values()][0].ms, 20_000);
  assert.equal(notices.current(), null);
  t.fire();
  assert.equal(notices.current().kind, "startup");
  assert.equal(notices.current().text, "The app is taking a long time to start", "a slow start is not called a failure");
  t.fire();
  assert.equal(notices.current().text, "The app didn't start properly", "still not ready after STARTUP_FAILED_MS");
  notices.ready();
  assert.equal(notices.current(), null);
  assert.equal(notices.element(), undefined);
  // Ready in time: nothing is shown.
  const other = ui.createRecoveryNotices({ document, recoveryUrl: "r", setTimer: t.setTimer, clearTimer: t.clearTimer });
  other.expectReady(100);
  other.ready();
  t.fire();
  assert.equal(other.current(), null);
});

test("update bar: Undo restores and reloads (own listeners, no app code); Keep; Dismiss; expiry", async () => {
  const document = fakeDocument();
  const t = fakeTimers();
  let reloads = 0;
  const calls = [];
  const notices = ui.createRecoveryNotices({ document, recoveryUrl: "r", reload: () => reloads++, setTimer: t.setTimer, clearTimer: t.clearTimer });
  notices.showUpdate({ revision: "r-abc", remainingMs: 5000, undo: async () => calls.push("undo"), keep: async () => calls.push("keep"), dismiss: async () => calls.push("dismiss") });
  const host = notices.element();
  assert.equal(bar(host).getAttribute("role"), "status");
  assert.match(bar(host).textContent, /App updated to revision r-abc/);
  find(host, "undo").click();
  await tick();
  assert.deepEqual(calls, ["undo"]);
  assert.equal(reloads, 1);

  // Undo failure is shown; Recovery stays.
  const failing = ui.createRecoveryNotices({ document, recoveryUrl: "r", reload: () => reloads++, setTimer: t.setTimer, clearTimer: t.clearTimer });
  failing.showUpdate({ revision: "r-x", remainingMs: 5000, undo: async () => { throw new Error("locked"); } });
  find(failing.element(), "undo").click();
  await tick(); await tick();
  assert.equal(failing.current().kind, "error");
  assert.equal(reloads, 1);

  const keep = ui.createRecoveryNotices({ document, recoveryUrl: "r", setTimer: t.setTimer, clearTimer: t.clearTimer });
  keep.showUpdate({ revision: "r-y", remainingMs: 5000, keep: async () => calls.push("keep") });
  find(keep.element(), "keep").click();
  await tick();
  assert.equal(keep.current(), null);
  assert.ok(calls.includes("keep"));

  const dismiss = ui.createRecoveryNotices({ document, recoveryUrl: "r", setTimer: t.setTimer, clearTimer: t.clearTimer });
  dismiss.showUpdate({ revision: "r-z", remainingMs: 5000, dismiss: async () => calls.push("dismiss") });
  find(dismiss.element(), "dismiss").click();
  await tick();
  assert.equal(dismiss.current(), null);
  assert.ok(calls.includes("dismiss"));

  const expire = ui.createRecoveryNotices({ document, recoveryUrl: "r", setTimer: t.setTimer, clearTimer: t.clearTimer });
  expire.showUpdate({ revision: "r-w", remainingMs: 1 });
  t.fire();
  assert.equal(expire.current(), null);
});

test("a host removed or restyled by app code is put back", () => {
  const document = fakeDocument();
  let callback;
  class Observer { constructor(fn) { callback = fn; } observe() {} disconnect() {} }
  const notices = ui.createRecoveryNotices({ document, recoveryUrl: "r", MutationObserver: Observer });
  notices.showAlert({ text: "Revision r-1 stopped responding; restored the previous version." });
  const host = notices.element();
  host.remove();
  host.setAttribute("style", "display:none");
  callback();
  assert.equal(host.parentNode, document.documentElement);
  assert.match(host.getAttribute("style"), /display: block !important/);
});
