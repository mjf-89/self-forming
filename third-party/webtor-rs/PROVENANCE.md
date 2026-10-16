# Webtor recovery provenance (2026-10-13)

## Source and reconstruction

- Upstream checkout: `workspace/build/webtor-rs`.
- Required upstream commit: `cba29fb44970f4be37ebe7ce85bd50690d66413d`.
- Upstream package metadata names `https://github.com/voltrevo/webtor-rs`, version 0.5.7, MIT. This snapshot does **not** contain a root LICENSE file; do not mistake that metadata for a complete license audit of every bundled transitive component.
- `recovered-before-review.patch` preserves the failed agent's surviving tracked edits, **not an approved patch to apply**.
- `browser-streams-security.patch` is the complete replacement diff against the pinned commit, including the lockfile. Apply only this patch for a fresh reconstruction. It replaces, rather than stacks onto, the recovered patch.
- The enclosing Self Forming source copy has no `.git`. The upstream checkout does; no commits or shared Git settings were changed.
- Generated `vendor/webtor/BUILD.txt` records source, patch/lockfile hashes, compiler/wasm-bindgen versions and output hashes. Test-feature output stays in `build/webtor-rs/target/recovery-smoke`, never in the production vendor directory.

## Replacement providers and licenses

Existing installed crate sources were inspected; no provider was installed twice. Versions are locked in the patch's Cargo.lock. License texts are shipped under `vendor/webtor/licenses/`.

| Component | Version | Declared license | Provenance |
|---|---|---|---|
| rustls | 0.23.35 | Apache-2.0 OR ISC OR MIT | https://github.com/rustls/rustls |
| rustls-webpki | 0.103.8 | ISC | https://github.com/rustls/webpki |
| ring | 0.17.14 | Apache-2.0 AND ISC | https://github.com/briansmith/ring |
| futures-rustls | 0.26.0 | MIT OR Apache-2.0 | https://github.com/quininer/futures-rustls |
| rustls-pki-types | 1.13.1 | MIT OR Apache-2.0 | https://github.com/rustls/pki-types |
| webpki-roots (Mozilla root data) | 1.0.4 | CDLA-Permissive-2.0 | https://github.com/rustls/webpki-roots |
| Arti Tor-link verifier adaptation | vendored 0.37.0 | MIT OR Apache-2.0 | pinned checkout `vendor/arti/crates/tor-rtcompat/src/impls/rustls.rs` |

Ring's BoringSSL, other-bits, once_cell and fiat license files are retained, not just its short top-level pointer. The existing vendored Arti MIT/Apache texts are retained. These licenses permit redistribution under their respective notice conditions; this is not a legal opinion or an exhaustive audit of all historical Webtor dependencies. No AWS-LC/OpenSSL crypto provider was added.

## Public directory material

- `authority-certificates.txt`: public authority certificate collection downloaded 2026-10-13 from `http://131.188.40.189/tor/keys/all`; SHA-256 `6ac2ac67ff3ef1f29ef60f59eb467e58ff0ecdcd0e594c54f629656fdf803007`.
- Plain HTTP is intentional here: these files are **untrusted input**, authenticated cryptographically against independently pinned authority identities. Neither transport origin nor the hash is a trust anchor.
- `fixtures/consensus.txt.br`: copied from the existing application snapshot, valid 2026-10-13 05:00–08:00 UTC; SHA-256 `70f7e968a8fe1e5b4c30b8df1f140f6123f23e91572a06833bce5527791c3613`.
- `fixtures/snapshot-manifest.json`: preserved snapshot metadata, including its truthful `signatureVerified: false`. Runtime authentication is separate; no manifest field unlocks anything.
- The fixed fixture is only for repeatable tests using an explicitly frozen process-local clock. Never ship it as an evergreen bootstrap snapshot.
- Authority identity pins are copied from the independently bundled Arti `tor-dircommon/src/authority.rs`, not learned from a downloaded consensus or certificate set. Quorum is five distinct authorities out of the full nine pins, regardless of certificate count. Signing-key rotation works while the new certificate is valid and signed by a pinned authority identity; authority identity rotation requires reviewed source updates.

## Independent-review follow-up

The complete patch now also adapts Arti's pinned `tor-netdir/src/weight.rs` for measured/unmeasured bandwidth and guard/middle/exit role weights. This is under the same retained Arti MIT OR Apache-2.0 license; it is not represented as full Arti path selection. Existing locked bitflags 2.10.0 (MIT OR Apache-2.0) became a direct dependency for that adaptation; no new provider or installation was introduced.

Selection fixtures `selection-consensus.txt.br`, `selection-microdescriptors.txt.br` and `selection-manifest.json` were copied from the directory agent's already-served snapshot on 2026-10-13. They remain frozen historical test inputs. The unpinned authority fixture is the pinned Arti `tor-dirmgr/testdata/cert-5A23.txt`, with signatures validated at its historical validity time before testing rejection of its identity. Generated test CA private keys are temporary, used only for local test servers, and removed in cleanup.

See FOLLOWUP-REMEDIATION.md for changes, tests, caps and unaddressed limitations. `recovery-before-hardening.patch` is historical preservation, not another patch to apply.
