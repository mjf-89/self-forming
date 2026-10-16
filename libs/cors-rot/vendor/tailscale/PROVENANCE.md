# Tailscale in-page client — provenance

This vendored directory contains a Go→WASM Tailscale client used as a second
network transport ("tailscale") for the browser app, letting requests leave
through the user's own Tailscale **exit node** (a faster/trusted alternative to
the in-page Tor client, as a CORS workaround).

## Upstream

- Project: https://github.com/tailscale/tailscale (cmd/tsconnect)
- License: BSD-3-Clause (see `LICENSE`)
- Commit: `f61c86852783a963d96cd0a4c913f886472478d1`
- Base glue: `cmd/tsconnect/wasm/wasm_js.go` (newIPN → netstack userspace client,
  DERP over WebSocket).

## Toolchain

- Go: **go1.27.2** (official `go1.27.2.linux-arm64.tar.gz` from go.dev).
  tailscale's `go.mod` requires `go 1.27.2`; the official toolchain satisfies it.
  (tailscale's pinned fork via `./tool/go` was not required for the wasm build.)
- Target: `GOOS=js GOARCH=wasm`.

## Patch

The upstream glue was forked minimally; the diff is kept at
`build/patches/tailscale/wasm_js.go.patch`. It adds JS methods on the object
returned by `newIPN(...)`:

- `exitNodes()` → array of `{id, name, ip, online}` built from
  `LocalBackend.Status()` peers where `PeerStatus.ExitNodeOption` is true
  (offered && approved exit nodes).
- `exitNodeDiag()` → `{peers, advertising, usable, advertisingNames}` — a
  diagnostic (added during the spike) distinguishing "tailnet has no exit node"
  from "exit node exists but is not approved/permitted for this node". Reads the
  netmap: `advertising` counts peers whose `Hostinfo.RoutableIPs` contain a
  default route; `usable` counts peers whose `AllowedIPs` contain one.
- `setExitNode(idOrIP)` / `clearExitNode()` → `LocalBackend.EditPrefs` toggling
  `ExitNodeID` / `ExitNodeIP` (masked prefs).
- `dial(host, port[, timeoutMs])` → TCP stream through the netstack user dialer
  (`tsdial.Dialer.UserDial`). Non-tailnet destinations route via the selected
  exit node. DNS for public names resolves through the exit node's PeerAPI DoH
  automatically (see `tsdial.userDialResolveAll` + `LocalBackend.SetExitDNSDoH`);
  features `ts_omit_useexitnode` / `ts_omit_peerapiclient` are **not** set, so
  this path is compiled in.
- `dialTLS(host, port[, timeoutMs])` → same, wrapped with `crypto/tls`
  (MinVersion TLS 1.2, `ServerName=host`, ALPN `http/1.1`). Certificates are
  verified against bundled roots via a blank import of
  `golang.org/x/crypto/x509roots/fallback` (registers `x509.SetFallbackRoots`,
  which is what crypto/tls uses when no system cert store exists, as in wasm/js).

Streams are JS objects `{read, write, close}` (all Promise-returning):
- `read()` resolves the next chunk as a `Uint8Array` (≤64 KiB) or `undefined`
  at EOF.
- `write(Uint8Array)` resolves when the bytes are written.
- concurrent `read`+`write` are allowed; `close()` is idempotent.

## Build commands

```sh
# Go 1.27.2 at $GOROOT, tailscale checkout at $TS_SRC (patched).
cd "$TS_SRC"
git apply build/patches/tailscale/wasm_js.go.patch   # if not applied
GOFLAGS=-mod=mod GOOS=js GOARCH=wasm \
  go build -o vendor/tailscale/tailscale.wasm ./cmd/tsconnect/wasm
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" vendor/tailscale/wasm_exec.js
```

See `scripts/build-tailscale-wasm.sh` for a wrapper.

## Artifact sizes (this build)

| artifact            | bytes       | approx   |
|---------------------|-------------|----------|
| tailscale.wasm raw  | 38,357,660  | 36.6 MiB |
| gzip -9             |  8,791,389  |  8.4 MiB |
| brotli -q 11        |  6,281,390  |  6.0 MiB |

`wasm_exec.js`: 16,992 bytes (Go 1.27.2 loader; must match the build toolchain).

## Files

- `tailscale.wasm` — the compiled client.
- `wasm_exec.js` — Go's wasm loader (installs `globalThis.Go`).
- `tailscale-client.js` — ES module glue exposing
  `createTailscaleClient({ authKey?, controlURL?, hostname?, storage, onLoginURL, onStatus })`
  with `exitNodes()`, `setExitNode()`, `clearExitNode()`, `connect()`,
  `connectTls()`, `login()`, `logout()`, `close()`, `whenRunning()`.
- `LICENSE` — upstream BSD-3-Clause.
