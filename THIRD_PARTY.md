# Third-party software

Self Forming is MIT-licensed (see [LICENSE](LICENSE)). It includes or downloads the components below, each under its own
licence. Licence texts sit next to the code (paths below); `dist/app/THIRD_PARTY_NOTICES.md`, generated at build time, adds the
notices of every npm package the bundler actually used. Entries state what the bundled licence files say; this is an index,
not legal advice.

## Always in the app (Android and browser)

| Component | Licence | Where |
|---|---|---|
| pi-ai, pi-durable, chord (Earendil Works / Mario Zechner, 1.3.0) | MIT | [third-party/earendil-works.LICENSE](third-party/earendil-works.LICENSE) |
| jose 6.2.12 (Filip Skokan) | MIT | [third-party/jose.LICENSE](third-party/jose.LICENSE), `plugins/core-providers-chatgpt/web/lib/jose/` |
| standardwebhooks 1.1.1 | MIT | [third-party/standardwebhooks.LICENSE](third-party/standardwebhooks.LICENSE) |
| Baskervville, EB Garamond fonts (unused by the default look) | SIL OFL 1.1 | `apps/common/fonts/OFL-*.txt` |
| Other npm packages in the bundle | see their notices | `dist/app/THIRD_PARTY_NOTICES.md` |

## Android runtime (downloaded into the APK at build time, see [docs/runtime.md](docs/runtime.md))

| Component | Licence | Where |
|---|---|---|
| PRoot (STMicroelectronics) | GPL-2.0 or later (text in `assets/licenses/proot.txt` of the runtime payload) | runtime release `runtime-ubuntu-24.04-2` |
| talloc (used by PRoot) | LGPL-3.0 | `assets/licenses/talloc.txt` |
| Box64 (ptitSeb) | MIT | `assets/licenses/box64.txt` |
| Ubuntu 24.04 ARM64 root filesystem | various, mostly GPL/LGPL/BSD/MIT | each package's `/usr/share/doc/*/copyright` inside the image; source via `apt source` / <https://archive.ubuntu.com/ubuntu/> and <https://launchpad.net/ubuntu> |

Android SDK, JDK and Gradle are **not** shipped: the app offers to download them on the phone, where you accept the
[Android SDK licence](https://developer.android.com/studio/terms).

## Browser edition

| Component | Licence | Where |
|---|---|---|
| v86 emulator (commit 94faf3d6) | BSD-2-Clause | `apps/browser/vendor/v86/LICENSE.v86`, `PROVENANCE.md` |
| SeaBIOS, VGABIOS | LGPL-3.0 | `apps/browser/vendor/v86/COPYING.LESSER.seabios` |
| Alpine Linux 3.24.2 image (kernel, BusyBox, bash, coreutils, git, … 52 packages) | GPL-2.0/3.0, LGPL, MIT, BSD, … per package | **source offer: [docs/gpl-source-offer.md](docs/gpl-source-offer.md)** |
| blink (ISC), microvm-lite patches (MIT), dash 0.5.12 (BSD-3-Clause), toybox 0.8.14 (0BSD) | as listed | `apps/browser/vendor/blink/licenses/`, `BUILD.txt` |
| isomorphic-git 1.44.2 | MIT, with bundled Apache-2.0, ISC, BSD-3-Clause, Zlib and **LGPL-3.0** (ZenFS, marked) code | `apps/browser/vendor/isomorphic-git/` (`LGPL-3.0.txt`, `THIRD_PARTY_LICENSES.txt`; the unminified sources are in `index.umd.min.js.map`, so the LGPL parts can be rebuilt or replaced) |
| buffer 6.0.3, base64-js 1.5.1 (MIT), ieee754 1.2.1 (BSD-3-Clause) | as listed | `apps/browser/vendor/buffer/` |

## Network routes (Tor, Snowflake, Tailscale; used only when chosen)

[cors-rot](https://github.com/mjf-89/cors-rot) (MIT, Marco Jacopo Ferrarotti and contributors; pinned in `libs/cors-rot/UPSTREAM.lock`) bundles:

| Component | Licence | Where |
|---|---|---|
| Tailscale client (Go→WASM from tailscale/tailscale `cmd/tsconnect`, commit f61c8685, small patch) | BSD-3-Clause | `libs/cors-rot/vendor/tailscale/LICENSE`, `third-party/tailscale/` |
| Snowflake proxy core (Tor Project, snowflake-webext) | BSD-3-Clause | `libs/cors-rot/vendor/snowflake-proxy/LICENSE` |
| webtor-rs (voltrevo, commit cba29fb4, patched) with Arti pieces (Tor Project) | MIT (package metadata of webtor-rs; Arti MIT OR Apache-2.0) | `libs/cors-rot/vendor/webtor/licenses/`, `third-party/webtor-rs/PROVENANCE.md` |
| rustls, rustls-webpki, ring, futures-rustls, rustls-pki-types, webpki-roots, bitflags (Rust crates inside the WASM) | MIT / Apache-2.0 / ISC / CDLA-Permissive-2.0 (see the per-crate texts) | `libs/cors-rot/vendor/webtor/licenses/` |
| Go runtime and the 29 Go modules inside tailscale.wasm; all ~316 Rust crates inside the Tor WASM (MPL-2.0 election for option-ext and priority-queue) | BSD-3-Clause, Apache-2.0, MIT, ISC, Unicode-3.0, Zlib, CDLA-Permissive-2.0, MPL-2.0 and others (inventory and source pointers in the notices) | `libs/cors-rot/THIRD_PARTY_NOTICES.md`, `libs/cors-rot/third_party/` |

Not affiliated with or endorsed by the Tor Project, Tailscale or Alpine Linux.
