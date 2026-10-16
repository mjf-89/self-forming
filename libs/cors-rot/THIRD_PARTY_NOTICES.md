# Third-party notices

cors-rot's own code is MIT ([LICENSE](LICENSE)). The prebuilt WebAssembly bundles (`cors-rot-vendor.tar.gz`,
built by `.github/workflows/build.yml`) and the vendored JS contain the third-party software below. Licence
texts are in this repository under `third_party/` (also shipped inside the release tarball) and
`src/vendor/*/LICENSE`, `src/vendor/webtor/licenses/`. Generated from `cargo tree --target wasm32-unknown-unknown`
(Cargo.lock of webtor-rs `cba29fb` + our patch) and `go version -m tailscale.wasm` (release v0.1.1). This is a
compliance inventory, not legal advice.

## Components

| Component | Version / source | Licence (as read in the upstream file) | Where the text is |
|---|---|---|---|
| Tailscale client (`cmd/tsconnect/wasm`, patched) | tailscale/tailscale `f61c86852783a963d96cd0a4c913f886472478d1` | BSD-3-Clause, "Copyright (c) 2020 Tailscale Inc & contributors." | `src/vendor/tailscale/LICENSE` |
| Go standard library + runtime (inside `tailscale.wasm`), `wasm_exec.js` | go1.27.2 | BSD-3-Clause, "Copyright 2009 The Go Authors." | `third_party/go/GO-LICENSE-go1.27.2` |
| Go modules linked into `tailscale.wasm` | 29 modules (table below) | see below | `third_party/go/<module>@<version>/` |
| webtor-rs (`webtor`, `webtor-wasm`) | ethereum/webtor-rs `cba29fb44970f4be37ebe7ce85bd50690d66413d` + `build/patches/webtor-rs/browser-streams-security.patch` | `license = "MIT"` in its Cargo.toml / "MIT" in its README; **upstream has no LICENSE file** | cors-rot `third_party/common/MIT.txt` (template) |
| Arti (`tor-*` crates 0.37.0, vendored in webtor-rs) | https://gitlab.torproject.org/tpo/core/arti | MIT OR Apache-2.0 | `src/vendor/webtor/licenses/arti/` |
| Rust crates compiled into `webtor_wasm_bg.wasm` | 316 registry crates (list below) | mostly MIT OR Apache-2.0; others listed below | `third_party/rust/<crate>-<version>/` |
| webpki-roots (Mozilla root data) | 1.0.4 | CDLA-Permissive-2.0 | `src/vendor/webtor/licenses/webpki-roots-1.0.4/LICENSE` |
| Snowflake proxy core (`snowflake-core.js`) | tpo/anti-censorship/pluggable-transports/snowflake-webext `853070e56e4c7b8a3747997ec03a8f859d436555`, unmodified | BSD-3-Clause, Copyright (c) 2016 Serene Han, Arlo Breault; 2019-2020 The Tor Project, Inc; 2022 WofWca | `src/vendor/snowflake-proxy/LICENSE` |

No fonts, icons, images or external scripts/stylesheets are used; `src/*.js` and `demo/index.html` are original
cors-rot code (HTTP/1.1 parsing, streams and git-http are written in-house).

## Copyleft / notable licences

* **MPL-2.0 (file-level copyleft, unmodified, no obligation beyond licence text + source pointer):**
  `option-ext 0.2.0` (https://crates.io/crates/option-ext/0.2.0, https://github.com/soc/option-ext) and
  `priority-queue 2.7.0` (LGPL-3.0-or-later OR MPL-2.0; **we elect MPL-2.0**, https://crates.io/crates/priority-queue/2.7.0).
  Both are used unmodified, so their complete source is the crates.io package of that version (pinned in
  Cargo.lock). The graph contains them via arti's `dirs`/`tor-rtmock`; neither appears in the panic-path strings
  of the final `.wasm`, so they are likely tree-shaken, but they are listed because they are in the build graph.
* **Mozilla CA data** is also embedded in `tailscale.wasm` via `golang.org/x/crypto/x509roots/fallback` (bundle.der, root certificate list; the module LICENSE is BSD-3-Clause, no separate data licence is stated in the module files).
* **CDLA-Permissive-2.0:** `webpki-roots 1.0.4` (data; requires the agreement text to travel with the data → shipped).
* **Unicode-3.0:** ICU4X crates (`icu_*`, `tinystr`, `yoke`, `zerovec`, ...) → licence text shipped in `third_party/rust/`.
* **Apache-2.0 (Go):** gvisor, groupcache, btree, go4.org/mem, memconn, go-proxyproto. None ship a NOTICE file (checked
  in the module zips); Apache-2.0 §4 satisfied by shipping the licence text.
* No GPL, LGPL, AGPL, SSPL found as the only available option in any linked component. The arti checkout root
  contains `GPL-3` / `LGPL-3` files, but every `tor-*` crate compiled in declares MIT OR Apache-2.0 (verified in the
  Cargo graph).

## Go modules in `tailscale.wasm` (from the binary's embedded build info)

| Module | Version | Licence read in module's LICENSE |
|---|---|---|
| filippo.io/edwards25519 | v1.2.0 | BSD-3-Clause |
| github.com/akutz/memconn | v0.1.0 | Apache-2.0 |
| github.com/coder/websocket | v1.8.15 | ISC |
| github.com/creachadair/msync | v0.10.1 | BSD-3-Clause |
| github.com/fxamacker/cbor/v2 | v2.9.3 | MIT |
| github.com/gaissmai/bart | v0.29.0 | MIT |
| github.com/go-json-experiment/json | v0.0.0-20260820222146-c27c302e5fc3 | BSD-3-Clause |
| github.com/golang/groupcache | v0.0.0-20241129210726-2c02b8208cf8 | Apache-2.0 |
| github.com/google/btree | v1.1.3 | Apache-2.0 |
| github.com/hdevalence/ed25519consensus | v0.2.0 | BSD-3-Clause |
| github.com/klauspost/compress | v1.20.0 | BSD-3-Clause |
| github.com/pires/go-proxyproto | v0.15.0 | Apache-2.0 |
| github.com/tailscale/hujson | v0.0.0-20260727124030-b80ff77dac4f | BSD-3-Clause |
| github.com/tailscale/peercred | v0.0.0-20250107143737-35a0c7bd7edc | BSD-3-Clause |
| github.com/tailscale/web-client-prebuilt | v0.0.0-20260917222731-e0ed2d0d0fea | BSD-3-Clause |
| github.com/tailscale/wireguard-go | v0.0.0-20260928213353-e61b6b78110b | MIT |
| github.com/x448/float16 | v0.8.4 | MIT |
| go4.org/mem | v0.0.0-20240501181205-ae6ca9944745 | Apache-2.0 |
| go4.org/netipx | v0.0.0-20260823151212-3075585bcbeb | BSD-3-Clause |
| golang.org/x/crypto | v0.57.0 | BSD-3-Clause |
| golang.org/x/crypto/x509roots/fallback | v0.0.0-20260113154411-7d0074ccc6f1 | BSD-3-Clause |
| golang.org/x/exp | v0.0.0-20260908205506-85c1c2202aba | BSD-3-Clause |
| golang.org/x/net | v0.60.0 | BSD-3-Clause |
| golang.org/x/sync | v0.23.0 | BSD-3-Clause |
| golang.org/x/sys | v0.48.0 | BSD-3-Clause |
| golang.org/x/term | v0.46.0 | BSD-3-Clause |
| golang.org/x/text | v0.42.0 | BSD-3-Clause |
| golang.org/x/time | v0.16.0 | BSD-3-Clause |
| gvisor.dev/gvisor | v0.0.0-20260915211658-a6f909f08a72 | Apache-2.0 |

(`golang.org/x/*` and some others also ship a `PATENTS` file, included.) Module paths above use `_` for `/` in
directory names.

## Rust crates by licence (webtor_wasm build graph)

**(MIT OR Apache-2.0) AND Unicode-3.0**: unicode-ident v1.0.22

**0BSD OR MIT OR Apache-2.0**: adler2 v2.0.1

**Apache-2.0**: amplify_derive v4.0.1, amplify_num v0.5.3, amplify_syn v2.0.1, sync_wrapper v1.0.2

**Apache-2.0 / MIT**: fnv v1.0.7

**Apache-2.0 AND ISC**: ring v0.17.14

**Apache-2.0 OR BSL-1.0**: ryu v1.0.20

**Apache-2.0 OR ISC OR MIT**: rustls v0.23.35

**Apache-2.0 OR MIT**: ascii v1.1.0, base16ct v0.2.0, base64ct v1.8.1, chacha20 v0.9.1, chacha20poly1305 v0.10.1, const-oid v0.9.6, der v0.7.10, ed25519 v2.2.3, equivalent v1.0.2, fastrand v2.3.0, idna_adapter v1.2.1, indexmap v2.12.1, keccak v0.1.5, pem-rfc7468 v0.7.0, pin-project v1.1.10, pin-project-internal v1.1.10, pin-project-lite v0.2.16, pkcs1 v0.7.5, pkcs8 v0.10.2, poly1305 v0.8.0, sec1 v0.7.3, signature v2.2.0, spki v0.7.3, ssh-cipher v0.2.0, ssh-encoding v0.2.0, ssh-key v0.6.7, utf8_iter v1.0.4, uuid v1.19.0, zeroize v1.8.2, zeroize_derive v1.4.2

**Apache-2.0/MIT**: atomic v0.5.3, atomic v0.6.1, console_error_panic_hook v0.1.7

**BSD-2-Clause OR Apache-2.0 OR MIT**: zerocopy v0.8.31

**BSD-3-Clause**: alloc-no-stdlib v2.0.4, alloc-stdlib v0.2.2, curve25519-dalek v4.1.3, ed25519-dalek v2.2.0, subtle v2.6.1, x25519-dalek v2.0.1

**BSD-3-Clause AND MIT**: brotli v7.0.0

**BSD-3-Clause/MIT**: brotli-decompressor v4.0.3

**CC0-1.0**: notify v8.2.0

**CDLA-Permissive-2.0**: webpki-roots v1.0.4

**ISC**: coarsetime v0.1.36, rustls-webpki v0.103.8, untrusted v0.9.0

**LGPL-3.0-or-later OR MPL-2.0**: priority-queue v2.7.0

**MIT**: amplify v4.9.0, asynchronous-codec v0.7.0, bitvec v1.0.1, blanket v0.3.0, bytes v1.11.0, convert_case v0.10.0, cookie-factory v0.3.3, darling v0.14.4, darling v0.21.3, darling_core v0.14.4, darling_core v0.21.3, darling_macro v0.14.4, darling_macro v0.21.3, data-encoding v2.9.0, derive-deftly v1.5.1, derive-deftly-macros v1.5.1, derive_more v2.1.0, derive_more-impl v2.1.0, educe v0.4.23, enum-ordinalize v3.1.15, fluid-let v1.0.0, funty v2.0.0, generic-array v0.14.7, glob-match v0.2.1, kcp v0.6.0, libm v0.2.15, matchers v0.2.0, merlin v3.0.0, nom v7.1.3, nu-ansi-term v0.50.3, ordered-float v2.10.1, phf v0.13.1, phf_generator v0.13.1, phf_macros v0.13.1, phf_shared v0.13.1, postage v0.5.0, radium v0.7.0, sanitize-filename v0.6.0, serde-value v0.7.0, serde-wasm-bindgen v0.6.5, sharded-slab v0.1.7, simd-adler32 v0.3.8, slab v0.4.11, spin v0.9.8, strsim v0.10.0, strsim v0.11.1, strum v0.27.2, strum_macros v0.27.2, synstructure v0.13.2, sysinfo v0.36.1, tap v1.0.1, tokio v1.48.0, tokio-macros v2.6.0, tracing v0.1.43, tracing-attributes v0.1.31, tracing-core v0.1.35, tracing-log v0.2.0, tracing-subscriber v0.3.22, tracing-test v0.2.5, tracing-test-macro v0.2.5, void v1.0.2, weak-table v0.3.2, winnow v0.7.14, wyz v0.5.1

**MIT OR Apache-2.0**: aead v0.5.2, aes v0.8.4, anyhow v1.0.100, arrayvec v0.7.6, asn1-rs v0.7.1, asn1-rs-derive v0.6.0, async-trait v0.1.89, base64 v0.22.1, bitflags v2.10.0, block-buffer v0.10.4, bstr v1.12.1, bumpalo v3.19.0, by_address v1.2.1, cfg-if v1.0.4, cipher v0.4.4, cpufeatures v0.2.17, crc32fast v1.5.0, crossbeam-queue v0.3.12, crossbeam-utils v0.8.21, crypto-common v0.1.7, ctr v0.9.2, der-parser v10.0.0, deranged v0.5.5, digest v0.10.7, directories v6.0.0, dirs v6.0.0, dirs-sys v0.5.0, displaydoc v0.2.5, downcast-rs v2.0.2, dyn-clone v1.0.20, either v1.15.0, enum_dispatch v0.3.13, figment v0.10.19, flate2 v1.1.5, form_urlencoded v1.2.2, futures v0.3.31, futures-channel v0.3.31, futures-core v0.3.31, futures-executor v0.3.31, futures-io v0.3.31, futures-macro v0.3.31, futures-sink v0.3.31, futures-task v0.3.31, futures-util v0.3.31, getrandom v0.2.16, getrandom v0.3.4, gloo-console v0.3.0, gloo-timers v0.3.0, gloo-utils v0.2.0, hashbrown v0.16.1, heck v0.5.0, hex v0.4.3, hkdf v0.12.4, hmac v0.12.1, http v1.4.0, httparse v1.10.1, humantime v2.3.0, idna v1.1.0, inout v0.1.4, inventory v0.3.21, itertools v0.14.0, itoa v1.0.15, js-sys v0.3.83, lazy_static v1.5.0, libc v0.2.178, lock_api v0.4.14, log v0.4.29, nonany v0.3.0, notify-types v2.0.0, num-bigint v0.4.6, num-conv v0.1.0, num-integer v0.1.46, num-iter v0.1.45, num-traits v0.2.19, once_cell v1.21.3, opaque-debug v0.3.1, os_str_bytes v6.6.1, parking_lot v0.12.5, parking_lot_core v0.9.12, paste v1.0.15, percent-encoding v2.3.2, pin-utils v0.1.0, powerfmt v0.2.0, ppv-lite86 v0.2.21, proc-macro-crate v3.4.0, proc-macro2 v1.0.103, quote v1.0.42, rand v0.8.5, rand v0.9.2, rand_chacha v0.3.1, rand_chacha v0.9.0, rand_core v0.6.4, rand_core v0.9.3, rand_jitter v0.5.0, regex v1.12.2, regex-automata v0.4.13, regex-syntax v0.8.8, rsa v0.9.9, rustls-pki-types v1.13.1, rustversion v1.0.22, scopeguard v1.2.0, serde v1.0.228, serde_core v1.0.228, serde_derive v1.0.228, serde_ignored v0.1.14, serde_json v1.0.145, serde_spanned v0.6.9, serde_spanned v1.0.3, serde_with v3.16.1, serde_with_macros v3.16.1, sha1 v0.10.6, sha2 v0.10.9, sha3 v0.10.8, smallvec v1.15.1, stable_deref_trait v1.2.1, static_assertions v1.1.0, syn v1.0.109, syn v2.0.111, thiserror v1.0.69, thiserror v2.0.17, thiserror-impl v1.0.69, thiserror-impl v2.0.17, thread_local v1.1.9, time v0.3.44, time-core v0.1.6, time-macros v0.2.24, toml v0.8.23, toml v0.9.8, toml_datetime v0.6.11, toml_datetime v0.7.3, toml_edit v0.22.27, toml_edit v0.23.9, toml_parser v1.0.4, toml_write v0.1.2, toml_writer v1.0.4, tracing-wasm v0.2.1, typenum v1.19.0, uncased v0.9.10, unicode-segmentation v1.12.0, unicode-xid v0.2.6, universal-hash v0.5.1, url v2.5.7, wasm-bindgen v0.2.106, wasm-bindgen-futures v0.4.56, wasm-bindgen-macro v0.2.106, wasm-bindgen-macro-support v0.2.106, wasm-bindgen-shared v0.2.106, web-sys v0.3.83, web-time v1.1.0

**MIT OR Zlib OR Apache-2.0**: miniz_oxide v0.8.9

**MIT/Apache-2.0**: asn1-rs-impl v0.2.0, assert_matches v1.5.0, derive_builder_core_fork_arti v0.11.2, derive_builder_fork_arti v0.11.2, derive_builder_macro_fork_arti v0.11.2, enumset v1.1.10, enumset_derive v0.14.0, filetime v0.2.26, futures-rustls v0.26.0, ident_case v1.0.1, minimal-lexical v0.2.1, num-bigint-dig v0.8.6, psl v2.1.168, psl-types v2.0.11, rusticata-macros v4.1.0, shellexpand v3.1.1, siphasher v1.0.1

**MPL-2.0**: option-ext v0.2.0

**Unicode-3.0**: icu_collections v2.1.1, icu_locale_core v2.1.1, icu_normalizer v2.1.1, icu_normalizer_data v2.1.1, icu_properties v2.1.2, icu_properties_data v2.1.2, icu_provider v2.1.1, litemap v0.8.1, potential_utf v0.1.4, tinystr v0.8.2, writeable v0.6.2, yoke v0.8.1, yoke-derive v0.8.1, zerofrom v0.1.6, zerofrom-derive v0.1.6, zerotrie v0.2.3, zerovec v0.11.5, zerovec-derive v0.11.2

**Unlicense**: async_executors v0.7.0

**Unlicense OR MIT**: byteorder v1.5.0, memchr v2.7.6

**Unlicense/MIT**: same-file v1.0.6, walkdir v2.5.0

**Zlib**: slotmap v1.1.1

**Zlib OR Apache-2.0 OR MIT**: bytemuck v1.24.0

**Zlib OR MIT OR Apache-2.0**: visibility v0.1.1


(Path crates: webtor, webtor-wasm — MIT, ours/upstream; arti `tor-*`, `fs-mistrust`, `safelog`, etc. — MIT OR Apache-2.0.)
Crates whose published package ships no licence file get a `NOTICE-NO-LICENSE-FILE.txt` recording the declared
SPDX licence and authors: alloc-stdlib, amplify_num, amplify_syn, asn1-rs-impl, cookie-factory,
derive-deftly-macros, gloo-console, gloo-timers, gloo-utils, void.

## Sources / reproducibility

Binaries are built only from pinned upstream commits plus the patches in `build/patches/` by `build/build-*.sh`
(CI: `.github/workflows/build.yml`); `BUILD.txt` of each release lists the hashes. Complete corresponding source
for the MPL-2.0 crates is the crates.io package version named above.
