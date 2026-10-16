// Classic same-origin script (no inline script: the CSP forbids it), loaded in <head> right after builtin-styles.css, before
// first paint. builtin-styles.css carries only the DEFAULT look; when the user chose another one (Settings → Providers), plugin-styles.js
// mirrors that look's stylesheet href in localStorage and this script links it at once, so the page does not flash the default.
// plugin-styles.js adopts this link (data-early-look) at the first sync, or removes it when the choice no longer applies.
// Only a built-in or installed plugin stylesheet path is accepted; anything else is ignored. Must stay tiny and dependency-free.
(function () {
  try {
    var href = localStorage.getItem('self-forming.look.href');
    if (!href || !/^(\.\/builtin\/[a-z0-9][a-z0-9._-]*\/web\/|\/assets\/web\/plugins\/[a-z0-9][a-z0-9._-]*\/[a-f0-9]{16,128}\/)[a-z0-9._\/-]+\.css$/i.test(href) || href.indexOf('..') >= 0) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.setAttribute('href', href);
    link.setAttribute('data-early-look', '');
    var base = document.querySelector('link[href$="builtin-styles.css"]');
    if (base && base.parentNode) base.parentNode.insertBefore(link, base.nextSibling); else document.head.appendChild(link);
  } catch (e) { /* the default look stays */ }
})();
