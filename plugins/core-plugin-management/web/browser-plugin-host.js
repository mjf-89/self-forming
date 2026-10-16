// Owner of browser installation/lifecycle. Thin host supplies its shared workspace and
// deployed built-in IDs. No native, credential, allow-list or event implementation.
import { ID, HASH, MAX_FILES, MAX_BYTES, MAX_MANIFEST, canonicalPath, packageHash, validatePackage, fail } from "./browser-plugin-package.js";
import { openPluginStore } from "./browser-plugin-store.js";

async function capture(vfs, root) {
  const files = Object.create(null);
  let count = 0, bytes = 0, nodes = 0;
  async function visit(path, relative = "") {
    if (++nodes > 16384) fail("Plugin source tree is too large");
    const node = vfs.get(path);
    if (!node || !["file","directory"].includes(node.kind)) fail("Missing file or unsupported file kind (symlinks forbidden)");
    if (relative === "web/skills" && node.kind !== "directory") fail("web/skills must contain skill directories");
    if (/^web\/skills\/[^/]+$/.test(relative) && (node.kind !== "directory" || !vfs.get(`${path}/SKILL.md`) || vfs.get(`${path}/SKILL.md`).kind !== "file")) fail("Each skill folder needs SKILL.md");
    if (node.kind === "directory") {
      for (const name of vfs.readdir(path)) {
        const child = typeof name === "string" ? name : name.name;
        canonicalPath(child);
        await visit(`${path}/${child}`, relative ? `${relative}/${child}` : child);
      }
    } else {
      canonicalPath(relative);
      if (relative !== "plugin.json" && !relative.startsWith("web/")) return;
      if (++count > MAX_FILES || (bytes += node.size) > MAX_BYTES || (relative === "plugin.json" && node.size > MAX_MANIFEST)) fail("Plugin size/count limit exceeded");
      const data = (await vfs.read(path)).slice();
      if (data.byteLength !== node.size) fail("Plugin source changed during capture");
      files[relative] = data;
    }
  }
  if (vfs.exists(`${root}/skills`)) fail("Plugin skills must be under web/skills/");
  await visit(root);
  return files;
}

export async function createBrowserPlugins({ vfs, builtinIds, safe = false, assetBase, store, serving = true } = {}) {
  if (!Array.isArray(builtinIds) || !builtinIds.length) fail("Missing deployed built-in inventory");
  store ??= await openPluginStore();
  const bootSelections = new Map((await store.selections()).map(s => [s.id, s]));
  const pins = new Map(); // page lifetime; old immutable snapshots are retained, never GC'd here
  let queue = Promise.resolve();
  const enabled = () => store.durable === true && (typeof serving === "function" ? serving() : serving);
  const serialized = fn => (...args) => {
    const run = queue.then(() => { if (!enabled()) fail("Installed plugin serving is unavailable", "PLUGIN_UNAVAILABLE"); return fn(...args); });
    queue = run.catch(() => {});
    return run;
  };
  const verify = async (id,hash) => {
    if (!ID.test(id) || !HASH.test(hash) || builtinIds.includes(id)) fail("Invalid installed revision");
    const snapshot = await store.snapshot(id,hash);
    if (!snapshot) fail("Missing immutable plugin snapshot");
    const manifest = validatePackage(snapshot.files,builtinIds);
    if (await packageHash(snapshot.files) !== hash) fail("Corrupt immutable plugin snapshot");
    if (manifest.id !== id) fail("Snapshot identity mismatch");
    return { ...snapshot, manifest };
  };
  const select = async (id, action) => {
    if (typeof id !== "string" || !ID.test(id) || builtinIds.includes(id)) fail("Invalid installed plugin ID");
    const current = await store.selection(id);
    if (!current) fail("Plugin is not installed");
    const next = { ...current };
    if (action === "rollback") {
      if (!next.previous) fail("No previous revision");
      [next.hash,next.previous] = [next.previous,next.hash];
    } else next.enabled = action === "enable";
    // Disable must remain usable even when a snapshot is corrupt.
    if (action !== "disable") await verify(id,next.hash);
    await store.publish(null,next);
    return { id, hash: next.hash, state: "reload-required", reloadRequired: true, restartRequired: false };
  };
  const methods = {
    "plugins.list": serialized(async () => {
      const plugins = [];
      for (const s of await store.selections()) {
        try {
          const { manifest } = await verify(s.id,s.hash);
          const boot = bootSelections.get(s.id);
          const waiting = s.enabled && (!boot?.enabled || boot.hash !== s.hash);
          if (!safe && s.enabled && !waiting && !pins.has(s.id)) pins.set(s.id,s.hash);
          plugins.push({ ...manifest, hash: s.hash, enabled: s.enabled, previous: s.previous, hasPrevious: Boolean(s.previous), state: !s.enabled ? "disabled" : safe ? "blocked" : waiting ? "reload-required" : "installed", ...(safe && s.enabled ? { reason: "External plugins are not loaded in safe recovery" } : waiting ? { reason: "Selected revision loads after the app reloads" } : {}) });
        } catch (error) {
          plugins.push({ id: s.id, hash: s.hash, enabled: s.enabled, previous: s.previous, hasPrevious: Boolean(s.previous), state: "failed", reason: error.message });
        }
      }
      return { api: 1, plugins };
    }),
    "plugins.install": serialized(async ({path}) => {
      if (typeof path !== "string") fail("Install requires a workspace path");
      path = path.startsWith("/") ? path : `/workspace/${path}`;
      if (!path.startsWith("/workspace/")) fail("Install source must be in /workspace");
      canonicalPath(path.slice(1));
      const files = await capture(vfs,path), manifest = validatePackage(files,builtinIds), hash = await packageHash(files);
      // Re-read bytes and inventory, not merely timestamps. Source edits never change installed code.
      if (await packageHash(await capture(vfs,path)) !== hash) fail("Plugin source changed during installation");
      if (await store.snapshot(manifest.id,hash)) await verify(manifest.id,hash);
      const old = await store.selection(manifest.id);
      const selection = { id: manifest.id, hash, previous: old?.hash === hash ? old.previous : old?.hash ?? null, enabled: true };
      await store.publish({ manifest, hash, files },selection);
      return { id: manifest.id, hash, state: "installed", reloadRequired: true, restartRequired: false };
    }),
    "plugins.read": serialized(async ({ id, hash, path, encoding = "auto" }) => {
      canonicalPath(path,"web/");
      if (!["auto","text","base64"].includes(encoding)) fail("Invalid encoding");
      const selection = await store.selection(id);
      if (pins.get(id) !== hash && !(selection?.enabled && selection.hash === hash)) fail("Revision is not selected or pinned");
      const snapshot = await verify(id,hash), data = snapshot.files[path];
      if (!data || data.byteLength > 1024*1024) fail("Missing plugin file or exceeds 1 MiB");
      if (!pins.has(id)) pins.set(id,hash);
      let text;
      if (encoding !== "base64") { try { text = new TextDecoder("utf-8",{fatal:true}).decode(data); } catch { if (encoding === "text") fail("File is not UTF-8"); } }
      if (text !== undefined) return { path, size: data.byteLength, encoding: "text", text };
      let binary = "";
      for (const byte of data) binary += String.fromCharCode(byte);
      return { path, size: data.byteLength, encoding: "base64", data: btoa(binary) };
    }),
    "plugins.call": async () => fail("Native plugins need the Android app", "PLUGIN_UNAVAILABLE"),
    ...Object.fromEntries(["enable","disable","rollback"].map(action => [`plugins.${action}`, serialized(({id}) => select(id,action))]))
  };
  return { methods, assetBase, available: enabled, setServing: value => { serving = value; }, close: () => store.close() };
}
