# isomorphic-git browser vendor — 1.44.2

## Pin and verification

Registry `https://registry.npmjs.org/isomorphic-git/latest` was checked on
2026-10-13 UTC and returned **1.44.2**. This is a fixed vendored copy, not a
runtime reference to `latest`.

- Repository: https://github.com/isomorphic-git/isomorphic-git
- Release source: https://github.com/isomorphic-git/isomorphic-git/tree/v1.44.2
- Registry tarball: https://registry.npmjs.org/isomorphic-git/-/isomorphic-git-1.44.2.tgz
- Registry SHA-1: `4580fb86a1aa499ceed4c6c7f3557357f145a9e0`
- Registry SRI (verified against the downloaded archive):
  `sha512-RORfhiNxaHRkGXvTiIW1SU6ngH/jW7UnKndvIToGxrGja7s317CUcZ5chENyinnyCPz7Z4vAefA75Ty1Zsyc8w==`
- Downloaded tarball SHA-256:
  `be66aea2877274ee0ead9d5d4f3f1d678aa70c2ebcb5fc1b82010b6f0dfe5042`
- Pristine `package/index.umd.min.js` SHA-256:
  `89c712e538366ac1d7cc01fde803c7e2a63a483a2f8ea34fcd576554408e3b9d`
- Pristine `package/index.umd.min.js.map` SHA-256:
  `5d999974be3caa3095213b0606eae5dc0d6e720201590fa0120612041693a58a`

`SHA256SUMS` covers every retained vendor file other than itself. Run
`sha256sum -c SHA256SUMS` in this directory. These hashes detect changes; this
is not a claim to have verified the registry's signing-key signatures.

## Artifact / reproduction (no app build step)

`index.umd.min.js` is the **unchanged, self-contained upstream browser bundle**,
including its dependencies and Buffer implementation. It does not use the
upstream Node entry point. `index.umd.min.js.map` is retained unchanged and
contains unminified `sourcesContent`, including dependency source and notices.
`upstream-package.json` is the package's original metadata.

`index.js` is that same UMD byte stream enclosed in local ESM bindings. The
only additional bytes are this prefix:

```js
// Local ESM envelope; upstream UMD bytes below are unchanged. See PROVENANCE.md.
const module = { exports: {} };
const exports = module.exports;
const self = globalThis;
```

and this suffix (preceded by a newline):

```js
export default module.exports;
```

Concatenating the prefix, pristine UMD and suffix reproduces the runtime
artifact byte-for-byte. The UMD takes its CommonJS branch using **module-local**
bindings; nothing is installed on `globalThis`. The envelope does not evaluate
code strings. Upstream retains legacy `Function(...)` fallbacks for engines
without native bind/globalThis; modern browsers do not take those branches.
There is no import from a CDN, dependency install or bundling needed in the app.
Import `index.js` from
a browser module. Its source-map comment belongs to the pristine UMD and the
four envelope lines offset generated stack locations; it is retained to keep
the original bytes intact. Replacing this single module with a compatible
modified version is supported; no signature check prevents replacement.

## Licenses and source provenance

The main project is MIT (`LICENSE.md`), **but this distribution is not entirely
MIT**. In particular, upstream 1.44.2 includes `src/utils/join.js`, copied from
ZenFS and marked **LGPL-3.0-or-later**. That code has not been replaced or
relicensed here. `LGPL-3.0.txt` and `GPL-3.0.txt` contain the license texts from
https://www.gnu.org/licenses/lgpl-3.0.txt and
https://www.gnu.org/licenses/gpl-3.0.txt. Its corresponding unminified source
is included in `index.umd.min.js.map` (`sources`/`sourcesContent`). Distribution
review must account for this LGPL component, not just the package's MIT label.

`upstream-package-lock.json` was obtained from the fixed release tag:
https://raw.githubusercontent.com/isomorphic-git/isomorphic-git/v1.44.2/package-lock.json
(SHA-256 `23e5629079f4cd4e89119d117bdaf4a66720cf58bb6a9b97d1c3c87365ffa494`).
It identifies dependency versions corresponding to the modules listed in the
bundle's source map. `bundled-dependencies.json` is the subset for those modules,
augmented with their exact registry tarball URLs and integrity hashes. Each
of those 40 distinct archives was fetched and integrity-checked while collecting
license texts, not installed as an app dependency. The lockfile is attribution
metadata only and is not used by an app package manager.

`THIRD_PARTY_LICENSES.txt` contains license files from those dependency archives
and copyright/license comments extracted from the upstream source map. The
bundled dependencies include MIT, BSD-3-Clause, ISC, Apache-2.0 and Zlib code.
Two archives lack a separate license file: diff3 has its MIT notice in its
source headers (included), and clean-git-ref declares Apache-2.0 in its
package metadata (included; Apache text is included with crc-32).

The main npm tarball oddly references but **omits**
`index.umd.min.js.LICENSE.txt`. Our file of that name is explicitly a
reconstructed notice collection from the original source map, not an alleged
pristine upstream file. No upstream notices were intentionally removed.

## Adapter API and limits

See `plugins/core-git/web/browser-git.js` for the complete method list and API documentation:

```js
import { createBrowserGit } from './builtin/core-git/web/browser-git.js' // assembled site root;
const git = createBrowserGit({ fs, fetch, cwd: '/workspace/project' });
await git.init({ defaultBranch: 'main' });
await git.add({ filepath: 'readme.txt' });
await git.commit({ message: 'Update', author: userProvidedIdentity });
```

`fs` is the existing async console-worker facade, not a raw `Vfs` instance.
Every operation is bound to its `fs`, `http` and `dir`; other upstream options
and results pass through. The factory accepts optional `onAuthor`, `onAuth`,
`onAuthSuccess`, `onAuthFailure`; methods can override callbacks. Author callbacks
receive `{ operation, dir }`. Auth callbacks have upstream `(url, auth)` arguments.
`commit`, `merge`, `pull` require explicit `author` or `onAuthor`;
`annotatedTag` requires `tagger` or `onAuthor`. No configured/default identity is
silently used. Credentials stay in callbacks/requests, never Git config or
browser storage. Credential-bearing remote URLs, query strings and fragments
are refused. The transport always uses `credentials: 'omit'`.

Missing VFS primitives that the integrating agent must consider:

- No symlink storage / `lstat` / `readlink` / `symlink`. Regular files and
  directories can be statted; actual symlink creation fails `ENOTSUP`.
- No executable-mode storage / `chmod`. A checkout that needs executable modes
  fails `ENOTSUP`, rather than silently losing them. `clone({noCheckout:true})`
  can still fetch and inspect such repositories, including their trees/modes.
- No reliable inode/change counter. A synthetic **unknown** inode (`NaN`) forces
  isomorphic-git to hash tracked content rather than reuse unsafe stat-cache hits.
  This catches same-size edits even within one VFS clock tick, at a speed cost.
- VFS is currently memory-resident and offers whole-file read/write, not file
  streams or random access. The HTTP adapter never concatenates entire packs,
  but upstream Git/VFS still use full pack buffers internally; this is not a
  constant-memory Git implementation. Persistence flushing remains the host's job.

Network limits: smart Git HTTP(S) only, subject to CORS and browser policy. No
SSH, shell Git, LFS hydration or invented CORS proxy. An explicitly supplied
upstream `corsProxy` is forwarded. Streaming uploads use Fetch `duplex: 'half'`
and need browser streaming support plus an HTTP/2-or-3 endpoint. There is no
hidden full-pack buffering fallback. Request headers, cancellation signals,
response status/headers, streaming responses, and progress/auth options are
preserved. No implicit retries or full-response buffering are added.

Tests: `node --test tests/browser-git.test.mjs` (Node 18 compatible, no app build).
The normal suite is offline and uses `Vfs`/`MemoryBackend`, generated test-only
authors, fake Fetch and dummy auth. Optional real clone:
`BROWSER_GIT_SMOKE_URL=https://host/repo.git node --test tests/browser-git.test.mjs`.
The optional smoke uses shallow `noCheckout` to avoid unsupported VFS file modes.
