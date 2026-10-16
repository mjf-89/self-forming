# cors-rot reference

Details behind the short [README](../README.md).

## API

### `createCorsRot(options) -> net`

Options: `transport` (`'tailscale'` default | `'tor'`), `tailscale` (`{ storage, hostname, authKey }`),
`tor` (forwarded to the network: `timeoutMs`, `maxRedirects`, `maxHeaderBytes`,
`maxRequestBodyBytes`, `bootstrapTimeoutMs`, `keepAlive`), `onStatus(snapshot)`, `timeoutMs`,
`nativeFetch` (default `globalThis.fetch`, used for same-origin and WASM loading only), `keepAlive`,
`document` (for the Snowflake frame; default `globalThis.document`).

`timeoutMs` (default 120000) limits each setup stage, and within an HTTP exchange the longest time
without data sent or received: it restarts on every chunk, so a response that keeps streaming (a long
model reply, a large download) is never cut off, while a connection that stays silent fails with a
`TimeoutError` naming the transport ("Tor HTTP request timed out (no data for 120 s)"). The body must
keep being read: an unread body counts as silence.

`net` methods:

| Member | Description |
| --- | --- |
| `fetch(input, init)` | Standard streaming `Response` through the selected transport (same-origin uses the browser's fetch). |
| `fetchTor(input, init)` | Explicit Tor, regardless of the selected transport. |
| `connect(host, port, { tls })` | Raw stream (`read()`/`write(bytes)`/`close()`) through the selected transport. |
| `preconnect(url)` | Warm a keep-alive connection to `url`'s origin. |
| `warmUp()` | Start the selected transport in the background. A failing start never becomes an unhandled rejection: it shows up in `getStatus().tailscaleStartError` (Tailscale; the manager's own status is `state: 'error'` + `error`) or `torState: 'error'` + `lastStartError` (Tor). |
| `setTransport(name)` | `'tailscale'` \| `'tor'`; starts/stops the Snowflake proxy. |
| `getStatus()` | Snapshot (`transport`, `torState`, `progress`, `recentTorRequests`, …). |
| `subscribe(cb)` | Status subscription; returns an unsubscribe function. |
| `tailscale` | `{ start, stop, dispose, setAuthKey, getStatus, subscribe, setExitNode, login, logout }`. |
| `tor` | `{ stop }`: see *Stopping and disposing* below. |
| `snowflakeProxy` | `{ getStatus, subscribe, stop, dispose }` (status of the give-back proxy). |
| `stop()` | Async. Stops the Tor client, the Tailscale node and the Snowflake proxy frame; everything can be started again. |
| `dispose()` | Async. `stop()` plus dropping every listener and pool. Create a new instance afterwards. |
| `network` | The lower-level network object. |

### Tailscale sign-in: link or auth key

By default the node asks Tailscale for an interactive sign-in link (`net.tailscale.getStatus().loginURL`).
Optionally pass a **pre-authorized auth key** instead (create one in the admin console, Settings → Keys;
a reusable *ephemeral* key is the usual choice):

```js
createCorsRot({ tailscale: { authKey: 'tskey-auth-…' } });          // a string
createCorsRot({ tailscale: { authKey: async () => await getKey() } }); // or a function (may be async)
net.tailscale.setAuthKey(key);   // sets/removes the key for the NEXT start()
```

With a key the node signs in by itself; without one nothing changes. The key is handed to the Tailscale
client only: it is **not** part of `getStatus()` (which only says `usingAuthKey: true|false`), not logged, not
stored by cors-rot and removed from error messages. Where you keep it is your decision (the page that
supplies it can read it, like any page secret). The node's own state (machine/node keys) still goes to
`tailscale.storage`.

### Stopping and disposing

| Call | Releases |
| --- | --- |
| `net.tailscale.stop()` | The in-page Tailscale node (calls the client's `close()`, which **logs the node out**), its connections and keep-alive pool entries, and the locally stored node state. Status goes to `off`. A later `start()`/`warmUp()`/`fetch` creates a fresh node (needs the auth key or a new sign-in link). Safe while a start is still running (that start rejects, and its late client is closed). |
| `net.tor.stop()` (`network.stopTor()`) | The Tor client (`close()`/`free()` when it has them), the Tor keep-alive pool and startup timers. `torState` returns to `idle`; the next Tor use bootstraps a new client. Also safe during bootstrap. |
| `net.snowflakeProxy.stop()` | Removes the hidden proxy frame, which closes its WebRTC/WebSocket connections and timers. It stays down until Tor is switched away from and back, or a new Tor start begins. `dispose()` also detaches it from the network and the window for good. |
| `net.stop()` | All of the above. |
| `net.dispose()` | `stop()` plus status listeners and pools dropped (`tailscale.dispose()`, `snowflakeProxy.dispose()`, `network.dispose()`). |

All are idempotent. The Snowflake proxy normally follows the selected transport; there is still no
user-facing off switch for it while Tor is in use, `stop()` is for tearing the stack down.

### Lower-level exports (`src/index.js`)

`createBrowserNetwork`, `createTorClientOptions`, `createConnectionPool`, `poolKey`, `requestHttp`,
`validateHeaders`, `validateHttpUrl`, `createTailscaleManager`, `createSnowflakeProxy`,
`loadTorDirectory`, `saveTorDirectory`, `createGitHttp` (an `isomorphic-git` `http` plugin backed by
any fetch; `isomorphic-git` itself is **not** bundled).

## How it works

- **Tailscale transport.** `createTailscaleManager()` lazily loads `src/vendor/tailscale/` (Go→WASM, ~38
  MB, from `tailscale/cmd/tsconnect` with a small patch). The node joins the user's tailnet; sign-in,
  exit-node choice and state live in the provided `storage` (default `localStorage`). Requests are
  framed as HTTP/1.1 over a `connect()`/`connectTls()` stream that the WASM client proxies through the
  user's exit node. TLS for HTTPS is terminated **in the page** by Go's `crypto/tls`.
- **Tor transport.** `createBrowserNetwork()` lazily loads `src/vendor/webtor/` (patched `webtor-rs`). It
  opens a **WebSocket** to a public Snowflake bridge, downloads and authenticates the Tor network
  directory over Tor (~20–30 MB on a cold start; cached in IndexedDB by `tor-cache.js` and re-verified
  on every use), builds a circuit, and runs HTTP/1.1 over Tor streams. HTTPS is terminated **in the
  page** by rustls/webpki (TLS 1.3 only, Mozilla roots).
- **Snowflake give-back.** While `tor` is selected, `snowflake.js` runs the Tor Project's
  `snowflake-webext` core in a hidden same-origin frame (`snowflake-proxy.html`). Over **WebRTC** it
  relays encrypted Tor traffic for censored users between their browser and the Snowflake bridge. It
  **never** connects to websites. It stops when `tailscale` is selected. There is no off switch.
- **HTTP layer.** `http-stream.js` implements HTTP/1.1 over a transport stream with an optional
  keep-alive pool: streaming bodies (pulled, not buffered), chunked/`content-length` framing,
  redirects with cross-origin credential stripping, bounded buffered uploads, and no decompression,
  cookie jar, cache, referrer, or HTTP/2.

### Who sees what

| | Tailscale | Tor |
| --- | --- | --- |
| Your IP address | Your tailnet + your exit node's egress | Snowflake bridge / Tor entry; destination sees a Tor exit |
| HTTPS plaintext | Nobody in transit (TLS in-page, end to end) | Nobody in transit (TLS in-page, end to end) |
| Plain `http://` plaintext | Readable by your exit node | **Readable by the Tor exit** |
| The destination | Sees your exit node's address | Sees a Tor exit address |

## Security notes

- **TLS is terminated in the page.** For Tor, HTTPS uses **rustls/webpki (TLS 1.3 only, Mozilla
  roots)**; the upstream client's fail-open TLS and unsigned directory were replaced, and the Tor
  directory must carry a **5-of-9 quorum** of signatures from the pinned directory authorities and be
  currently valid. For Tailscale, HTTPS uses **Go's `crypto/tls`**. The exit/relay cannot read or
  change HTTPS.
- **Plain `http://` is readable by the exit** (Tor exit or Tailscale exit node). Prefer `https://`.
- Two independent code reviews of the Tor build; **not** a formal audit. See
  `build/patches/webtor-rs/` for the patch and `docs/` for the reviews and remaining limits.
- No cookie jar, ambient credentials, browser cache, referrer, integrity verification, or response
  decompression. `Accept-Encoding: identity` is requested. Cross-origin redirects drop `Authorization`,
  `Cookie`, API-key and custom-secret headers. Non-idempotent requests are never replayed after a
  failure.

## Snowflake infrastructure caveat

From the Snowflake project: *"At the moment we do not have the ability to share Snowflake
infrastructure between different types of applications…"* Deployments of this library **should run
their own Snowflake bridge and proxies** rather than relying on the Tor Project's public
infrastructure. Give-back and self-hosting links:

- https://snowflake.torproject.org/
- https://community.torproject.org/relay/setup/snowflake/standalone/
- https://community.torproject.org/relay/setup/snowflake/
- https://community.torproject.org/relay/
- https://community.torproject.org/relay/setup/bridge/
- https://community.torproject.org/relay/setup/webtunnel/
- https://gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/snowflake

**This product is not endorsed or sponsored by, or affiliated with, the Tor Project.** "Tor" and the
Tor Project logos are trademarks of The Tor Project, Inc.; use here does not imply endorsement.

## Tailscale exit-node setup

1. On an always-on device in your tailnet, enable **Run as exit node**
   (`tailscale set --advertise-exit-node`). https://tailscale.com/kb/1408/quick-guide-exit-nodes
2. Approve it in the admin console. https://login.tailscale.com/admin/machines
3. If you use custom access controls, allow internet access through exit nodes
   (`autogroup:internet`). https://login.tailscale.com/admin/acls
4. Exit-node docs: https://tailscale.com/kb/1103/exit-nodes

## Licenses / third-party notices

- **Our code** (`index.js`, `network.js`, `http-stream.js`, `tor-cache.js`, `tailscale.js`,
  `snowflake.js`, `snowflake-proxy.js`, `git-http.js`): MIT.
- **`src/vendor/webtor`** — patched `webtor-rs` (MIT) embedding **Arti** (MIT/Apache-2.0). Bundled Rust
  crates include **rustls**, **ring**, and **webpki-roots**; see `src/vendor/webtor/licenses/` for the
  notices of the main crates (webpki-roots is CDLA-Permissive-2.0); the complete inventory (all 316 crates,
  29 Go modules, Go runtime) with licence texts is in `THIRD_PARTY_NOTICES.md` and `third_party/`. Two build-graph
  crates are MPL-2.0 (`option-ext`, `priority-queue` — elected MPL-2.0 over LGPL), used unmodified.
- **`src/vendor/tailscale`** — Tailscale `cmd/tsconnect` (BSD-3-Clause), see `src/vendor/tailscale/LICENSE`.
- **`src/vendor/snowflake-proxy`** — the Tor Project's `snowflake-webext` core (BSD-3-Clause), see
  `src/vendor/snowflake-proxy/LICENSE`.

See each `src/vendor/*/PROVENANCE.md` for exact upstream commits and hashes.

## Tests and demo

```sh
node --test tests/*.test.mjs   # HTTP layer, pool, network (fake tor/tailscale), tor cache, preconnect
```

`demo/index.html` is a self-contained page (no external scripts): pick a transport, sign in to
Tailscale and choose an exit node, fetch a URL and stream the response, and do a raw TLS GET.
