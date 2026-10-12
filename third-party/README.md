# Upstream license snapshots

`earendil-works.LICENSE` is copied unchanged from `LICENSE` in [earendil-works/pi at 0cf65d2bf](https://github.com/earendil-works/pi/blob/0cf65d2bf/LICENSE). The published Earendil 1.0.4 npm packages declare MIT but omit this root file.

The bundle build incorporates that license for those packages and collects the license/notice files of the other npm packages actually examined by esbuild. Review this snapshot when updating upstream versions; the build deliberately refuses to apply it to another version.

`standardwebhooks.LICENSE` is copied byte-for-byte from [`libraries/LICENSE` in standard-webhooks/standard-webhooks at b4d2c14fc5b4ccff3ff271e3b087dff812254c59](https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE). This is the `gitHead` published in the [npm metadata for standardwebhooks 1.1.1](https://registry.npmjs.org/standardwebhooks/1.1.1); `libraries/javascript/package.json` at that commit also identifies version 1.1.1 and MIT. Its npm tarball omits the shared library license. The repository root license covers the specification separately; this snapshot is the MIT license for its libraries.

The snapshot's SHA-256 is `5ec8c7b26b64d881a6706617bed25c049f97f2f35de034c756de8546fd6dbe27`. The fallback accepts only `standardwebhooks@1.1.1` with declared license MIT and requires review for another version.

## Fonts

`apps/on-device/fonts/` bundles Baskervville (regular and italic, © The Baskervville Project Authors) and EB Garamond (© The EB Garamond Project Authors), both under the SIL Open Font License 1.1, taken unchanged from [google/fonts](https://github.com/google/fonts/tree/main/ofl) (`ofl/baskervville`, `ofl/ebgaramond`). Their licence texts are `OFL-Baskervville.txt` and `OFL-EBGaramond.txt` in that folder; `scripts/font-notices.sh` adds them to `dist/app/THIRD_PARTY_NOTICES.md` at build time. The fonts are loaded only from the app itself.
