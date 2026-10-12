import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';

/** Browser/native-protocol integration; native revision validation is tested separately on the JVM. */
export async function testAppRevisionBrowser(browser, baseUrl) {
  const output = await mkdtemp(resolve('test-results', 'app-revisions-'));
  const sourcePath = resolve(output, 'source');
  const manifest = JSON.parse(await readFile('dist/app/app-manifest.json', 'utf8'));
  for (const name of manifest.editableFiles) {
    await mkdir(dirname(resolve(sourcePath, name)), { recursive: true });
    await cp(resolve('dist/app', name), resolve(sourcePath, name));
  }
  const handles = new Map();
  const workspace = new Map();
  const revisions = new Map();
  const events = [];
  const errors = [];
  let nextHandle = 0;
  let nextRevision = 0;
  let selected = 'bundled';
  let previous;
  let staged;
  let failStage = false;
  const encode = value => typeof value === 'bigint' ? Number(value) : value;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.exposeBinding('__revisionHost', async (_source, json) => {
    const { id, method, params } = JSON.parse(json);
    let result = null;
    try {
      if (method.startsWith('app.') || method === 'sqlite.open' || method === 'sqlite.close') events.push({ method, params, selected });
      if (method === 'host.info') result = { platform: 'test', foreground: true, capabilities: { editableApp: true } };
      else if (method === 'auth.load') result = null;
      else if (method === 'app.info') result = { supported: true, sourcePath, revision: selected,
        ...(previous ? { previousRevision: previous } : {}), ...(staged ? { pendingRevision: staged } : {}), hostVersion: manifest.hostVersion };
      else if (method === 'app.stage') {
        if (failStage) { failStage = false; throw new Error('Fixture stage validation rejected the edited app'); }
        staged = `fixture-${++nextRevision}`;
        const directory = resolve(output, staged);
        await cp(sourcePath, directory, { recursive: true });
        revisions.set(staged, directory);
        result = { revision: staged };
      } else if (method === 'app.activate' || method === 'app.restore') {
        assert.equal(handles.size, 0, 'The app must close its SQLite owner before selecting a revision');
        const target = method === 'app.activate' ? params.revision : params.target === 'original' ? 'bundled' : previous;
        assert.ok(target === 'bundled' || revisions.has(target));
        previous = selected;
        selected = target;
        staged = undefined;
        result = { revision: selected };
      } else if (method === 'app.ready') {
        assert.equal(params.revision, selected);
        assert.equal(handles.size, 1, 'Startup acknowledgment follows opening the actual saved session');
      } else if (method === 'sqlite.open') {
        const database = new DatabaseSync(resolve(output, 'saved-chat.sqlite'));
        database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
        const handle = `db:${++nextHandle}`;
        handles.set(handle, database);
        result = { handle };
      } else if (method.startsWith('sqlite.')) {
        const database = handles.get(params.handle);
        assert.ok(database, 'The saved session must own an open database');
        if (method === 'sqlite.close') { database.close(); handles.delete(params.handle); }
        else if (method === 'sqlite.exec') database.exec(params.sql);
        else {
          const statement = database.prepare(params.sql);
          if (method === 'sqlite.run') statement.run(...params.params);
          else if (method === 'sqlite.all') {
            statement.setReadBigInts(true);
            result = statement.all(...params.params).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, encode(value)])));
          } else throw new Error(`Unexpected SQLite operation: ${method}`);
        }
      } else if (method === 'workspace.write') workspace.set(params.path, params.text);
      else if (method === 'workspace.read') result = { text: workspace.get(params.path) };
      else if (method === 'workspace.list') result = [];
      else throw new Error(`Unexpected native operation: ${method}`);
      return JSON.stringify({ id, ok: true, result });
    } catch (error) { return JSON.stringify({ id, ok: false, error: { code: 'test_host', message: error.message } }); }
  });
  await context.addInitScript(() => {
    globalThis.PiNative = { onmessage: null, postMessage(message) {
      globalThis.__revisionHost(message).then(data => globalThis.PiNative.onmessage?.({ data }));
    } };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseUrl).origin || selected === 'bundled') { await route.continue(); return; }
    const directory = revisions.get(selected);
    const name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const path = resolve(directory, name);
    if (path !== directory && !path.startsWith(directory + sep)) { await route.abort(); return; }
    // Immutable upstream/host modules continue to come from the installed app.
    if (!manifest.editableFiles.includes(name)) { await route.continue(); return; }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    await route.fulfill({ body: await readFile(path), contentType: mime[extname(path)], headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'",
    } });
  });
  const openChat = async () => {
    // A restored HTML heading can appear before app.js attaches navigation.
    // Session readiness is the signal to interact after a revision reload.
    await page.locator('#prompt:enabled').waitFor({ state: 'attached' });
    if (await page.locator('#settings-dialog').evaluate(dialog => dialog.open))
      await page.locator('#settings-close').click();
    if (await page.locator('#home-screen').isVisible()) await page.locator('#show-chat').click();
    await page.locator('#prompt:enabled').waitFor();
  };
  const openPanel = async () => {
    // Foregrounding preserves the already-open Settings dialog. Its controls
    // are the relevant readiness signal; the covered chat input is not.
    if (!await page.locator('#settings-dialog').evaluate(dialog => dialog.open)) {
      await openChat();
      await page.locator('#chat-more').click();
      await page.locator('#chat-settings').click();
    }
    await page.locator('#settings-dialog').waitFor();
    await page.locator('#app-apply:enabled').waitFor({ state: 'attached' });
    if (!await page.locator('#app-editing').evaluate(element => element.open))
      await page.locator('#app-editing > summary').click();
    await page.locator('#app-apply:enabled').waitFor();
  };
  try {
    await page.goto(baseUrl);
    await openChat();
    const note = 'This saved conversation survives editing the app.';
    await page.locator('#prompt').fill(note);
    await page.locator('#send').click();
    await page.locator('#prompt:enabled').waitFor();
    const transcript = await page.locator('#messages').innerText();
    assert.ok(transcript.includes(note));
    await openPanel();
    const originalJs = await readFile(resolve(sourcePath, 'app.js'), 'utf8');
    assert.ok(originalJs.length > 0);
    await writeFile(resolve(sourcePath, 'app.js'), originalJs + '\ndocument.documentElement.dataset.appRevisionFixture = "edited";\n');
    const originalHtml = await readFile(resolve(sourcePath, 'index.html'), 'utf8');
    const homeHeading = '<h1 id="home-title">Self Forming</h1>';
    assert.ok(originalHtml.includes(homeHeading), 'The edit fixture must target the actual home heading');
    await writeFile(resolve(sourcePath, 'index.html'), originalHtml.replace(homeHeading, '<h1 id="home-title">Edited on device</h1>'));
    await writeFile(resolve(sourcePath, 'app.css'), (await readFile(resolve(sourcePath, 'app.css'), 'utf8')) + '\n:root { --pi-revision-fixture: edited; }\n');

    // Validation failure occurs before shutdown and keeps the current UI/session alive.
    failStage = true;
    const beforeFailure = events.length;
    await page.locator('#app-apply').click();
    await page.getByText('Fixture stage validation rejected the edited app', { exact: true }).waitFor();
    await page.locator('#app-apply:enabled').waitFor();
    assert.equal(selected, 'bundled');
    assert.equal(events.slice(beforeFailure).some(event => event.method === 'sqlite.close' || event.method === 'app.activate'), false);
    assert.equal(await page.locator('#messages').innerText(), transcript);

    const beforeApply = events.length;
    await page.locator('#app-apply').click();
    await page.getByRole('heading', { name: 'Edited on device', exact: true }).waitFor();
    await openPanel();
    assert.equal(selected, 'fixture-1');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.appRevisionFixture), 'edited');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pi-revision-fixture').trim()), 'edited');
    assert.equal(await page.locator('#messages').innerText(), transcript);
    const applyEvents = events.slice(beforeApply).map(event => event.method);
    assert.ok(applyEvents.indexOf('sqlite.close') < applyEvents.indexOf('app.activate'));
    assert.ok(applyEvents.indexOf('app.activate') < applyEvents.indexOf('sqlite.open'));
    assert.ok(applyEvents.indexOf('sqlite.open') < applyEvents.lastIndexOf('app.ready'));
    await page.screenshot({ path: resolve('test-results/app-editing-portrait.png') });
    // Later source edits must not mutate the already-snapshotted revision.
    await writeFile(resolve(sourcePath, 'app.js'), originalJs + '\ndocument.documentElement.dataset.appRevisionFixture = "unapplied-draft";\n');

    // A staged native snapshot without a committed apply-tool intent is never
    // selected merely because the unchanged app moves to the foreground.
    staged = 'unrequested-fixture';
    const beforeLifecycle = events.length;
    await page.evaluate(() => {
      for (const foreground of [false, true]) globalThis.PiNative.onmessage?.({ data: JSON.stringify({ event: 'host.lifecycle', id: 'host', foreground }) });
    });
    await openPanel();
    assert.equal(events.slice(beforeLifecycle).some(event => event.method === 'app.activate'), false);
    assert.equal(selected, 'fixture-1');

    await page.locator('#app-original').click();
    await page.getByRole('heading', { name: 'Self Forming', exact: true }).waitFor();
    await openPanel();
    assert.equal(selected, 'bundled');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.appRevisionFixture), undefined);
    assert.equal(await page.locator('#messages').innerText(), transcript);
    // The source draft remains edited; restore selects code without discarding edits.
    assert.match(await readFile(resolve(sourcePath, 'app.js'), 'utf8'), /appRevisionFixture/);
    await page.locator('#app-previous').click();
    await page.getByRole('heading', { name: 'Edited on device', exact: true }).waitFor();
    await openPanel();
    assert.equal(selected, 'fixture-1');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.appRevisionFixture), 'edited');
    assert.match(await readFile(resolve(sourcePath, 'app.js'), 'utf8'), /unapplied-draft/);
    assert.equal(await page.locator('#messages').innerText(), transcript);
    assert.deepEqual(errors, []);
    const report = { checks: ['plain JS/HTML/CSS edits loaded directly', 'native stage validation precedes session shutdown',
      'SQLite close before activation/restore', 'saved transcript survives reload', 'startup app.ready follows actual session open',
      'unrequested staged snapshot is not activated on foreground', 'original and previous revisions restore without discarding draft edits'],
      screenshot: 'app-editing-portrait.png', kotlinHostExecuted: false };
    await writeFile('test-results/app-revisions-report.json', JSON.stringify(report, null, 2) + '\n');
    console.log('PASS browser: edit plain JS/HTML/CSS -> stage -> SQLite close -> activate/reload -> saved chat -> ready -> restore original/previous');
  } finally {
    await context.close();
    for (const database of handles.values()) { try { database.close(); } catch {} }
  }
}
