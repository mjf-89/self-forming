# Browser edition on GitHub Pages

Live at **https://demo.selfforming.incept.md**, built by `.github/workflows/pages.yml` on every push to `main`
of the public repository (also "Run workflow" by hand).

## One-time setup (owner)

1. **DNS** (at the incept.md DNS provider): `CNAME  demo.selfforming  →  mjf-89.github.io`
   (name `demo.selfforming` inside the zone `incept.md`; no proxying/CDN in front, no A records).
2. **Repository → Settings → Pages**: Source = **GitHub Actions**; Custom domain = `demo.selfforming.incept.md`;
   tick **Enforce HTTPS** once the certificate is issued (a few minutes after DNS resolves).
   Optionally verify the domain (Account → Settings → Pages) so nobody else can claim it.
3. Binary assets are built by CI, never uploaded by hand: run it with a new tag name such as `assets-v0.7.0`
   (Actions → "Browser assets" → Run workflow on main with `assets_tag`; workflow `browser-assets.yml`: downloads and checksum-verifies upstream `v86.wasm`, builds the Alpine image and the
   post-boot snapshot from pinned inputs, publishes the release with `SHA256SUMS` + `MANIFEST`). Then run
   `scripts/update-assets-lock.sh assets-v0.7.0` and commit `scripts/assets.lock`. The snapshot is not guaranteed to be
   bit-reproducible (the workflow reports whether two boots match), so the checksums that count are the ones of the
   released files, recorded in `assets.lock`; `fetch-assets.sh` verifies against them. `pages.yml` only fetches that
   release (building the 21 MB snapshot on every deploy would be slow and non-deterministic).

## What is built

`scripts/build-browser.sh` with `SF_STRIP_MAPS=1` (no source maps), about 108 MB; the largest file is
`cors-rot/vendor/tailscale/tailscale.wasm` (37 MB, under the 100 MB per-file limit; site limit 1 GB).
Binaries that Git does not hold come from `scripts/assets.lock` via `scripts/fetch-assets.sh`
(sha256-verified): v86 + Alpine image from the `assets-v*` release named in `assets.lock`, Tor/Tailscale WASM
from the cors-rot v0.1.2 release.

## Headers

GitHub Pages cannot set response headers. Nothing needs them:
- **No COOP/COEP / cross-origin isolation**: v86 is built without SharedArrayBuffer.
- **CSP** is a `<meta http-equiv>` in `index.html` (added by `build-browser.sh`; `frame-ancestors` cannot be
  set that way). `recovery.html` and `network-smoke.html` carry no CSP because they contain inline module scripts.
- `.wasm` is served as `application/wasm` by Pages; the service worker (`sw.js`) is same-origin at the root.
