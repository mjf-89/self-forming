import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineDoc } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { prepareAttachment, MAX_ATTACHMENT_BYTES } from '../apps/on-device/attachments.js';

const pixel = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF4QAAAAASUVORK5CYII='), char => char.charCodeAt(0));
const photo = () => new File([pixel], 'tiny photo.png', { type: 'image/png' });
let openAppSession;
before(async () => {
  await mkdir('.test-build', { recursive: true });
  const outfile = resolve('.test-build/on-device-attachments-session.mjs');
  await build({ entryPoints: ['apps/on-device/session.js'], outfile, bundle: true, platform: 'node', format: 'esm',
    packages: 'external', target: 'node24', plugins: [{ name: 'fixed-browser-imports', setup(builder) {
      builder.onResolve({ filter: /^\.\/library\// }, args => ({ path: '@earendil-works/' + args.path.slice('./library/'.length).replace(/\.js$/, ''), external: true }));
      builder.onResolve({ filter: /^\.\/native-host\.js$/ }, () => ({ path: resolve('packages/native-host/src/index.ts') }));
    } }] });
  ({ openAppSession } = await import(pathToFileURL(outfile).href));
});

async function fixture(t) {
  const directory = await mkdtemp(resolve('.test-build/attachments-'));
  const database = resolve(directory, 'app.sqlite');
  const workspace = resolve(directory, 'workspace');
  await mkdir(workspace);
  let session;
  t.after(async () => { await session?.close(); await rm(directory, { recursive: true, force: true }); });
  return { database, workspace, async open(options = {}) {
    session = await openAppSession({ demoTokensPerSecond: 0,
      env: new NodeExecutionEnv({ cwd: workspace }), ...options, storage: await openNodeSqliteStorage(database) });
    return session;
  } };
}

function response(text = 'I received your attachments.') {
  const item = { type: 'message', id: 'attachment-fixture-message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id: 'attachment-fixture-response', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_text.delta', output_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'attachment-fixture-response', status: 'completed', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}

async function waitForReply(session) {
  // send() commits admission; the scheduler publishes the finished response later.
  const deadline = Date.now() + 10000;
  while (session.snapshot.busy || !session.snapshot.messages.some(message => message.role === 'assistant' && message.text)) {
    assert.ok(Date.now() < deadline, 'Expected the admitted reply to finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('binary originals and image drafts persist independently per thread through close during import', async t => {
  const saved = await fixture(t);
  let session = await saved.open();
  const mainId = session.snapshot.conversation.id;
  const raw = new Uint8Array([37, 80, 68, 70, 45, 0, 255, 1, 2]);
  await session.addAttachments([photo(), new File([raw], '../report.pdf', { type: 'application/pdf' })]);
  const mainAttachments = structuredClone(session.snapshot.conversation.attachments);
  assert.equal(mainAttachments[0].kind, 'image');
  assert.equal(mainAttachments[1].kind, 'file');
  assert.equal(mainAttachments[1].data, undefined);
  assert.ok(!mainAttachments[1].path.split('/').includes('..'));
  assert.deepEqual(new Uint8Array(await readFile(resolve(saved.workspace, mainAttachments[1].path))), raw);
  assert.deepEqual(new Uint8Array(await readFile(resolve(saved.workspace, mainAttachments[0].path))), pixel);
  await session.forkThread();
  const branchId = session.snapshot.conversation.id;
  assert.deepEqual(session.snapshot.conversation.attachments, []);
  // A picker that opened on Main can return after the selected view changes.
  await session.addAttachments([new File(['Later picker text'], 'later.txt', { type: 'text/plain' })], mainId);
  assert.deepEqual(session.snapshot.conversation.attachments, []);
  await session.switchConversation(mainId);
  assert.equal(session.snapshot.conversation.attachments.length, 3);
  await session.removeAttachment(mainAttachments[1].id);
  assert.equal(session.snapshot.conversation.attachments.length, 2);
  assert.deepEqual(new Uint8Array(await readFile(resolve(saved.workspace, mainAttachments[1].path))), raw,
    'Removing a draft attachment does not delete an imported shared-workspace file');
  await session.switchConversation(branchId);
  const reading = Promise.withResolvers();
  const release = Promise.withResolvers();
  const slowFile = { name: 'saved-before-close.txt', type: 'text/plain', size: 5,
    async arrayBuffer() { reading.resolve(); await release.promise; return new TextEncoder().encode('hello').buffer; } };
  const importing = session.addAttachments([slowFile]);
  await reading.promise;
  const closing = session.close();
  release.resolve();
  await Promise.all([importing, closing]);
  session = await saved.open();
  assert.equal(session.snapshot.conversation.id, branchId);
  assert.equal(session.snapshot.conversation.attachments[0].name, 'saved-before-close.txt');
  await session.switchConversation(mainId);
  assert.deepEqual(session.snapshot.conversation.attachments[0], mainAttachments[0]);
  assert.equal(session.snapshot.conversation.attachments.length, 2);
});

test('attachment-only send uses real model ImageContent, file paths and durable display metadata', async t => {
  const saved = await fixture(t);
  const requests = [];
  let session = await saved.open({ fetch: async (_input, init) => { requests.push(JSON.parse(init.body)); return response(); } });
  await session.addAttachments([photo(), new File(['%PDF-fixture\0binary'], 'reference.pdf', { type: 'application/pdf' })]);
  const attachments = structuredClone(session.snapshot.conversation.attachments);
  await assert.rejects(session.send('', { mode: 'openai' }), /API key/);
  assert.deepEqual(session.snapshot.conversation.attachments, attachments, 'Failed sign-in/config retains attachments');
  await session.send('', { mode: 'openai', apiKey: 'sk-dummy-attachments' });
  await waitForReply(session);
  assert.equal(requests.length, 1);
  const input = requests[0].input.find(item => item.role === 'user');
  const images = input.content.filter(item => item.type === 'input_image');
  assert.equal(images.length, 1, 'The PDF is not represented as image/vision input');
  assert.equal(images[0].image_url, `data:image/png;base64,${attachments[0].data}`);
  assert.ok(input.content.some(item => item.type === 'input_text' && item.text.includes(attachments[1].path)));
  const user = session.snapshot.messages.find(message => message.role === 'user');
  assert.equal(user.text, '');
  assert.deepEqual(user.attachments, attachments);
  assert.deepEqual(session.snapshot.conversation.attachments, []);
  await session.forkThread();
  assert.deepEqual(session.snapshot.messages.find(message => message.role === 'user').attachments, attachments);
  await session.close();
  session = await saved.open();
  assert.deepEqual(session.snapshot.messages.find(message => message.role === 'user').attachments, attachments);
  assert.deepEqual(session.snapshot.conversation.attachments, []);
});

test('reopening reconciles attachments admitted before an interrupted draft cleanup', async t => {
  const saved = await fixture(t);
  let session = await saved.open({ fetch: async () => response() });
  await session.addAttachments([photo()]);
  const [attachment] = session.snapshot.conversation.attachments;
  const mainId = session.snapshot.conversation.id;
  await session.send('Saved input', { mode: 'openai', apiKey: 'sk-dummy-attachments' });
  await session.close();
  // Recreate the exact durable boundary left by process death after admission
  // but before removing the submitted ID from the host draft document.
  const harness = await Harness.open(await openNodeSqliteStorage(saved.database),
    { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  const threads = defineDoc({ kind: 'self-forming.threads', version: 1, scope: 'session', initial: () => ({}) });
  await harness.commit(async tx => { (await tx.doc(threads)).threads[String(mainId)].attachments = [attachment.id]; }, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
  session = await saved.open({ fetch: async () => { throw new Error('Reopen must not call a model'); } });
  assert.deepEqual(session.snapshot.conversation.attachments, []);
  assert.equal(session.snapshot.messages.find(message => message.role === 'user').attachments[0].id, attachment.id);
});

test('attachment bounds and unsupported image formats fail before modifying the draft', async t => {
  const saved = await fixture(t);
  const session = await saved.open();
  await assert.rejects(session.addAttachments([photo(), photo(), photo(), photo(), photo()]), /up to 4/);
  await assert.rejects(session.addAttachments([{ name: 'too-big.bin', type: '', size: MAX_ATTACHMENT_BYTES + 1,
    async arrayBuffer() { throw new Error('Oversized files must not be read'); } }]), /10 MiB/);
  await assert.rejects(session.addAttachments([new File(['<svg onload="evil()"/>'], 'unsafe.svg', { type: 'image/svg+xml' })]), /PNG, JPEG, WebP or GIF/);
  assert.deepEqual(session.snapshot.conversation.attachments, []);
  const browserWorkspace = { async write() {} };
  await assert.rejects(prepareAttachment(new File(['%PDF-binary'], 'paper.pdf', { type: 'application/pdf' }),
    { workspace: browserWorkspace, context: BACKGROUND_CONTEXT }), /Android app/);
});

test('offline attachment demo describes filenames without echoing model transport metadata or claiming vision', async t => {
  const saved = await fixture(t);
  const session = await saved.open();
  await session.addAttachments([photo()]);
  await session.send('Keep this photo');
  await waitForReply(session);
  const reply = session.snapshot.messages.at(-1).text;
  assert.match(reply, /Keep this photo/);
  assert.match(reply, /Attached files: tiny photo\.png/);
  assert.match(reply, /scripted offline demo/);
  assert.doesNotMatch(reply, /Self Forming attached files|"attachments"|"version"|data:image/);
});
