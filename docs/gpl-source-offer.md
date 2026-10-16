# GPL / LGPL source offer for the browser Linux image

The browser edition's optional Linux environment (`apps/browser/vendor/v86/image/`, run by the v86 emulator) is a trimmed
Alpine Linux 3.24.2 (x86) system. It contains free software under the GPL, LGPL and other licences, listed below
with exact versions. Binaries are redistributed **unmodified** from the official Alpine packages (SHA-256 pinned in
`scripts/alpine-toolset.lock.json` and `apps/browser/vendor/v86/PROVENANCE.md`); the image only drops files (docs, locales, unused kernel modules).
The kernel's 9p/virtio modules are the stock `linux-virt` modules, gunzipped.

## Where to get the source

1. **Recipes and patches:** every package below links to its Alpine `aports` recipe at the exact commit the package was built from
   (the `APKBUILD` names the upstream source archives, checksums and Alpine's patches).
2. **Source archives:** Alpine mirrors the upstream tarballs at <https://distfiles.alpinelinux.org/distfiles/v3.24/>; upstream URLs are in each APKBUILD.
3. **Linux kernel:** <https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.18.56.tar.xz> plus Alpine's patches and `config-virt` in aports `main/linux-lts`; the exact config is also shipped in the image as `/boot/config-6.18.56-0-virt`.
4. **Written offer:** for at least three years after a release that contains this image, we will provide the complete corresponding source of any of these packages on request, for no more than the cost of physically performing the distribution. Ask by opening an issue at <https://github.com/mjf-89/self-forming/issues> titled "GPL source request".

The image's own `/lib/apk/db/installed` is the authoritative inventory (52 packages); `/etc/alpine-toolset.json` records the build inputs.

Other copyleft pieces in the browser edition: SeaBIOS and VGABIOS (LGPL-3.0, from the v86 repository at commit `94faf3d6b19ecabc53a4010aaa24252fa6a162e2`, `bios/`; text in `apps/browser/vendor/v86/COPYING.LESSER.seabios`), and the LGPL-3.0 libraries inside isomorphic-git's bundle (see `apps/browser/vendor/isomorphic-git/PROVENANCE.md`, unminified sources in its `.map`).

## Package inventory (Alpine v3.24, aports commit per recipe)

| Source (aport) | Version | Binary packages | Licence (as declared by Alpine) | Recipe |
|---|---|---|---|---|
| acl | 2.3.2-r1 | acl-libs | LGPL-2.1-or-later AND GPL-2.0-or-later | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/8bac74716d06c84627ab02d101fd9d2bafd0a34c/main/acl) |
| alpine-base | 3.24.2-r0 | alpine-release | MIT | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/d9d560d5de74ff9a7a73f3c903d6f126a0bf3142/main/alpine-base) |
| alpine-baselayout | 3.7.2-r1 | alpine-baselayout, alpine-baselayout-data | GPL-2.0-only | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/60a7585bbab2fa0f762504eb617dbca90216e31f/main/alpine-baselayout) |
| alpine-keys | 2.6-r0 | alpine-keys | MIT | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/b9f23becced4d7b3ccc0fa0f28530243ccd314a0/main/alpine-keys) |
| apk-tools | 3.0.8-r0 | apk-tools, libapk | GPL-2.0-only | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/4588b452722bd4800efdc6cce4f6e980e02a997f/main/apk-tools) |
| attr | 2.5.2-r2 | libattr | LGPL-2.1-or-later | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/40760f1909b662e8b9065217452a1782bad3dab1/main/attr) |
| bash | 5.3.9-r1 | bash | GPL-3.0-or-later | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/1522c3193610902d8493f9790a2755c11f21f26d/main/bash) |
| brotli | 1.2.0-r1 | brotli-libs | MIT | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/1ee249c9da168084b1c6c9f7488bdffa2ac33c84/main/brotli) |
| busybox | 1.37.0-r31 | busybox, busybox-binsh, ssl_client | GPL-2.0-only | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/c3ef5d10e6ef6528852c51f0564963e2f8c1be19/main/busybox) |
| c-ares | 1.34.8-r0 | c-ares | MIT | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/138a6bf9dea5974644e48fef4826b7c474f2f7d8/main/c-ares) |
| ca-certificates | 20260909-r0 | ca-certificates-bundle | MPL-2.0 AND MIT | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/eb7078df3a16d666e8f7723f94bb92e00d4b9236/main/ca-certificates) |
| coreutils | 9.11-r0 | coreutils, coreutils-env, coreutils-fmt, coreutils-sha512sum | GPL-3.0-or-later | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/8e261cdab4fd1bc77881cbff73b9ea962e9bd49f/main/coreutils) |
| curl | 8.22.0-r0 | curl, libcurl | curl | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/ab53c408436ac7199ed5b67bde204aaca73003bd/main/curl) |
| expat | 2.8.5-r0 | libexpat | MIT | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/41a9605db84bb52cd65c6349e5e087c2c7fe9efb/main/expat) |
| findutils | 4.10.0-r1 | findutils | GPL-3.0-or-later | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/1a4e2ce6309586205b7e4c500c7ae287be39ea31/main/findutils) |
| gawk | 5.3.2-r2 | gawk | GPL-3.0-or-later | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/730f2f5bdc97be98b2beee33f55134c622e6189c/main/gawk) |
| gettext | 1.0-r0 | libintl | LGPL-2.1-or-later | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/a0b12dbf67fb047e79a1b76c6dfe6f2904d0d391/main/gettext) |
| git | 2.54.0-r0 | git | GPL-2.0-only | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/b3ed5f8f4ce6b2ef13adeaf7494557add6546bda/main/git) |
| grep | 3.12-r0 | grep | GPL-3.0-or-later | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/4cbb86a7e5760f0f92903377ef35da450df3e1e6/main/grep) |
| jq | 1.8.2-r0 | jq | MIT | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/2437351bfa2aecb328f0b859f4a4987476ae31c9/main/jq) |
| libevent | 2.1.13-r0 | libevent | BSD-3-Clause | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/7c5a7049c5779d87b9b4fa1c7d416056f7e30298/main/libevent) |
| libidn2 | 2.3.8-r0 | libidn2 | GPL-2.0-or-later OR LGPL-3.0-or-later | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/8240e09aa2fdd8f9979b2016be082273965aff0c/main/libidn2) |
| libpsl | 0.21.5-r3 | libpsl | MIT | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/6bd45b53fb316dc01bda59f5feaf1e127eb64f22/main/libpsl) |
| libunistring | 1.4.2-r0 | libunistring | GPL-2.0-or-later OR LGPL-3.0-or-later | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/30d9f19340385b2cd16eaf1cc6a9a8b30c4afe1c/main/libunistring) |
| linux-lts | 6.18.56-r0 | linux-virt | GPL-2.0-only | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/efc8ddbb20c827d2bd8223c19a2625e754e5cb3c/main/linux-lts) |
| musl | 1.2.6-r2 | musl, musl-utils | MIT; MIT AND BSD-2-Clause AND GPL-2.0-or-later | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/f5640d3a10f664c9119720c60515265d3d6f6d01/main/musl) |
| ncurses | 6.6_p20260516-r0 | libncursesw, ncurses-terminfo-base | X11 | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/2cee8a7328d061418336ad327b512d96bcd7bc5e/main/ncurses) |
| nghttp2 | 1.70.0-r0 | nghttp2-libs | MIT | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/d5a34efc88bbe8d18737fda28125071c4aef8517/main/nghttp2) |
| oniguruma | 6.9.10-r0 | oniguruma | BSD-2-Clause | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/31082e89063dfb6b02af0b38c46af803a118137a/main/oniguruma) |
| openssl | 3.5.9-r0 | libcrypto3, libssl3 | Apache-2.0 | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/29b9ec24b1b5b39aeef51fa2a044210e2ec5258e/main/openssl) |
| pax-utils | 1.3.9-r1 | scanelf | GPL-2.0-only | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/c61801eeacb3ffcd9c2025b09e402153bb93fb39/main/pax-utils) |
| pcre2 | 10.49-r0 | pcre2 | BSD-3-Clause | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/3d497cbb3217749c4fb85f90f3b6f7908b0c1f95/main/pcre2) |
| procps-ng | 4.0.6-r0 | libproc2, procps-ng | GPL-2.0-or-later AND LGPL-2.1-or-later | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/99d7511b57e55bc8c6def72765dc59cedbe7e9e5/main/procps-ng) |
| readline | 8.3.3-r1 | readline | GPL-3.0-or-later | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/a854c03acdac188901fb012f7acbee70a36e8041/main/readline) |
| sed | 4.9-r2 | sed | GPL-3.0-or-later | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/84a227baf001b6e0208e3352b294e4d7a40e93de/main/sed) |
| skalibs | 2.15.0.0-r0 | skalibs-libs | ISC | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/f148233038fa9b35932a7996df29f110b32c2160/main/skalibs) |
| tmux | 3.7c-r0 | tmux | ISC | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/837717d6f763da6b2a19d37888ea455dbcb83062/main/tmux) |
| util-linux | 2.42.3-r1 | flock | MIT | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/d98c55af59055e6ca60fbe36e171546918709965/main/util-linux) |
| utmps | 0.1.3.3-r0 | utmps-libs | ISC | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/900a4ecef77ae677eab8243b99f2c40cbf8ea35b/main/utmps) |
| zlib | 1.3.2-r1 | zlib | Zlib | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/0afa2da0e8c8051c6f8f64a7a388e5a259904245/main/zlib) |
| zstd | 1.5.7-r2 | zstd-libs | BSD-3-Clause OR GPL-2.0-or-later | [APKBUILD](https://gitlab.alpinelinux.org/alpine/aports/-/tree/3c6e2ee2b16f403d53eab39c4426eb61f003c322/main/zstd) |
