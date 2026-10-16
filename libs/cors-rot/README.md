# cors-rot

**Make any HTTP request from a web page.** A browser page can only `fetch()` servers that allow it
(CORS), and it cannot open raw TCP connections at all. That rules out talking to most APIs, git
servers and anything else that never planned for browsers. cors-rot gives a page a normal `fetch()`
(and raw TCP/TLS streams) that leave **through a network stack running inside the page itself**, so
the browser's rules about other origins no longer apply. No browser extension and no proxy server of
your own.

Two transports, both running entirely in the page:

- **`tailscale`**: an in-page Tailscale node joins your tailnet and sends traffic out through **your
  own exit node**. Fast, and sites see your exit node's address.
- **`tor`**: Tor over **Snowflake**, with TLS done in the page (the exit relay can't read HTTPS).
  While it is in use, the page also runs a Snowflake proxy to give back to the network.

It started as the networking layer of the [Self Forming](https://github.com/mjf-89/self-forming)
browser edition, where an AI agent needs to reach model APIs and git servers from a static page.

> **Experimental and unaudited.** A CORS workaround, not an anonymity tool. Not published to npm on
> purpose. Not endorsed by, sponsored by or affiliated with the Tor Project or Tailscale.

## Build

The library is plain ES modules in [`src/`](src/); only its two WebAssembly clients need building.
Either download them from a release (built by [CI](.github/workflows/build.yml) from pinned sources):

```sh
scripts/fetch-vendor.sh            # latest release; set GH_TOKEN for a private repository
```

or build them yourself:

```sh
build/build-tailscale.sh           # Go 1.27.2:  tailscale f61c8685 + build/patches/tailscale
build/build-webtor.sh              # rustup + wasm-bindgen-cli 0.2.106 + clang:
                                   #   webtor-rs cba29fb4 + build/patches/webtor-rs
node --test tests/*.test.mjs       # unit tests
```

Each build writes `src/vendor/*/BUILD.txt` with versions and checksums. The Tor build refuses to
finish if the module's exports differ from the reviewed allowlist.

## Use

Serve the folder as static files (`.wasm` as `application/wasm`, over HTTPS or `http://localhost`):

```js
import { createCorsRot } from './cors-rot/src/index.js';

const net = createCorsRot({ transport: 'tailscale' });   // or 'tor'
net.tailscale.subscribe((s) => s.loginURL && showSignInLink(s.loginURL));
// or sign in without a link, with a pre-authorized key (string or function; never logged or exposed):
//   createCorsRot({ tailscale: { authKey: 'tskey-auth-…' } })

const response = await net.fetch('https://api.example.com/v1/thing');   // streaming Response
const socket = await net.connect('example.com', 443, { tls: true });     // read() / write() / close()
```

When you are done (or want a clean restart), `await net.stop()` releases the Tor client, the Tailscale
node (this logs it out) and the Snowflake proxy frame, and a later start works again; `await net.dispose()`
also drops listeners. Each transport has its own `net.tailscale.stop()`, `net.tor.stop()`,
`net.snowflakeProxy.stop()`. `warmUp()` reports a failing start in `getStatus()` instead of throwing
unhandled. Details: [`docs/reference.md`](docs/reference.md).

`demo/index.html` shows both transports. API, how it works, who can see what, security notes and
licenses: [`docs/reference.md`](docs/reference.md).

## Before you deploy

- **Tailscale** needs an exit node in the user's tailnet:
  [quick guide](https://tailscale.com/kb/1408/quick-guide-exit-nodes) ·
  [admin console](https://login.tailscale.com/admin/machines) ·
  [exit nodes](https://tailscale.com/kb/1103/exit-nodes).
- **Snowflake** capacity exists for people in censored countries. Its developers say Snowflake
  infrastructure can't yet be shared between application types: for real deployments run your own
  bridge and proxies, and give back. Run a proxy: [in the browser](https://snowflake.torproject.org/) ·
  [standalone](https://community.torproject.org/relay/setup/snowflake/standalone/). Run a
  [Tor relay](https://community.torproject.org/relay/), a
  [bridge](https://community.torproject.org/relay/setup/bridge/) or a
  [WebTunnel bridge](https://community.torproject.org/relay/setup/webtunnel/).

## License

MIT for this code ([LICENSE](LICENSE)). Vendored clients keep their licenses: Tor client (webtor-rs
MIT, Arti MIT/Apache-2.0, rustls/ring/webpki, webpki-roots CDLA-Permissive-2.0), Tailscale BSD-3-Clause (plus the Go runtime and 29 Go modules, BSD/MIT/Apache/ISC),
Snowflake proxy core BSD-3-Clause. Full inventory and licence texts: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and `third_party/` (also inside the release tarball); see also `src/vendor/*/` and [`docs/reference.md`](docs/reference.md).
