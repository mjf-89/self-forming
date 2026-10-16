// Browser edition boot screen (fixed host file, never taken from an app revision).
// Classic same-origin script (the CSP forbids inline scripts and styles), loaded first in <head>, so
// a plain "SELF FORMING" page covers the document before the first paint. Without it the page shows
// the shipped markup first and then switches to the user's own revision, plugins and conversation
// (read from browser storage). It removes itself when the real app is ready:
//   - the plugin composition has settled (app.js calls __sfSplash.mark("composed")), and
//   - the conversation is open and rendered (the message box is enabled).
// It never gets stuck: startup errors (browser-main.js), a hard timeout, or the page asking for
// recovery reveal the page at once; the recovery bar sits above it (z-index below the bar's).
// Colours come from the look tokens (--paper, --ink, --brand, --serif) with neutral fallbacks;
// the styles are set through the DOM (allowed under style-src 'self'). No animation except a short
// fade-out, which is skipped with prefers-reduced-motion.
(function () {
  if (window.__sfSplash) return;
  var HARD_MS = 15000;        // longest the page stays covered
  var GRACE_MS = 3000;        // how long to wait for "composed" once the conversation is shown
  var FADE_MS = 160;
  var done = false, paused = false, composed = false, shownAt = 0;
  var timer, poll, grace;
  var root = document.documentElement;
  var box = document.createElement("div");
  box.id = "sf-splash";
  box.setAttribute("role", "status");
  box.setAttribute("aria-live", "polite");
  box.setAttribute("aria-label", "Loading Self Forming");
  var style = function (el, css) { el.style.cssText = css; };
  style(box, "position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147482000;display:flex;align-items:center;justify-content:center;" +
    "background:var(--paper,#f6f6f3);color:var(--ink,#282826);opacity:1;pointer-events:auto");
  var title = document.createElement("div");
  title.textContent = "SELF FORMING";
  style(title, "font:700 clamp(12px,3.5vw,15px)/1.4 var(--serif,'Courier New','Liberation Mono','Droid Sans Mono',monospace);" +
    "letter-spacing:.16em;padding-left:.16em;white-space:nowrap;color:var(--brand,var(--ink,#4a4a45))");
  box.appendChild(title);
  root.appendChild(box);
  shownAt = Date.now();

  function stop() { clearTimeout(timer); clearInterval(poll); clearTimeout(grace); }
  function reveal(reason) {
    if (done) return;
    done = true; stop();
    api.reason = reason || "ready";
    var reduce = false;
    try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { /* no media query */ }
    var remove = function () { if (box.parentNode) box.parentNode.removeChild(box); };
    box.style.pointerEvents = "none";
    if (reduce || reason === "error") { remove(); return; }
    box.style.transition = "opacity " + FADE_MS + "ms linear";
    box.style.opacity = "0";
    setTimeout(remove, FADE_MS + 60);
  }
  function arm() {
    clearTimeout(timer);
    if (!done && !paused) timer = setTimeout(function () { reveal("timeout"); }, HARD_MS);
  }
  function conversationShown() {
    var prompt = document.getElementById("prompt");
    return Boolean(prompt) && prompt.disabled === false;
  }
  function check() {
    if (done || paused) return;
    if (!conversationShown()) return;
    if (composed) { settle(); return; }
    grace = grace || setTimeout(settle, GRACE_MS); // an app without the hook still ends
  }
  function settle() {
    if (done) return;
    clearInterval(poll);
    // let the rendered conversation reach the screen before the cover goes
    setTimeout(function () { reveal("ready"); }, 60);
  }

  var api = window.__sfSplash = {
    reason: "",
    mark: function (what) { if (what === "composed") { composed = true; check(); } },
    reveal: reveal,
    // The page waits for the user (another tab holds the files): keep the cover, stop the clock.
    pause: function () { paused = true; clearTimeout(timer); },
    resume: function () { paused = false; arm(); check(); },
    active: function () { return !done; }
  };
  arm();
  poll = setInterval(check, 100);
})();
