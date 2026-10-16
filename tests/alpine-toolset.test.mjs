// Focused NONLIVE image acceptance. Never selects or mutates shipped/live images.
// V86_TOOLSET_VENDOR=/absolute/candidate/vendor/v86 node --test tests/alpine-toolset.test.mjs
// V86_TOOLSET_HTTPS=1 additionally verifies public https://example.com/ (no credentials).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createV86Engine } from '../plugins/exec-linux/web/browser/browser-v86-worker.js';

const vendor = process.env.V86_TOOLSET_VENDOR;
const lock = JSON.parse(fs.readFileSync(new URL('../scripts/alpine-toolset.lock.json', import.meta.url)));
const testApk = process.env.V86_TOOLSET_TEST_APK;
test('snapshot helper imports the owning worker; build isolates snapshot and image delivery', () => {
  const helper = fs.readFileSync(new URL('../scripts/v86-snapshot.mjs', import.meta.url), 'utf8');
  assert.match(helper, /import \{ createV86Engine \} from "\.\.\/plugins\/exec-linux\/web\/browser\/browser-v86-worker\.js"/);
  const build = fs.readFileSync(new URL('../scripts/build-v86-image.sh', import.meta.url), 'utf8');
  assert.match(build, /V86_DELIVER:-\$OUT\/vendor\/v86\/image/);
  assert.match(build, /V86_VENDOR="\$\(dirname "\$DELIVER"\)" node/);
  assert.match(build, /exec \$BB setsid -c \$BB sh/);
});

// Public-test-only TCP bridge. No credentials, relay settings, or host environment forwarded.
async function publicConnect(host, port) {
  assert.equal(host, 'example.com');
  assert.equal(port, 443);
  const socket = net.connect({ host, port });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const queue = [], waiting = [];
  let ended = false;
  const end = () => { ended = true; while (waiting.length) waiting.shift()(undefined); };
  socket.on('data', (b) => { const bytes = new Uint8Array(b); if (waiting.length) waiting.shift()(bytes); else queue.push(bytes); });
  socket.on('end', end); socket.on('close', end); socket.on('error', end);
  return {
    read() { return queue.length ? Promise.resolve(queue.shift()) : ended ? Promise.resolve(undefined) : new Promise(r => waiting.push(r)); },
    write(bytes) { socket.write(Buffer.from(bytes)); },
    close() { socket.destroy(); },
  };
}

test('candidate x86 tools, GNU/process semantics, tmux same-VM reattach/stop, isolated git',
  { skip: !vendor && 'set V86_TOOLSET_VENDOR to an isolated candidate', timeout: 180000 }, async (t) => {
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(vendor, 'image/alpine-state.bin.gz')));
    const engine = createV86Engine({
      assets: {
        libv86Url: pathToFileURL(path.join(vendor, 'libv86.mjs')).href,
        wasmPath: path.join(vendor, 'v86.wasm'), biosUrl: path.join(vendor, 'seabios.bin'),
        vgaBiosUrl: path.join(vendor, 'vgabios.bin'), basefsUrl: path.join(vendor, 'image/alpine-fs.json'),
        baseUrl: path.join(vendor, 'image/flat/'),
        stateBuffer: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
      }, connect: process.env.V86_TOOLSET_HTTPS === '1' ? publicConnect : null,
    });
    t.after(() => engine.dispose());
    await engine.boot();
    const run = async (command) => {
      let out = '';
      const r = await engine.run(command, { timeoutMs: 45000 }, chunk => out += chunk);
      assert.equal(r.exitCode, 0, out);
      t.diagnostic(out.trim());
      return out;
    };
    await run(`set -e; test "$(uname -m)" = i686; test "$(cat /etc/alpine-release)" = 3.24.2; test "$(uname -r)" = 6.18.56-0-virt; for c in bash tmux curl git find xargs grep sed awk ps pgrep pkill flock setsid getent jq cut stat readlink tail; do command -v "$c"; done; ! command -v apt-get; bash --version | head -1; tmux -V; curl --version | head -2; git --version; cat --version | head -1; find --version | head -1; grep --version | head -1; sed --version | head -1; awk --version | head -1; ps --version`);
    await run(`set -e; mkdir -p /tmp/toolset-check; cd /tmp/toolset-check; printf 'a\\nb\\na\\n' > text; test "$(grep -P '^a$' text | wc -l)" = 2; test "$(sed -n '2p' text)" = b; test "$(awk 'BEGIN {print 6*7}')" = 42; test "$(find . -name text -printf '%f')" = text; test "$(stat -c %s text)" = 6; test "$(readlink -f text)" = /tmp/toolset-check/text; tail -n 1 -- text | grep -qx a; getent passwd 0; flock /tmp/toolset-check/lock bash -lc 'echo lock-ok'; jq -e '.ok == true' <<EOF
{"ok":true}
EOF
ps -eo pid,ppid,pgid,sid,args | head -5; test -r /proc/self/stat; bash -lc 'sleep 60 & child=$!; pgrep -P $$ | grep -qx "$child"; pkill -TERM -P $$ -x sleep; wait "$child" || :; echo process-ok'`);
    await run(`set -e; tmux -L toolset -f /dev/null new-session -d -s probe "bash -lc 'echo pane-ready; exec sleep 120'"; tmux -L toolset has-session -t =probe; tmux -L toolset set-option -g update-environment 'DUMMY_TOOLSET_ONLY'; tmux -L toolset server-access -a nobody; tmux -L toolset server-access -d nobody; tmux -L toolset list-panes -t =probe -F '#{pane_pid}'; tmux -L toolset capture-pane -p -t probe:0.0`);
    // A new foreground command reuses the original VM/socket, actually attaches a client,
    // then detaches that client through the same tmux command queue (no timeout/reset).
    await run(`set -e; tmux -L toolset attach-session -t =probe \\; detach-client; tmux -L toolset has-session -t =probe; echo reattached-same-vm`);
    await run(`set -e; tmux -L toolset kill-session -t =probe; ! tmux -L toolset has-session -t =probe 2>/dev/null; tmux -L toolset kill-server 2>/dev/null || :; echo stopped`);
    await run(`set -e; mkdir /tmp/toolset-check/repo; cd /tmp/toolset-check/repo; export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null; git init -q; printf dummy > note; git add note; git -c user.name=Generated-Test-Identity -c user.email=generated-test@example.invalid commit -qm 'isolated generated test'; test "$(git rev-list --count HEAD)" = 1; test -z "$(git status --porcelain)"; echo local-git-ok`);
    await run(`set -e; test -s /etc/ssl/certs/ca-certificates.crt; grep -q 'BEGIN CERTIFICATE' /etc/ssl/certs/ca-certificates.crt; echo ca-bundle-present`);
    // Database and ownership come from genuine apk transactions, never a hand-written DB.
    for (const pkg of lock.packages) await run(`apk info -e '${pkg.name}=${pkg.version}'`);
    await run(`set -e; apk info -e alpine-baselayout alpine-keys alpine-release apk-tools busybox musl-utils; apk info -W /bin/bash /usr/bin/tmux /usr/bin/curl /usr/bin/git /usr/lib/libssl.so.3 /usr/lib/libcrypto.so.3 /bin/cat /usr/bin/awk /bin/busybox; cat /etc/apk/world; test "$(readlink /usr/bin/awk)" = gawk; test "$(readlink /bin/cat)" = coreutils`);
    const dryRun = await run(`apk --no-network fix --simulate`);
    assert.doesNotMatch(dryRun, /\b(?:Upgrading|Downgrading|Purging|Installing|Reinstalling)\b/);
    if (testApk) {
      const fixture = lock.test_packages.find(pkg => pkg.name === 'tree');
      const bytes = fs.readFileSync(testApk);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
      await engine.syncIn({ files: [{ path: '/workspace/tree-test.apk', bytes: new Uint8Array(bytes) }] });
      // This mutates ONLY the disposable running VM, not image files/snapshot source.
      // Normal guest transaction runs its genuine busybox trigger, proving that it
      // preserves package-owned GNU commands and the base BusyBox fallback.
      await run(`set -e; cp /etc/apk/world /tmp/world-before; apk --no-network add /workspace/tree-test.apk; apk info -e tree=${fixture.version}; tree --version; apk info -W /usr/bin/tree; apk --no-network del tree; ! apk info -e tree; cmp /tmp/world-before /etc/apk/world; apk info -W /bin/cat /usr/bin/awk /bin/busybox; cat --version | head -1; awk --version | head -1; /bin/busybox echo busybox-ok; echo genuine-apk-roundtrip-ok`);
      const after = await run(`apk --no-network fix --simulate`);
      assert.doesNotMatch(after, /\b(?:Upgrading|Downgrading|Purging|Installing|Reinstalling)\b/);
    } else t.diagnostic('Set V86_TOOLSET_TEST_APK to the hash-locked tree APK for guest install/remove acceptance.');
    if (process.env.V86_TOOLSET_HTTPS === '1') {
      await run(`set -e; curl --fail --silent --show-error --max-time 35 -o /tmp/toolset-check/https https://example.com/; grep -q 'Example Domain' /tmp/toolset-check/https; echo verified-public-https`);
    } else t.diagnostic('Public HTTPS not requested; certificate verification not claimed.');
  });
