import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

let createServerExtension;
before(async () => {
  await mkdir('.test-build', { recursive: true });
  const outfile = resolve('.test-build/on-device-servers.mjs');
  await build({ entryPoints: ['plugins/core-servers/web/servers.js'], outfile, bundle: true, platform: 'node', format: 'esm',
    packages: 'external', plugins: [{ name: 'browser-imports', setup(builder) {
      builder.onResolve({ filter: /^(\.\/|(\.\.\/)+)library\// }, args => ({
        path: '@earendil-works/' + args.path.slice(args.path.indexOf('library/') + 8).replace(/\.js$/, ''), external: true
      }));
    } }] });
  ({ createServerExtension } = await import(pathToFileURL(outfile).href));
});

// This is an execution protocol fake: no shell, apt, curl, sockets, or external requests run in these tests.
function fakeEnvironment() {
  return {
    cwd: '/workspace', sessions: new Set(), launches: 0, kills: 0, commands: [],
    refuseKill: false, refuseInspect: false, externalListener: false, healthy: true,
    async exec(command, options, callContext) {
      callContext.abortSignal?.throwIfAborted();
      this.commands.push(command);
      const result = (exitCode = 0, output = '') => {
        if (output) options.onOutput?.(output);
        return { ok: true, value: { exitCode } };
      };
      const session = command.match(/(?:-t '=|-s ')(srv-\d+)'/)?.[1];
      const socket = command.includes('-L sf-servers') ? 'shared' : command.includes('-L ') ? 'legacy' : 'default';
      const key = `${socket}:${session}`;
      if (command.includes('has-session')) {
        if (this.refuseInspect) return result(1, 'access not allowed');
        return this.sessions.has(key) ? result() : result(1, `can't find session: ${session}`);
      }
      if (command.includes('kill-session')) {
        if (this.refuseKill) return { ok: false, error: { code: 'exec_failed', message: 'bridge unavailable' } };
        this.kills++;
        this.sessions.delete(key);
        return result();
      }
      if (command.includes('new-session')) {
        assert.ok(session, 'Every launch must name its task session');
        assert.ok(!this.sessions.has(key), 'A replay must not replace a live session');
        this.sessions.add(key);
        this.launches++;
        return result();
      }
      if (command.startsWith('curl ')) return result(this.externalListener || (this.healthy && this.sessions.size > 0) ? 0 : 7);
      if (command.includes('secrets-wait') && command.startsWith('[ -f')) return result(1);
      return result(); // launcher writes, installation checks, and log reads
    }
  };
}

async function eventually(read, predicate, message) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function fixture(t, timing = {}) {
  const directory = await mkdtemp(resolve('.test-build/servers-'));
  const database = resolve(directory, 'state.sqlite');
  const env = fakeEnvironment();
  let harness, extension, root;
  t.after(async () => { await harness?.close(context); await rm(directory, { recursive: true, force: true }); });
  const saved = {
    env,
    get harness() { return harness; },
    get extension() { return extension; },
    async open() {
      extension = createServerExtension({ rootConversationId: ROOT_CONVERSATION_ID,
        abortTask: (id, ctx) => harness.abortTask(id, ctx),
        timing: { intervalMs: 25, backoffMs: [15], maxFailures: 2, defaultGraceMs: 0, ...timing }
      });
      const registry = createRegistry();
      registry.install(extension);
      harness = await Harness.open(await openNodeSqliteStorage(database), {
        models: createModels(), registry, env: () => env
      }, context);
      root = await harness.root(context, { agent: { cwd: env.cwd } });
      return saved;
    },
    async close() { await harness.close(context); harness = undefined; },
    async call(args) {
      return extension.tools[0].execute(args, {
        env, agent: ctx => root.agent(ctx),
        snapshot: (doc, ctx) => harness.snapshot(doc, ctx),
        getTask: (id, ctx) => harness.getTask(id, ctx),
        waitForTask: (id, ctx) => harness.waitForTask(id, ctx),
        commit: (fn, ctx) => harness.commit(fn, ctx)
      }, context);
    },
    record: id => harness.getTask(id, context),
    async running(id) {
      return eventually(() => saved.record(id), record => record.state.checkpoint?.healthyAt !== undefined,
        'Server did not become healthy');
    },
    abortChat: () => root.abort(context)
  };
  return saved.open();
}

test('server starts are atomic, survive chat Stop/reopen, and recover a missing session once', async t => {
  const saved = await fixture(t);
  const args = { action: 'start', name: 'hello', command: 'serve-hello' };
  const [first, duplicate] = await Promise.all([saved.call(args), saved.call(args)]);
  const id = first.details.taskId;
  assert.equal(duplicate.details.taskId, id);
  saved.harness.resume();
  await saved.running(id);
  assert.equal(saved.env.launches, 1);
  await saved.abortChat();
  assert.equal((await saved.record(id)).abortRequested, false);
  await saved.close();
  await saved.open();
  saved.harness.resume();
  await saved.running(id);
  assert.equal(saved.env.launches, 1, 'Reopen must adopt only its existing task session');
  saved.env.sessions.clear();
  await eventually(() => saved.env.launches, count => count === 2, 'Missing server was not restarted');
  const stopped = await saved.call({ action: 'stop', name: 'hello' });
  assert.match(stopped.output[0].text, /Stopped hello/);
  assert.equal(saved.env.sessions.size, 0);
});

test('an abort persisted before process death is cleaned up on reopen without any launch', async t => {
  const saved = await fixture(t);
  const started = await saved.call({ action: 'start', name: 'pending', command: 'never-start' });
  const id = started.details.taskId;
  // Exact durable crash boundary: stop was marked, but no invocation has run yet.
  await saved.harness.abortTask(id, context);
  await saved.close();
  await saved.open();
  const receipt = await saved.harness.waitForTask(id, context);
  assert.equal(receipt.state.outcome.status, 'aborted');
  assert.equal(saved.env.launches, 0);
});

test('stop cancels an interrupted launch and cleans a session created before the bridge replied', async t => {
  const saved = await fixture(t);
  const launched = Promise.withResolvers();
  const execute = saved.env.exec.bind(saved.env);
  saved.env.exec = async (command, options, callContext) => {
    const result = await execute(command, options, callContext);
    if (!command.includes('new-session')) return result;
    launched.resolve();
    return new Promise(resolve => {
      const aborted = () => resolve({ ok: false, error: { code: 'aborted', message: 'Command cancelled' } });
      callContext.abortSignal.addEventListener('abort', aborted, { once: true });
      if (callContext.abortSignal.aborted) aborted();
    });
  };
  const started = await saved.call({ action: 'start', name: 'interrupted', command: 'serve' });
  saved.harness.resume();
  await launched.promise;
  const stopped = await saved.call({ action: 'stop', name: 'interrupted' });
  assert.match(stopped.output[0].text, /Stopped interrupted/);
  assert.equal((await saved.record(started.details.taskId)).state.outcome.status, 'aborted');
  assert.equal(saved.env.sessions.size, 0);
  assert.equal(saved.env.launches, 1);
});

test('stop remains durable and pending across failed cleanup and reopen, then confirms disappearance', async t => {
  const saved = await fixture(t);
  const started = await saved.call({ action: 'start', name: 'stubborn', command: 'serve' });
  const id = started.details.taskId;
  saved.harness.resume();
  await saved.running(id);
  saved.env.refuseKill = true;
  let finished = false;
  const stopping = saved.call({ action: 'stop', name: 'stubborn' }).then(() => { finished = true; }, () => {});
  await eventually(() => saved.record(id), record => record.state.checkpoint?.cleanupFailures > 0, 'Failed stop was not checkpointed');
  assert.equal(finished, false, 'A failed cleanup must not produce a success reply');
  assert.equal(saved.env.sessions.size, 1);
  assert.match((await saved.call({ action: 'status', name: 'stubborn' })).output[0].text, /stopping.*\n[\s\S]*Stop pending/);
  await saved.close();
  await stopping;
  saved.env.refuseKill = false;
  await saved.open();
  const receipt = await saved.harness.waitForTask(id, context);
  assert.equal(receipt.state.outcome.status, 'aborted');
  assert.equal(saved.env.sessions.size, 0);
  assert.equal(saved.env.launches, 1);
});

test('an unrelated healthy listener is a conflict, never adopted or reported restarted', async t => {
  const saved = await fixture(t);
  saved.env.externalListener = true;
  const started = await saved.call({ action: 'start', name: 'conflict', command: 'new-server', health: 3000 });
  const failed = await saved.harness.waitForTask(started.details.taskId, context);
  assert.equal(failed.state.outcome.status, 'failed');
  assert.match(failed.state.outcome.error.message, /already answering outside/);
  const restarted = await saved.call({ action: 'restart', name: 'conflict', command: 'different-server' });
  const again = await saved.harness.waitForTask(restarted.details.taskId, context);
  assert.equal(again.state.outcome.status, 'failed');
  assert.equal(saved.env.externalListener, true);
  assert.equal(saved.env.launches, 0);
  assert.equal(saved.env.kills, 0);
});

test('failed health checks cannot retire the task before its process is cleaned up', async t => {
  const saved = await fixture(t, { maxFailures: 1 });
  const started = await saved.call({ action: 'start', name: 'sick', command: 'serve', health: 3001 });
  const id = started.details.taskId;
  saved.harness.resume();
  await saved.running(id);
  saved.env.refuseKill = true;
  saved.env.healthy = false;
  await eventually(() => saved.record(id), record => record.state.checkpoint?.phase === 'cleanup', 'Cleanup failure was not retained');
  assert.equal(saved.env.sessions.size, 1);
  saved.env.refuseKill = false;
  const receipt = await saved.harness.waitForTask(id, context);
  assert.equal(receipt.state.outcome.status, 'failed');
  assert.equal(saved.env.sessions.size, 0);
  assert.equal(saved.env.launches, 1);
});

test('legacy external observers migrate to an ownership check and fail on conflicting listeners', async t => {
  const saved = await fixture(t);
  saved.env.externalListener = true;
  const definition = saved.extension.tasks[0].definition;
  const legacy = defineTask({ ...definition, version: 1,
    initial: () => ({ phase: 'watch', nextCheckAt: 0, failures: 0, external: true, healthyAt: 1 })
  });
  const id = await saved.harness.commit(tx => tx.createTask(legacy, {
    name: 'legacy', workspace: saved.env.cwd, cwd: saved.env.cwd, command: 'new-server', health: 3002, startGraceMs: 0
  }, { ownership: { kind: 'conversation' }, conversationId: ROOT_CONVERSATION_ID, background: true }), context);
  const receipt = await saved.harness.waitForTask(id, context);
  assert.equal(receipt.state.outcome.status, 'failed');
  assert.match(receipt.state.outcome.error.message, /already answering outside/);
  assert.equal((await saved.record(id)).version, 2);
  assert.equal(saved.env.launches, 0);
});
