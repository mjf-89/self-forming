# Snowflake proxy core

`snowflake-core.js` = unmodified source files of the Tor Project's
[snowflake-webext](https://gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/snowflake-webext)
at commit `853070e56e4c7b8a3747997ec03a8f859d436555`, concatenated in the order of upstream
`make.js` (`broker.js config.js proxypair.js snowflake.js ui.js util.js websocket.js shims.js`), without the
web-extension-only files. License: BSD 3-Clause (`LICENSE`, copyright Serene Han, Arlo Breault, The Tor
Project, WofWca). sha256 of snowflake-core.js: `193412fcc4dd09e2356ff04192418d025d3d751c404bda17d8db53d5b032bd63`.

Used by `../../snowflake-proxy.html` + `../../snowflake-proxy.js` (our replacement for the upstream badge UI)
and controlled by `../../snowflake.js`. Proxy type reported to the broker: `badge`, one client at a time.
This product is not endorsed or sponsored by, or affiliated with, the Tor Project.

Run a Snowflake proxy yourself: https://snowflake.torproject.org/ ·
standalone: https://community.torproject.org/relay/setup/snowflake/standalone/
