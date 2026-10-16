# v86 + Alpine Linux (i686) — provenance & licenses

This directory vendors the **engine** assets *and* the trimmed **Alpine 9p image** for the
v86-backed Linux execution environment (`plugins/exec-linux/web/browser/browser-v86.js` +
`plugins/exec-linux/web/browser/browser-v86-worker.js`, the exec-linux execution@1 provider). Everything under `image/` is a build product of
`scripts/build-v86-image.sh` (new builds now stage outside this directory; see the NONLIVE
candidate section below):

| deliverable | what |
|---|---|
| `image/alpine-fs.json` | v86 9p basefs (the file tree) |
| `image/flat/*.bin` | content-addressed flat files (9p content, lazy-loaded by v86) |
| `image/alpine-state.bin.gz` | gzip'd post-boot state snapshot (shell ready + NIC up) — the **default boot path** |

`scripts/build-browser.sh` copies `apps/browser/vendor/` recursively, so these ship to the static
site at `vendor/v86/...` and are resolved by the owner’s `browser-assets.js` to the fixed site-root vendor subtree.

### Sizes (built from the pinned sources below)

| artifact | raw | gz |
|---|---|---|
| `v86.wasm` + `libv86.mjs` + BIOSes (engine) | ~2.5 MB | ~1.1 MB |
| `image/alpine-fs.json` | 29 KB | — |
| `image/flat/` (92 files; incl. 8 MB `vmlinuz`, 3.8 MB `libcrypto`) | 16.7 MB | 12.6 MB |
| `image/alpine-state.bin.gz` (256 MB VM, ~44 MB raw state) | — | **20.9 MB** |

The flat files are **lazy-loaded**; a snapshot restore (the default) touches almost none of them,
so the real download on the happy path is the ~21 MB snapshot. The 8 MB kernel + 3.8 MB libcrypto
dominate the flat tree and are only fetched on a **cold-boot fallback**.

## v86 emulator (BSD-2-Clause)

- Project: https://github.com/copy/v86
- Release: `latest` rolling release, published 2026-10-09, built from master commit
  **`94faf3d6b19ecabc53a4010aaa24252fa6a162e2`** ("fix: default net device to NE2000 (#1649)").
  (The `latest` tag tracks master; this is the commit it was built from. Tag `0.5` =
  `bbb2a5b4fd44e85d902792f9b93ec3e0d42e1b0f` is the last numbered tag and predates several
  networking fixes we rely on, so we pin the `latest` build + its commit.)
- License: BSD-2-Clause — see `LICENSE.v86` ("Copyright (c) 2012, The v86 contributors").
- Prebuilt assets downloaded from `https://github.com/copy/v86/releases/download/latest/`:

  | file         | sha256 | notes |
  |--------------|--------|-------|
  | `libv86.mjs` | `c4e0281ed9566edfcff54e4660c635f14d32e136104b475763b19ac87b891dc1` | ES module, exports `{V86, CPU}` + default `V86` |
  | `v86.wasm`   | `2fc5609ae837fcbc77147155de6f1014677ecab5369f5584ebc670e9d56e6510` | core (2.0 MB). A `v86-fallback.wasm` (no bulk-memory) also exists upstream |

## SeaBIOS / VGABIOS (LGPLv3)

- Source: v86 repo `bios/` at the pinned commit.
- `seabios.bin` sha256 `73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98`
- `vgabios.bin` sha256 `a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880`
- License: LGPL v3 — see `COPYING.LESSER.seabios`. SeaBIOS upstream: https://www.seabios.org/ ;
  VGABIOS (LGPL) https://web.archive.org/web/vgabios. Both are redistributed unmodified.

## Alpine Linux image (GPL/BSD/MIT mix — see each package)

Built Docker-free from official Alpine artifacts (`scripts/build-v86-image.sh`). Downloaded from
`https://dl-cdn.alpinelinux.org/alpine/`:

| component | file | version | sha256 | license |
|-----------|------|---------|--------|---------|
| minirootfs (userland: busybox, apk-tools, musl) | `latest-stable/releases/x86/alpine-minirootfs-3.24.2-x86.tar.gz` | Alpine 3.24.2 (x86 / i686) | `757f07c5a3476ba3947cfbea2323b7f02fb6fb2fba8a3a3c2b9d17f0a54c9226` | BusyBox **GPL-2.0**, musl **MIT**, apk-tools **GPL-2.0** |
| Linux kernel (linux-virt) | `v3.24/main/x86/linux-virt-6.18.56-r0.apk` | kernel `6.18.56-0-virt` | `8b56a33ea4e3080ce71a3bec2a847d8fb79ec19553636078dd71392750b47813` | **GPL-2.0** |
| busybox-static (for the initramfs) | `v3.24/main/x86/busybox-static-1.37.0-r31.apk` | BusyBox 1.37.0 | `26d45cc895b3fa99ba7500d0860c3934a363e74e464eeb5fc623f08147c33cfd` | **GPL-2.0** |

Alpine source / build recipes (aports) for GPL compliance: https://gitlab.alpinelinux.org/alpine/aports
(tag `v3.24.2`), packages `main/busybox`, `main/busybox` (busybox-static subpackage),
`main/linux-virt` (= `main/linux-lts`/`linux` aport), `main/musl`, `main/apk-tools`.
The kernel `.config` used is shipped inside the apk at `/boot/config-6.18.56-0-virt` and is copied
into the build tree for reference.

### What we assemble (no Docker, no root, no loop mounts)

1. Extract the minirootfs; add a tiny `/sbin/init` that mounts /proc,/sys,/dev,/tmp, creates
   `/workspace`, **brings up the virtio NIC** (insmods the pre-gunzipped `failover` /
   `net_failover` / `virtio_net` chain, then `192.168.86.100/24` + default route `192.168.86.1`
   and `nameserver 192.168.86.1`), disables TTY echo, prints `V86_BOOT_READY`, and `exec`s a
   shell on `ttyS0` via **`setsid -c /bin/sh`** so the shell owns a controlling terminal and
   enables job control (so a serial Ctrl-C `\x03` delivers SIGINT to the foreground command —
   see the cancellation design in `browser-v86.js`).
2. Build a minimal **initramfs** (`/boot/initramfs-virt`, a gzipped newc cpio created by
   `scripts/mkcpio.mjs`) containing busybox-static + the gunzipped 9p modules
   (`netfs`, `9pnet`, `9pnet_virtio`, `9p`) and an `/init` that insmods them and `switch_root`s
   onto the 9p root. (The kernel has `CONFIG_VIRTIO_PCI=y` builtin but 9p/netfs as modules, and
   `CONFIG_MODULE_DECOMPRESS` is **off**, so modules are gunzipped at build time.)
3. Place `/boot/vmlinuz-virt` + `/boot/initramfs-virt` into the rootfs; v86 pulls them from the
   9p filesystem via `bzimage_initrd_from_filesystem`.
4. **Trim** the image: drop all of `/lib/modules` except the 9p-root chain
   (`netfs`, `9pnet`, `9pnet_virtio`, `9p`) and the virtio-net chain
   (`failover`, `net_failover`, `virtio_net`), each **pre-gunzipped to plain `.ko`** so the guest
   can `insmod` them without an in-kernel decompressor (saves ~20 MB vs the full module tree). A
   minimal `modules.dep`/`modules.alias` is written so `modprobe <name>` also works. Also drop
   `usr/share/man`, `usr/share/doc`, `usr/share/info`, `usr/share/i18n`,
   `usr/share/locale` and the apk cache.
5. Convert the rootfs tree to v86's 9p format with upstream `tools/fs2json.py` +
   `tools/copy-to-sha256.py` (uncompressed flat files; zstd optional, not used here).
6. Take a **state snapshot**: cold-boot the image once (`scripts/v86-snapshot.mjs save`), then
   `save_state()` after `V86_BOOT_READY`, gzip it to `image/alpine-state.bin.gz`. The snapshot is
   **config-bound**: it is restored only with the SAME memory size (256 MB) and `net_device`
   type (`virtio`), which `ENGINE_DEFAULTS` in `browser-v86-worker.js` and this script share.

The original shipped image retains `apk` and its TLS libraries. The v2 toolset candidate below
uses a genuine APK transaction, preserving the supported package database and scripts/triggers.
The earlier data-only v1 candidate was rejected and is **not promotable**.
GPL/MIT/BSD obligations are unchanged by trimming.

## Build-time tools image (v2; published here since the execution runner)

The build now defaults to `<workspace>/build/v86/vendor/v86/image`, **outside this repository**.
`V86_OUT` selects the intermediate directory; `V86_DELIVER` selects an explicit delivery
`.../image` directory. Delivery into repository `apps/browser/vendor/` or `dist/` is refused.
The script copies the pinned engine/BIOS assets to the candidate's parent vendor directory and
passes that complete isolated root to `v86-snapshot.mjs` using `V86_VENDOR`. The snapshot helper
imports the owning core-execution worker (not the removed host twin). No build writes the
currently shipped image. Promotion is a separate parent-reviewed action: the v2 build
(basefs a32755e3…, snapshot 217824fa…; candidate manifest a7a4874f…) was promoted into
`image/` after review. Files over 1 MB are excluded from Git history (.git/info/exclude) and
must be rebuilt with this script or copied from a reviewed build.

`scripts/alpine-toolset.lock.json` locks the added/updated toolset: **41 packages**,
including exact x86 versions, official HTTPS artifact URLs, SHA256 hashes, all hard dependencies
and providers, SPDX license expressions, project URLs, origin aports names, and exact aports
recipe commits. Its SHA256 is
`e4ddd5f5ff95142233a0b50151a46638af1724aaeaf13c302e824c535a2a833b`.
The lock is copied into the guest as `/etc/alpine-toolset.json`. The pinned minirootfs, kernel,
busybox-static and upstream conversion tools are also hash-verified before use. No Alpine,
kernel, emulator or BIOS pin changed.

Selected command packages:

| Package | Version | Purpose / license |
|---|---|---|
| bash | 5.3.9-r1 | core-servers' explicit `bash -lc`; GPL-3.0-or-later |
| tmux | 3.7c-r0 | same-VM detached sessions, reattach/stop; ISC |
| curl | 8.22.0-r0 | HTTPS + health checks; curl |
| ca-certificates-bundle | 20260909-r0 | pre-generated Mozilla trust bundle; MPL-2.0 AND MIT |
| git | 2.54.0-r0 | local Git; GPL-2.0-only |
| coreutils (+ env/fmt/sha512sum required splits) | 9.11-r0 | GNU cut/stat/readlink/tail etc.; GPL-3.0-or-later |
| findutils | 4.10.0-r1 | GNU find/xargs; GPL-3.0-or-later |
| grep | 3.12-r0 | GNU grep; GPL-3.0-or-later |
| sed | 4.9-r2 | GNU sed; GPL-3.0-or-later |
| gawk | 5.3.2-r2 | GNU awk; GPL-3.0-or-later |
| procps-ng | 4.0.6-r0 | ps/pgrep/pkill; GPL-2.0-or-later AND LGPL-2.1-or-later |
| flock | 2.42.3-r1 | small util-linux split; MIT |
| jq | 1.8.2-r0 | existing core-servers JSON helper dependency; MIT |

Full util-linux-misc would add unrelated disk/system utilities and dependencies. It is omitted:
BusyBox supplies `setsid` and `getent`, including init's **explicit BusyBox `setsid -c`**
controlling-terminal setup. `flock` is the needed util-linux split. Ripgrep is omitted as not
required by current server scripts; GNU grep/find cover the acceptance commands. No ssh client,
Git remote operation, fake apt-get, supervisor, or runtime provisioning was added.

### Genuine APK transaction, provenance and reproduction

`alpine-toolset.py` downloads a pinned official **apk-tools-static 3.0.8-r0** for the host
(aarch64 or x86_64), checks both archive and executable SHA256 and native ELF architecture,
and extracts only the regular `sbin/apk.static` file as data. It executes that trusted static
package manager with `--root <isolated-rootfs> --arch x86 --no-network --no-scripts` for
**every** transaction. No package install/trigger scripts or guest executables run on the
host. No host toolchain/package installation is required. This is rootless; the build must be
able to write its own staging tree.

All x86 archives are SHA256-verified first. APK additionally verifies official signatures using
keys already present in the pinned minirootfs (no `--allow-untrusted` or force-overwrite).
APK itself writes `/lib/apk/db/installed`, ownership/checksums, `scripts.tar.gz`, `triggers`, and
world state; no package database or file ownership records are invented. Genuine APK `del`
and `add` transactions remove temporary checksum-pinned dependency roots introduced by local
file installation, leaving the original world roots plus requested tools. Dependencies remain
installed through the genuine dependency graph; future deliberate package operations are not
blocked by accidental checksum pins. All 52 resulting package records are audited: base records
are preserved, every locked version matches, and non-toolset base versions are unchanged.
OpenSSL is correctly recorded as libssl3/libcrypto3 3.5.9-r0 (up from base 3.5.8-r0).
GNU replacements, including awk/cat links and ownership, are installed by APK's package
replacement rules, not manual alternatives edits. BusyBox remains installed and init still
calls `/bin/busybox` explicitly. Every rootfs ELF is checked for ELF32 little-endian EM_386
(137 objects in the candidate).

The host intentionally suppresses package scripts: e.g. Bash's optional `add-shell` post-install
registration is not run. Package script/trigger metadata remains available for normal **guest**
APK transactions; functional Bash does not depend on changing `/etc/shells`. The selected
`ca-certificates-bundle` is pre-generated data with no certificate-update install trigger, so
no trust-store generation is omitted.

Use the already pinned official minirootfs plus the committed lock, not a fresh rolling index,
for normal builds. The lock records the exact SHA256 of the index consulted during selection;
that index is discovery evidence, not a build input. Missing exact APK URLs fail closed: use an
archived artifact with the same digest, or deliberately review a lock update; never silently
resolve newer packages. Recipes/source mappings for each dependency are
`https://gitlab.alpinelinux.org/alpine/aports/-/tree/<aports_commit>/main/<origin>` using the
lock's fields. Recipe `source=` and checksums identify upstream source archives and patches;
retain corresponding source/license notices with any redistribution. The lock also records
host-tool licenses/source recipes and the tiny `tree` test APK (not installed into the image).
The genuine `/lib/apk/db/installed` is the complete installed inventory, including base packages;
`/etc/alpine-toolset.json` supplements it with reproducible build inputs, not a replacement DB.

The CA bundle is the packaged, pre-generated `/etc/ssl/certs/ca-certificates.crt`; no host CA
store is copied and no untrusted certificate-update hooks run. curl's normal certificate and
hostname verification passed against public `https://example.com/` through the guest TCP
bridge; no `-k`, credentials, or custom trust were used. Guest licenses are no longer explicitly
removed by the trim step; missing package notices still require source/recipe retention above.

```sh
V86_OUT="$PWD/../build/alpine-toolset-candidate-v2" bash scripts/build-v86-image.sh
# Download the tree fixture to workspace scratch using its URL and SHA256 in test_packages.
V86_TOOLSET_VENDOR="$PWD/../build/alpine-toolset-candidate-v2/vendor/v86" \
  V86_TOOLSET_TEST_APK="$PWD/../build/alpine-tools-research/tree-2.3.2-r0.apk" \
  V86_TOOLSET_HTTPS=1 node --test tests/alpine-toolset.test.mjs
python3 tests/alpine-toolset.test.py
```

Build input hashes and payloads are locked. Initramfs gzip suppresses filename/time headers;
basefs metadata normalizes order, timestamps, directory sizes and host ownership. VM saved
state remains timing/clock-dependent, so byte-identical snapshot reproduction is **not**
claimed. Keep a manifest of each actual candidate's hashes.

Acceptance is limited to tools: real guest GNU/process commands; tmux spawn, client
attach/detach in another command in the **same VM**, stop, access/update-environment syntax;
local Git init/add/commit with a generated isolated test identity; CA-verified public HTTPS;
`apk info` version checks for all 41 locked packages and ownership of bash/tmux/curl/git/OpenSSL,
GNU replacements and BusyBox; offline `apk fix --simulate` with no proposed package changes;
a signed local `tree` APK install/remove in a disposable VM, running the genuine BusyBox
trigger in the **guest** and returning to the original world/52 package count while retaining
GNU command ownership/functionality. This does **not** enable core-servers or establish supervised browser-server correctness:
default JavaScript vs explicit Linux, command-scoped cancellation, merged stderr, copy-based
workspace/size limits, shared VM/tab lifetime, and browser secrets remain separate runtime
work. Existing explicit identity/authentication rules remain unchanged.

### 9pnet_fd kept (live /workspace)

`scripts/build-v86-image.sh` now also keeps the `9pnet_fd` kernel module (9p over TCP; `KEEP_MODULES` and
`modules.dep`), so the guest can mount the page VFS over the virtual NIC as its live `/workspace` (the
only mode; plugins/exec-linux/web/browser/p9-server.js). The promoted image is the
phase-1 build of this script (same Alpine/kernel/toolset/emulator pins; two module-metadata files and the
module changed). The boot snapshot does not have the module loaded; the live mount loads it on demand.
