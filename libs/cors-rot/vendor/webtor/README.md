# Reviewed-source Webtor WASM recovery

**Follow-up hardening is documented in `docs/tor-client-security-remediation.md`.** Copy the entire bundle including generated `snippets/` when deploying.

**Experimental transport; keep the application's `TOR_SECURITY_BLOCKED` release gate closed.** Node/ws results below are not browser/WebView validation or a Tor anonymity/security audit. Never send real credentials while the gate is blocked.

## API

```js
import init, { TorClient, TorClientOptions } from './webtor_wasm.js';
await init({ module_or_path: new URL('./webtor_wasm_bg.wasm', import.meta.url) });
const opts = new TorClientOptions('wss://snowflake.torproject.net/')
  .withConsensusBaseUrl(new URL('../../tor', import.meta.url).href)
  .withConnectionTimeout(30000)
  .withCircuitTimeout(45000);
const client = await new TorClient(opts);
await client.waitForCircuit();
const stream = await client.connect('example.com', 80, 30000);
// Or client.connectTls('example.com', 443, 30000): rustls TLS 1.3 only.
const pending = stream.read();               // Uint8Array, or undefined at EOF
await stream.write(new TextEncoder().encode(
  'GET / HTTP/1.0\r\nHost: example.com\r\nConnection: close\r\n\r\n'));
const bytes = await pending;
await stream.close();
await client.close();
```

Do not put this example into the application to bypass its release gate. Option builders consume the previous options object; retain the returned object. The generated `.d.ts` files describe the bindings. `validateDirectory(consensusText, certificateText)` runs the same pinned quorum/time checks as bootstrap and returns authenticated router count; it grants no trust setting.

- `connect` is **plaintext application TCP** through Tor, not end-to-end TLS. Never use it for credentials.
- `connectTls` authenticates the supplied host via rustls/webpki and the bundled Mozilla trust roots. It uses SNI for DNS names, TLS 1.3 only, and ALPN `http/1.1`. There is no TLS1.2 retry, custom-root option or insecure opt-in.
- Application TLS and Tor-link TLS use different verifier configurations. The crate-private Tor-link verifier uses Arti's approach: verify the TLS handshake signature, then authenticate the link certificate against the pinned bridge identity through Arti CERTS. It is never exposed to `connectTls`. Both link and application TLS use rustls/ring; `subtle-tls` is no longer a WASM dependency.
- Streams own their IO without retaining client circuit locks. Read/write halves have separate asynchronous locks; pending/queued reads end on close. Close also cancels a pending write. Multiple streams can remain active concurrently. Dropping both halves ends the Tor stream; `close()` does not promise a graceful TLS close-notify exchange.
- Legacy upstream `fetch` HTTPS stays unavailable in WASM. Use of a safe `connectTls` does not silently revive the old HTTP/TLS implementation.

## Bootstrap integration

The configured consensus base URL must serve all three files, as raw file contents:

1. `consensus.txt.br`
2. `microdescriptors.txt.br`
3. `authority-certificates.txt`

Certificate input is mandatory; missing, invalid, expired or insufficient trusted authority signatures fail closed. The client checks certificate signatures, authority identity pins, certificate validity, consensus signatures (5 of 9 distinct authorities), and the consensus's advertised validity interval before selecting relays. Microdescriptors require full signed-consensus coverage and are deduplicated by digest/identity. Signed bandwidth and Arti-derived role weights are sampled across all eligible relays, never a source-ordered top-ten subset. The refresh path also authenticates certificate/quorum/time, and new circuit selection fails when the retained authenticated lifetime expires.

The integration owner must extend snapshot publication to include fresh authority certificates. A supplied public collection is at the upstream authorities (see `docs/`); its origin/hash does not confer trust. The initially recovered application snapshot expired **2026-10-13 08:00 UTC**; consult the separately maintained current snapshot manifest, not this historical timestamp. Do not extend timestamps or suppress expiry checks. On-demand refresh uses the configured snapshot endpoint after signed freshness expires, with no expired fallback. The client does not solve automatic fresh snapshot publication, censorship resistance, guard persistence, complete transport memory accounting, or system-clock trust. WebRTC is unavailable through this client pending DataChannel resource review.

## Build and verification

From the Self Forming source root:

```sh
scripts/build-webtor-wasm.sh
scripts/build-webtor-wasm.sh --smoke
node tests/browser-tor-wasm.smoke.mjs
# Optional bounded public-data-only live Tor probe; requires current snapshot:
timeout --kill-after=5s 160s node tests/browser-tor-wasm.smoke.mjs --tor
```

Uses the existing `/opt/rust` toolchain (`nightly-2026-01-05`), clang, and wasm-bindgen 0.2.106. Builds are foreground, offline, locked, bounded, and pinned to the reviewed upstream commit plus exact patch. No installer, background server, downloaded prebuilt or unsafe fallback is used. `--smoke` adds isolated test-only WS adapters with **no trust override** and never publishes them to this production bundle.

After independent review, **33 Node18/ws fixture checks passed**, including authenticated lifetime retention, complete descriptor coverage/permutation/duplicate resistance, signed weighted selection, queue bounds, fetch/socket cancellation, exact framed output across partial writes, and generated trusted-chain wrong-host/expired/not-yet-valid TLS regressions. Test roots/hooks are absent from production.

The final live Node/ws Tor probe rejected a wrong pinned bridge identity, obtained simultaneous raw/TLS1.3 public HTTP responses from example.com, and observed client-close cancellation plus physical WebSocket closure. Only public dummy requests were sent, without credentials.

**Still unverified:** actual browser/WebView startup, WebCrypto/CSP behavior, browser-internal receive allocation, complete Arti/KCP/SMUX memory/CPU accounting, and full path-selection/guard/anonymity review. The adapted Arti role weighting is not the full Arti client/path-selection implementation. The old WebRTC path is deliberately unavailable, not certified safe. A forged CERTS/TLS-certificate-binding negative fixture is still missing. See the follow-up document for specific limits and remaining risks. Keep the application's release gate closed.

Provenance, patch reconstruction, provider versions and licenses: `docs/tor-client-provenance.md`; bundled license texts: `licenses/`; generated build hashes: `BUILD.txt`.
