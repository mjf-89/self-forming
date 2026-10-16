// Bundled browser execution backend. Fixed bootstrap and bridge dispatch inject the SAME
// page VFS used by revision recovery/storage; execution@1 and workspace@1 remain the
// ordinary bridge adapters. Detaching composition does not dispose this page backend.
// Page shutdown owns dispose(); env.cleanup owns per-caller runs and file handles.
import { normalizePath, parentOf, nameOf } from "./browser-vfs.js";
const CHUNK = 64 * 1024;
const WORKSPACE = "/workspace";
const TEMP = "/tmp";
const toBase64 = (bytes) => { let binary = ""; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(binary); };
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const failure = (code, message, path) => Object.assign(new Error(message), { code, path });

// Shells (browser edition, step E1): the FileSystem below is shared; the Shell half is a
// registered shell named by every env.exec/env.info call (params.shell). The two execution@1
// providers own them: exec-js (JavaScript console worker) and exec-linux (Alpine/v86 Bash).
// browser-host.js creates both once per page and passes them here, so composition and the
// bundled recovery path use the same VFS and the same (single) VM. There is no selector
// inside commands (PI_EXEC_KIND is an ordinary environment variable now) and no default: a
// call without a known shell fails with shell_unavailable.
// shell = { describe: {id, language, name}, exec(context) -> {exitCode}, dispose?() }.

export function createBrowserExecution({ vfs, network, emit, git: getGit, shells = {} }) {
  if (!vfs) throw new TypeError("Browser execution requires the page VFS");
  let gitResolver = getGit;
  const routedFetch = (input, init, tor = false) => tor ? network.fetchTor(input, init) : network.fetch(input, init);
  const registered = new Map(Object.values(shells).filter(Boolean).map((shell) => [shell.describe.id, shell]));
  const handles = new Map();
  const runs = new Map();
  const watches = new Map();
  let handleSeq = 0;
  let tempSeq = 0;
  // ------------------------------------------------------------------ paths
  const resolve = (params, key = "path") => normalizePath(params[key], params.cwd ?? WORKSPACE, WORKSPACE);
  const handle = (id, kind) => {
    const entry = handles.get(id);
    if (!entry || entry.kind !== kind) throw failure("INVALID_HANDLE", "The file handle is closed or invalid");
    return entry;
  };
  const addHandle = (owner, value) => {
    if (handles.size >= 128) throw failure("TOO_MANY_HANDLES", "Too many open files");
    const id = `h${++handleSeq}`;
    handles.set(id, { owner, ...value });
    return { id };
  };
  const nodeInfo = (path, node) => ({ name: nameOf(path), path, kind: node.kind, size: node.kind === "file" ? node.size : 0, mtimeMs: node.mtimeMs });

  // ------------------------------------------------------------------ shells (env.exec)
  const shellOf = (id) => {
    const shell = typeof id === "string" ? registered.get(id) : undefined;
    if (!shell) throw failure("shell_unavailable", id === undefined
      ? "No shell selected: open the execution environment through execution@1 (JavaScript or Linux)"
      : `This page has no shell ${JSON.stringify(id)}`);
    return shell;
  };
  async function exec({ id, owner, shell: shellId, command, cwd, baseCwd, env = {}, timeout }) {
    const shell = shellOf(shellId);
    if (runs.has(id)) throw failure("spawn_error", "Duplicate command id");
    const directory = normalizePath(cwd ?? baseCwd ?? WORKSPACE, baseCwd ?? WORKSPACE, WORKSPACE);
    // A shell may run in its own local folders that are not page files (exec-linux: the VM's
    // /scratch); the shell itself checks those. Everything else must be a VFS directory.
    const local = (shell.localRoots ?? []).some((root) => directory === root || directory.startsWith(`${root}/`));
    const dir = local ? null : vfs.get(directory);
    if (!local && (!dir || dir.kind !== "directory")) throw failure("spawn_error", `Working directory does not exist: ${directory}`);
    let cancelled = false, cancel = () => { cancelled = true; };
    runs.set(id, { owner, cancel: () => cancel() });
    const output = (stream, data) => {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      if (bytes?.length) emit({ event: "env.output", id, stream: stream === "stderr" ? "stderr" : "stdout", data: toBase64(bytes) });
    };
    try {
      return await shell.exec({
        id, command, directory, env, timeout, output,
        fs: (op, args, at) => consoleFs(op, args, at ?? directory),
        resolvePath: (path) => normalizePath(path, directory, WORKSPACE),
        readFile: async (path) => (await vfs.read(path)).slice(),
        fetch: routedFetch,
        git: () => typeof gitResolver === "function" ? gitResolver() : gitResolver,
        setCancel: (fn) => { cancel = fn; if (cancelled) fn(); },
      });
    } finally { runs.delete(id); }
  }

  async function consoleFs(op, args, cwd) {
    const at = (path) => normalizePath(path, cwd, WORKSPACE);
    switch (op) {
      case "readFile": return (await vfs.read(at(args[0]))).slice();
      case "writeFile": vfs.write(at(args[0]), args[1]); return;
      case "appendFile": await vfs.append(at(args[0]), args[1]); return;
      case "readdir": { const dir = at(args[0]); return vfs.readdir(dir).map((name) => vfs.info(dir === "/" ? `/${name}` : `${dir}/${name}`)); }
      case "stat": return vfs.info(at(args[0]));
      case "exists": return vfs.exists(at(args[0]));
      case "mkdir": vfs.mkdir(at(args[0]), args[1] !== false); return;
      case "rm": vfs.remove(at(args[0]), { recursive: args[1], force: args[2] }); return;
      case "rename": vfs.rename(at(args[0]), at(args[1])); return;
      case "walk": {
        const root = at(args[0]);
        return vfs.walk(root).filter((path) => vfs.get(path)?.kind === "file").map((path) => path.slice(root === "/" ? 1 : root.length + 1));
      }
      default: throw failure("invalid", `Unknown fs operation ${op}`);
    }
  }

  const methods = {
    "env.info": ({ shell } = {}) => ({ id: "browser-vfs", cwd: WORKSPACE, home: WORKSPACE, temp: TEMP, backgroundExecution: false,
      ...shell === undefined ? {} : { shell: shellOf(shell).describe } }),
    "env.absolutePath": (p) => resolve(p),
    "env.canonicalPath": (p) => { const path = resolve(p); if (!vfs.exists(path)) throw failure("not_found", "No such file or directory", path); return path; },
    "env.joinPath": ({ parts }) => { const joined = parts.join("/"); return joined.startsWith("/") ? normalizePath(joined) : joined.split("/").filter((s) => s && s !== ".").join("/"); },
    "env.exists": (p) => vfs.exists(resolve(p)),
    "env.fileInfo": (p) => vfs.info(resolve(p)),
    "env.createDir": (p) => vfs.mkdir(resolve(p), p.recursive !== false),
    "env.remove": (p) => vfs.remove(resolve(p), { recursive: p.recursive, force: p.force }),
    "env.renameFile": (p) => vfs.rename(resolve(p, "sourcePath"), resolve(p, "destinationPath")),
    "env.truncateFile": async (p) => { await vfs.truncate(resolve(p), p.size); },
    "env.flushFile": async () => { await vfs.flush(); },
    "env.createTempDir": ({ prefix = "tmp-" }) => { const path = `${TEMP}/${prefix}${Date.now().toString(36)}${++tempSeq}`; vfs.mkdir(path, true); return path; },
    "env.createTempFile": ({ prefix = "tmp-", suffix = "" }) => { const path = `${TEMP}/${prefix}${Date.now().toString(36)}${++tempSeq}${suffix}`; vfs.write(path, new Uint8Array()); return path; },
    "env.openBinaryReader": async (p) => {
      const path = resolve(p);
      const node = vfs.get(path);
      if (!node) throw failure("not_found", "No such file or directory", path);
      if (node.kind === "directory") throw failure("is_directory", "Is a directory", path);
      // Contents are loaded lazily; the reader keeps the bytes it opened (a stable snapshot).
      const data = await vfs.read(path);
      return addHandle(p.owner, { kind: "file", path, node, data });
    },
    "env.openDirReader": (p) => {
      const path = resolve(p);
      const entries = vfs.readdir(path).map((name) => path === "/" ? `/${name}` : `${path}/${name}`);
      return addHandle(p.owner, { kind: "dir", path, entries, at: 0 });
    },
    "env.reader.info": ({ id }) => { const h = handles.get(id); if (!h) throw failure("INVALID_HANDLE", "Closed reader"); return h.kind === "file" ? nodeInfo(h.path, h.node) : vfs.info(h.path); },
    "env.reader.read": ({ id, offset, length }) => {
      const h = handle(id, "file");
      return { data: toBase64(h.data.subarray(offset, offset + Math.min(length, 512 * 1024))) };
    },
    "env.reader.next": ({ id, maxEntries }) => {
      const h = handle(id, "dir");
      const page = [];
      while (h.at < h.entries.length && page.length < maxEntries) {
        const path = h.entries[h.at++];
        const node = vfs.get(path);
        if (node) page.push(nodeInfo(path, node));
      }
      return { entries: page, done: h.at >= h.entries.length };
    },
    "env.reader.close": ({ id }) => { handles.delete(id); },
    "env.openWriter": async (p) => {
      const path = resolve(p);
      if (p.append) await vfs.append(path, new Uint8Array()); // creates the file if missing, keeps contents
      else vfs.write(path, new Uint8Array());
      return addHandle(p.owner, { kind: "writer", path });
    },
    "env.writer.write": async ({ id, data }) => { const h = handle(id, "writer"); await vfs.append(h.path, fromBase64(data)); },
    "env.writer.close": ({ id }) => { handles.delete(id); },
    "env.watch": ({ id, targets }) => {
      const normalized = targets.map((target) => ({ ...target, path: normalizePath(target.path, WORKSPACE, WORKSPACE) }));
      const stop = vfs.onChange((paths) => {
        const hits = paths.filter((path) => normalized.some((t) => {
          if (path === t.path || parentOf(path) === t.path) return true;
          if (!t.recursive || !path.startsWith(`${t.path}/`)) return false;
          const rest = path.slice(t.path.length + 1).split("/");
          return !rest.some((part) => (t.exclude?.hidden && part.startsWith(".")) || t.exclude?.names?.includes(part));
        }));
        if (hits.length) emit({ event: "env.watch", id, change: { paths: hits } });
      });
      watches.set(id, stop);
      return { id, mode: "native" };
    },
    "env.watch.close": ({ id }) => { watches.get(id)?.(); watches.delete(id); },
    "env.cancel": () => {},
    "env.exec": (p) => exec(p),
    "env.exec.cancel": ({ id }) => { runs.get(id)?.cancel(); },
    "env.cleanup": ({ owner }) => {
      for (const [id, h] of handles) if (h.owner === owner) handles.delete(id);
      for (const run of [...runs.values()]) if (run.owner === owner) run.cancel();
    },
    // Legacy text workspace tools (workspace_read/write/list), relative to /workspace.
    "workspace.list": ({ path = "" }) => {
      const dir = normalizePath(path, WORKSPACE);
      return vfs.readdir(dir).map((name) => {
        const info = vfs.info(`${dir}/${name}`);
        return { name, path: info.path.slice(WORKSPACE.length + 1), directory: info.kind === "directory", size: info.size };
      });
    },
    "workspace.read": async ({ path }) => ({ text: new TextDecoder().decode(await vfs.read(normalizePath(path, WORKSPACE))) }),
    "workspace.write": ({ path, text }) => { vfs.write(normalizePath(path, WORKSPACE), new TextEncoder().encode(text)); },
  };
  // Binary async filesystem adjunct for page services (Git); not workspace@1's
  // text-only facade. No second VFS and no owner implementation imports.
  const filesystem = Object.freeze({
    readFile: (path) => consoleFs("readFile", [path], WORKSPACE),
    writeFile: (path, data) => consoleFs("writeFile", [path, data], WORKSPACE),
    stat: (path) => consoleFs("stat", [path], WORKSPACE),
    readdir: (path) => consoleFs("readdir", [path], WORKSPACE),
    mkdir: (path, options) => consoleFs("mkdir", [path, options?.recursive ?? false], WORKSPACE),
    rm: (path, options) => consoleFs("rm", [path, Boolean(options?.recursive), Boolean(options?.force)], WORKSPACE),
  });
  return { methods, filesystem,
    /** Shell descriptors this page offers ({id, language, name}), in registration order. */
    shells: () => [...registered.values()].map((shell) => shell.describe),
    bindGitResolver(resolve) {
      gitResolver = resolve;
      return () => { if (gitResolver === resolve) gitResolver = getGit; };
    },
    dispose() {
    for (const run of [...runs.values()]) run.cancel();
    for (const shell of registered.values()) { try { shell.dispose?.(); } catch { /* best effort */ } }
    for (const stop of watches.values()) stop();
    watches.clear(); handles.clear();
  } };
}
