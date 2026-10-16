// Minimal newc cpio packer (no `cpio` tool is available in the build env).
// Produces an uncompressed cpio archive of <srcdir>; gzip it for a Linux initramfs.
// Usage: node scripts/mkcpio.mjs <srcdir> <out.cpio>
import fs from "node:fs";
import path from "node:path";

const [srcdir, out] = process.argv.slice(2);
if (!srcdir || !out) { console.error("usage: mkcpio.mjs <srcdir> <out.cpio>"); process.exit(1); }

const chunks = [];
let ino = 721;
const hex8 = (n) => (n >>> 0).toString(16).padStart(8, "0").slice(-8);
const pad4 = (len) => (4 - (len % 4)) % 4;
const S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;

function entry({ name, mode, data = Buffer.alloc(0), nlink = 1 }) {
  const nameBuf = Buffer.from(name + "\0", "utf8");
  const header = "070701" + hex8(ino++) + hex8(mode) + hex8(0) + hex8(0) +
    hex8(nlink) + hex8(0) + hex8(data.length) + hex8(0) + hex8(0) +
    hex8(0) + hex8(0) + hex8(nameBuf.length) + hex8(0);
  const h = Buffer.from(header, "ascii");
  chunks.push(h, nameBuf, Buffer.alloc(pad4(h.length + nameBuf.length)));
  if (data.length) chunks.push(data, Buffer.alloc(pad4(data.length)));
}

function walk(dir, prefix) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = fs.lstatSync(full);
    if (st.isDirectory()) { entry({ name: rel, mode: S_IFDIR | (st.mode & 0o7777), nlink: 2 }); walk(full, rel); }
    else if (st.isSymbolicLink()) entry({ name: rel, mode: S_IFLNK | 0o777, data: Buffer.from(fs.readlinkSync(full), "utf8") });
    else if (st.isFile()) entry({ name: rel, mode: S_IFREG | (st.mode & 0o7777), data: fs.readFileSync(full) });
  }
}

walk(srcdir, "");
entry({ name: "TRAILER!!!", mode: 0, nlink: 1 });
fs.writeFileSync(out, Buffer.concat(chunks));
console.error(`wrote ${out} (${fs.statSync(out).size} bytes)`);
