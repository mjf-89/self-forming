#!/usr/bin/env bash
# Build a small Alpine Linux (i686) 9p image for v86 WITHOUT Docker, root, or loop mounts,
# then take a post-boot STATE SNAPSHOT (shell ready + NIC up) for fast restores.
#
# Deliverables default to NONLIVE $OUT/vendor/v86/image. V86_DELIVER overrides the image
# directory; shipped vendor output is refused. Publication is a separate reviewed action:
#   apps/browser/vendor/v86/image/alpine-fs.json        v86 9p basefs (file tree)
#   apps/browser/vendor/v86/image/flat/*.bin            content-addressed flat files (lazy-loaded)
#   apps/browser/vendor/v86/image/alpine-state.bin.gz   gzip'd post-boot snapshot (default boot path)
#
# Intermediate build products live under $OUT (default <workspace>/build/v86): dl/, alpine/, image/.
#
# Requires: curl, GNU tar, gzip, python3 (v86's fs2json.py/copy-to-sha256.py), node (>=18).
# Input pins: this script + alpine-toolset.lock.json; provenance in vendor/v86/PROVENANCE.md.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SELF_DIR/.." && pwd)"
OUT="${OUT:-$REPO/../build/v86}"
OUT="$(realpath -m "${V86_OUT:-$OUT}")"
VENDOR="$REPO/apps/browser/vendor/v86"
case "$OUT/" in "$REPO/apps/browser/vendor/"*|"$REPO/dist/"*) echo 'Refusing intermediates in shipped vendor/dist tree' >&2; exit 1;; esac
# Default to NONLIVE staging. Publishing into vendor is a separate, explicit parent action.
DELIVER="${V86_DELIVER:-$OUT/vendor/v86/image}"
DELIVER="$(realpath -m "$DELIVER")"
case "$DELIVER/" in "$REPO/apps/browser/vendor/"*|"$REPO/dist/"*) echo 'Refusing delivery into shipped vendor/dist tree' >&2; exit 1;; esac
[ "$(basename "$DELIVER")" = image ] || { echo 'V86_DELIVER must end in /image (snapshot layout)' >&2; exit 1; }
mkdir -p "$OUT"/{dl,alpine,image/flat,bios,tools,src}

# ---- pinned versions ------------------------------------------------------------------------
ALPINE_BRANCH="v3.24"
ALPINE_REL="latest-stable"
MINIROOTFS="alpine-minirootfs-3.24.2-x86.tar.gz"
LINUX_VIRT="linux-virt-6.18.56-r0.apk"
BUSYBOX_STATIC="busybox-static-1.37.0-r31.apk"
V86_COMMIT="94faf3d6b19ecabc53a4010aaa24252fa6a162e2"
CDN="https://dl-cdn.alpinelinux.org/alpine"
RAW="https://raw.githubusercontent.com/copy/v86/$V86_COMMIT"

# Kernel modules kept in the rootfs: only the 9p-root chain (+ 9pnet_fd for the live /workspace
# 9p-over-TCP mount served by the page) and the virtio-net chain. They are
# pre-gunzipped to plain .ko so the guest can `insmod` them directly (the kernel is built with
# CONFIG_MODULE_DECOMPRESS=off, so it cannot read .ko.gz). Everything else under /lib/modules is
# dropped (saves ~20 MB). Order matters: dependencies first.
KEEP_MODULES="kernel/fs/netfs/netfs kernel/net/9p/9pnet kernel/net/9p/9pnet_virtio kernel/net/9p/9pnet_fd kernel/fs/9p/9p kernel/net/core/failover kernel/drivers/net/net_failover kernel/drivers/net/virtio_net"
NET_CHAIN="failover net_failover virtio_net"   # insmod order for NIC bring-up

echo "== downloading sources =="
cd "$OUT/dl"
[ -f "$MINIROOTFS" ]     || curl -fLsS -O "$CDN/$ALPINE_REL/releases/x86/$MINIROOTFS"
[ -f "$LINUX_VIRT" ]     || curl -fLsS -O "$CDN/$ALPINE_BRANCH/main/x86/$LINUX_VIRT"
[ -f "$BUSYBOX_STATIC" ] || curl -fLsS -O "$CDN/$ALPINE_BRANCH/main/x86/$BUSYBOX_STATIC"
for t in tools/fs2json.py tools/copy-to-sha256.py; do
  [ -f "$OUT/$t" ] || curl -fLsS -o "$OUT/$t" "$RAW/$t"
done

# Verify all downloaded inputs before extracting or executing them.
(cd "$OUT/dl" && sha256sum -c <<SUMS
757f07c5a3476ba3947cfbea2323b7f02fb6fb2fba8a3a3c2b9d17f0a54c9226  $MINIROOTFS
8b56a33ea4e3080ce71a3bec2a847d8fb79ec19553636078dd71392750b47813  $LINUX_VIRT
26d45cc895b3fa99ba7500d0860c3934a363e74e464eeb5fc623f08147c33cfd  $BUSYBOX_STATIC
SUMS
)
(cd "$OUT/tools" && sha256sum -c <<'SUMS'
546b0ce7d0b172fa855587209318a8d473bce6de23fa327ceeb5b6c115fda23f  fs2json.py
7bfb94736afbb9753b6deea922184eec2f9b205be0214bc5f9866cf990bfa77c  copy-to-sha256.py
SUMS
)

echo "== extracting kernel + busybox-static (apk = concatenated gzip tar) =="
cd "$OUT/alpine"
rm -rf kern bbs; mkdir -p kern bbs
tar -xzf "$OUT/dl/$LINUX_VIRT" -C kern 2>/dev/null || true
tar -xzf "$OUT/dl/$BUSYBOX_STATIC" -C bbs 2>/dev/null || true
KV="$(ls kern/lib/modules | head -1)"
echo "   kernel modules version: $KV"

echo "== building initramfs (9p root + switch_root) =="
rm -rf initramfs; mkdir -p initramfs/{bin,lib/modules,proc,sys,dev,newroot}
cp bbs/bin/busybox.static initramfs/bin/busybox; chmod 755 initramfs/bin/busybox
md="kern/lib/modules/$KV"
gunzip -c "$md/kernel/fs/netfs/netfs.ko.gz"      > initramfs/lib/modules/netfs.ko
gunzip -c "$md/kernel/net/9p/9pnet.ko.gz"        > initramfs/lib/modules/9pnet.ko
gunzip -c "$md/kernel/net/9p/9pnet_virtio.ko.gz" > initramfs/lib/modules/9pnet_virtio.ko
gunzip -c "$md/kernel/fs/9p/9p.ko.gz"            > initramfs/lib/modules/9p.ko
cat > initramfs/init <<'EOF'
#!/bin/busybox sh
BB=/bin/busybox
$BB mount -t proc proc /proc
$BB mount -t sysfs sys /sys
$BB mount -t devtmpfs dev /dev
echo "[v86-initramfs] loading 9p modules"
for m in netfs 9pnet 9pnet_virtio 9p; do $BB insmod /lib/modules/$m.ko; done
echo "[v86-initramfs] mounting 9p root (host9p)"
$BB mount -t 9p -o trans=virtio,version=9p2000.L,cache=loose,msize=512000 host9p /newroot
[ -x /newroot/sbin/init ] || { echo "[v86-initramfs] no /newroot/sbin/init"; exec $BB sh; }
$BB mount --move /proc /newroot/proc 2>/dev/null
$BB mount --move /sys /newroot/sys 2>/dev/null
$BB mount --move /dev /newroot/dev 2>/dev/null
exec $BB switch_root /newroot /sbin/init
EOF
chmod 755 initramfs/init
node "$SELF_DIR/mkcpio.mjs" initramfs initramfs.cpio
gzip -n -9 -c initramfs.cpio > initramfs-virt

echo "== assembling rootfs =="
rm -rf rootfs; mkdir -p rootfs
tar -xzf "$OUT/dl/$MINIROOTFS" -C rootfs 2>/dev/null || true
mkdir -p rootfs/boot
cp kern/boot/vmlinuz-virt rootfs/boot/vmlinuz-virt
cp initramfs-virt rootfs/boot/initramfs-virt

python3 "$SELF_DIR/alpine-toolset.py" install "$SELF_DIR/alpine-toolset.lock.json" "$OUT/dl" "$OUT/alpine/rootfs"

echo "== trimming /lib/modules (keep 9p + virtio-net chains, pre-gunzipped) =="
rm -rf rootfs/lib/modules
DST="rootfs/lib/modules/$KV"
mkdir -p "$DST"
for m in $KEEP_MODULES; do
  mkdir -p "$DST/$(dirname "$m")"
  gunzip -c "$md/$m.ko.gz" > "$DST/$m.ko"
done
# Minimal module metadata (plain .ko paths) so `modprobe <name>` also works as a convenience;
# /sbin/init uses insmod with absolute paths and does not depend on this.
cat > "$DST/modules.dep" <<DEP
kernel/fs/netfs/netfs.ko:
kernel/net/9p/9pnet.ko: kernel/fs/netfs/netfs.ko
kernel/net/9p/9pnet_virtio.ko: kernel/net/9p/9pnet.ko kernel/fs/netfs/netfs.ko
kernel/net/9p/9pnet_fd.ko: kernel/net/9p/9pnet.ko kernel/fs/netfs/netfs.ko
kernel/fs/9p/9p.ko: kernel/net/9p/9pnet.ko kernel/fs/netfs/netfs.ko
kernel/net/core/failover.ko:
kernel/drivers/net/net_failover.ko: kernel/net/core/failover.ko
kernel/drivers/net/virtio_net.ko: kernel/drivers/net/net_failover.ko kernel/net/core/failover.ko
DEP
cat > "$DST/modules.alias" <<'ALIAS'
alias pci:v00001AF4d00001000sv*sd*bc*sc*i* virtio_net
alias pci:v00001AF4d00001041sv*sd*bc*sc*i* virtio_net
ALIAS
: > "$DST/modules.order"; : > "$DST/modules.builtin"; : > "$DST/modules.symbols"; : > "$DST/modules.devname"

echo "== dropping docs / man / locales / extra apk cache =="
rm -rf rootfs/usr/share/man rootfs/usr/share/doc rootfs/usr/share/info \
       rootfs/usr/share/i18n rootfs/usr/share/locale \
       rootfs/var/cache/apk/* 2>/dev/null || true

echo "== writing /sbin/init (serial shell + NIC up, static IP) =="
rm -f rootfs/sbin/init
# NOTE: KV is substituted in so insmod uses absolute module paths.
cat > rootfs/sbin/init <<EOF
#!/bin/busybox sh
export PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root TERM=linux PS1=''
BB=/bin/busybox
KV='$KV'
NET_CHAIN='$NET_CHAIN'
EOF
cat >> rootfs/sbin/init <<'EOF'
$BB mount -t proc proc /proc 2>/dev/null
$BB mount -t sysfs sys /sys 2>/dev/null
$BB mount -t devtmpfs dev /dev 2>/dev/null
$BB mount -t tmpfs tmpfs /tmp 2>/dev/null
$BB mkdir -p /dev/pts && $BB mount -t devpts devpts /dev/pts 2>/dev/null
$BB mkdir -p /workspace
$BB hostname localhost 2>/dev/null
# Bring up the virtio NIC: insmod the chain (pre-gunzipped .ko) and set a static address so the
# snapshot is taken with networking already configured. The in-page fake router is 192.168.86.1;
# outbound TCP is bridged to our transport by the host. DNS is answered in-page (synthetic IPs).
for m in $NET_CHAIN; do
  f=$($BB find /lib/modules/$KV -name "$m.ko" 2>/dev/null | $BB head -1)
  [ -n "$f" ] && $BB insmod "$f" 2>/dev/null
done
$BB ip addr add 192.168.86.100/24 dev eth0 2>/dev/null
$BB ip link set eth0 up 2>/dev/null
$BB ip route add default via 192.168.86.1 dev eth0 2>/dev/null
echo "nameserver 192.168.86.1" > /etc/resolv.conf
$BB stty -echo -onlcr < /dev/ttyS0 2>/dev/null
echo "V86_BOOT_READY"
# Give the shell a CONTROLLING TERMINAL in a fresh session with `setsid -c` (busybox issues
# TIOCSCTTY on its stdin, ttyS0) so the interactive shell enables JOB CONTROL: each foreground
# command runs in its own process group and a Ctrl-C (\x03) on the serial line delivers SIGINT to
# it. Without a ctty, sh is PID1 with "job control turned off" and \x03 is ignored, so command
# cancellation would have to fall back to a (slower) VM restart.
exec $BB setsid -c $BB sh < /dev/ttyS0 > /dev/ttyS0 2>&1
EOF
chmod 755 rootfs/sbin/init

echo "== converting to v86 9p basefs =="
rm -rf "$OUT/image/flat"; mkdir -p "$OUT/image/flat"
python3 "$OUT/tools/fs2json.py" --out "$OUT/image/alpine-fs.json" rootfs
python3 "$OUT/tools/copy-to-sha256.py" rootfs "$OUT/image/flat"
# Host directory sizes/order, ownership and build timestamps are not guest inputs.
python3 - "$OUT/image/alpine-fs.json" <<'PYJSON'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
def normalize(nodes):
    total = 0
    nodes.sort(key=lambda node: node[0])
    for node in nodes:
        node[2] = 0
        node[4] = node[5] = 0
        if isinstance(node[6], list):
            node[1] = 0
            total += normalize(node[6])
        else:
            total += node[1]
    return total
d['size'] = normalize(d['fsroot'])
with open(p, 'w') as f:
    json.dump(d, f, separators=(',', ':'))
PYJSON

echo "== verifying pinned engine assets and copying BIOS =="
(cd "$VENDOR" && sha256sum -c <<'SUMS'
c4e0281ed9566edfcff54e4660c635f14d32e136104b475763b19ac87b891dc1  libv86.mjs
2fc5609ae837fcbc77147155de6f1014677ecab5369f5584ebc670e9d56e6510  v86.wasm
73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98  seabios.bin
a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880  vgabios.bin
SUMS
)
cp "$VENDOR/seabios.bin" "$OUT/bios/seabios.bin"
cp "$VENDOR/vgabios.bin" "$OUT/bios/vgabios.bin"

echo "== installing basefs + flat files into isolated delivery tree =="
mkdir -p "$DELIVER/flat"
cp "$OUT/image/alpine-fs.json" "$DELIVER/alpine-fs.json"
rm -rf "$DELIVER/flat"; cp -R "$OUT/image/flat" "$DELIVER/flat"

FLAT_RAW=$(du -sb "$DELIVER/flat" | cut -f1)
echo "   alpine-fs.json $(stat -c%s "$DELIVER/alpine-fs.json") bytes"
echo "   flat files     $(du -sh "$DELIVER/flat" | cut -f1) ($FLAT_RAW bytes raw, $(ls "$DELIVER/flat" | wc -l) files)"

echo "== taking post-boot state snapshot (shell ready + NIC up) =="
# Boots the freshly-built image cold once and saves a gzip'd state snapshot used as the default
# (fast) boot path. The snapshot is config-bound: it must be restored with the SAME memory size
# and net_device type (ENGINE_DEFAULTS in the owning core-execution browser worker).
# Snapshot receives a complete isolated vendor root; never resolve image assets from live vendor.
for asset in libv86.mjs v86.wasm seabios.bin vgabios.bin; do
  cp "$VENDOR/$asset" "$(dirname "$DELIVER")/$asset"
done
V86_VENDOR="$(dirname "$DELIVER")" node "$SELF_DIR/v86-snapshot.mjs" save
echo "   alpine-state.bin.gz $(stat -c%s "$DELIVER/alpine-state.bin.gz" 2>/dev/null) bytes"

echo "DONE."
echo "  flat (raw):          $(du -sh "$DELIVER/flat" | cut -f1)"
echo "  flat (gz estimate):  $(cat "$DELIVER"/flat/*.bin | gzip -c | wc -c) bytes"
echo "  alpine-state.bin.gz: $(stat -c%s "$DELIVER/alpine-state.bin.gz" 2>/dev/null) bytes"
