// Test support for plugin agent extensions: runs the real browser modules of
// apps/common against the bundled pi-durable library in dist/app/library.
// No network, accounts, native host or device is used.
import { webcrypto } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Node 18 lacks these browser globals the bundled library expects.
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!Promise.withResolvers) Promise.withResolvers = function () {
  let resolve, reject;
  const promise = new this((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

const root = fileURLToPath(new URL('..', import.meta.url));
const library = join(root, 'dist/app/library');

export async function libraryAvailable() {
  try { await access(join(library, 'pi-durable.js')); return true; } catch { return false; }
}

/**
 * The served layout in a temporary folder: apps/common/*.js, the built-in plugin files
 * plugins/<id>/web/** as builtin/<id>/web/** (what scripts/web-lite.sh ships), the fixed
 * native-host.js and a link to the library (when dist/app has them; withLibrary: false
 * leaves the library out to prove that nothing imports it at evaluation; source: another
 * source tree, e.g. an exported edition).
 */
export async function assembleApp({ withLibrary = true, source = root } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-agent-'));
  for (const name of await readdir(join(source, 'apps/common'))) {
    if (name.endsWith('.js')) await copyFile(join(source, 'apps/common', name), join(dir, name));
  }
  for (const id of await readdir(join(source, 'plugins'))) {
    const web = join(source, 'plugins', id, 'web');
    if (await access(web).then(() => true, () => false)) {
      await mkdir(join(dir, 'builtin', id), { recursive: true });
      await cp(web, join(dir, 'builtin', id, 'web'), { recursive: true });
    }
  }
  if (await access(join(root, 'dist/app/native-host.js')).then(() => true, () => false)) await copyFile(join(root, 'dist/app/native-host.js'), join(dir, 'native-host.js'));
  if (withLibrary && await libraryAvailable()) await symlink(library, join(dir, 'library'), 'dir');
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n');
  const load = (name) => import(pathToFileURL(join(dir, name)).href);
  return { dir, load, remove: () => rm(dir, { recursive: true, force: true }) };
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
export async function until(predicate, message = 'Timed out waiting for the fixture', ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

/** Tools offered to the model of each request, from the stored pi.system entries (oldest first). */
export async function offeredTools(storage, conversationId, context) {
  const entries = [];
  let cursor;
  do {
    const page = await storage.scanEntries({ conversationId }, 100, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  entries.sort((a, b) => a.id - b.id);
  const offered = new Set();
  const requests = [];
  for (const record of entries) {
    if (record.kind !== 'pi.system') continue;
    const full = (await storage.entry?.(record.id, context))?.entry ?? record;
    for (const message of full.model ?? []) {
      for (const tool of message.toolsAdded ?? []) offered.add(tool.name);
      for (const tool of message.toolsRemoved ?? []) offered.delete(typeof tool === 'string' ? tool : tool.name);
    }
    requests.push([...offered].sort());
  }
  return requests;
}
