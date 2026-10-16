import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';
import { CONFIGURATIONS, promptsFor } from './plugin-a3-support.mjs';

// Prompt section "plugins" (develop the app through plugins), contributed by core-plugin-management next to the
// `plugins` tool: text per variant (Android / browser, chosen from platform and nativePlugins), main agent default,
// and the one-line pointer in the app section. Real session.js with the bundled pi-durable library, mocked hosts.
// Not on-device verification.
const available = await libraryAvailable();
const skip = available ? false : 'dist/app/library (bundled pi-durable) is not present';
let app, deps;
before(async () => {
  if (!available) return;
  app = await assembleApp();
  deps = {
    pd: await app.load('library/pi-durable.js'), ai: await app.load('library/pi-ai.js'),
    chord: await app.load('library/chord/context.js'), session: await app.load('session.js'),
    prompts: await app.load('builtin/core-prompt/web/prompt-sections.js')
  };
  // A browser host that can install plugins (the stock fixture has none): web-only, nativePlugins false.
  const stock = CONFIGURATIONS.browser;
  CONFIGURATIONS.browserPlugins = () => {
    const configuration = stock();
    configuration.hostInfo.capabilities = { ...configuration.hostInfo.capabilities, plugins: true, nativePlugins: false };
    return configuration;
  };
});
after(async () => { await app?.remove(); });

const get = (sections, key) => sections.find(([name]) => name === key)?.[1];
const WORDS = new RegExp(['work' + 'bench', 'term' + 'inal', 'pri' + 'vate', 'dev t' + 'ool'].join('|'), 'i'); // words the public export must not contain

test('Android variant: compact text with the skill pointer, Kotlin halves, restart and APK notes', { skip, timeout: 120000 }, async () => {
  const { main } = await promptsFor(deps, 'native', { text: true, helpers: {} });
  const text = get(main, 'plugins');
  assert.ok(text, 'section present');
  assert.ok(text.split('\n').length <= 10 && text.length < 1700, `compact (${text.split('\n').length} lines, ${text.length} chars)`);
  for (const part of [/plugins tool/, /not an edit of the shared engine/, /disabled or rolled back/, /built-ins remain as fallback/, /plugins\/<id>/, /keep it there/, /repository and in the live copy/,
    /revision restore \(previous revision\), not the bundled copy: both paths use the same file/, /never claim|Never claim a plugin is active without checking its state/i,
    /scripts\/plugin\.sh build\/check/, /ctx\.native\.call/, /restart/, /needs a new APK/, /web\/skills\//]) assert.match(text, part);
  assert.match(text, /read \/workspace\/self-forming\/skills\/plugins\/SKILL\.md/);
  assert.doesNotMatch(text, /browser plugin host|web-only/);
  assert.doesNotMatch(text, WORDS);
  console.log(`\n--- android ---\n${text}`);
});

test('browser variant: web-only through the browser plugin host, no Kotlin', { skip, timeout: 120000 }, async () => {
  const { main } = await promptsFor(deps, 'browserPlugins', { text: true, helpers: {} });
  const text = get(main, 'plugins');
  assert.ok(text, 'section present');
  assert.ok(text.split('\n').length <= 10 && text.length < 1700, `compact (${text.split('\n').length} lines, ${text.length} chars)`);
  for (const part of [/plugins tool/, /web-only/, /browser plugin host/, /Kotlin\/native parts is refused/, /built-ins remain as fallback/, /keep it there/,
    /revision restore \(previous revision\), not a bundled copy: both use the same file/, /Never claim a plugin is active/, /read \/workspace\/\.skills\/core-plugin-management\/plugins\/SKILL\.md/]) assert.match(text, part);
  assert.doesNotMatch(text, /scripts\/plugin\.sh|ctx\.native|APK|restart/);
  assert.doesNotMatch(text, WORDS);
  console.log(`\n--- browser ---\n${text}`);
});

test('main default includes it; the app section points to it; hosts without the plugins tool have neither', { skip, timeout: 120000 }, async () => {
  const { MAIN_PROMPT_SECTIONS, PROMPT_SECTIONS } = deps.prompts;
  assert.ok(MAIN_PROMPT_SECTIONS.includes('plugins') && PROMPT_SECTIONS.includes('plugins'));
  for (const name of ['native', 'browserPlugins']) {
    const { main } = await promptsFor(deps, name, { text: true, helpers: {} });
    assert.ok(main.map(([key]) => key).includes('plugins'), name);
    assert.match(get(main, 'app'), /New features are new plugins; change existing behaviour in the built-in plugin that owns it \(see the plugins section\)\./, name);
  }
  // Fixtures without plugin support: no tool, no section, no pointer.
  for (const name of ['nativeMinimal', 'browser']) {
    const { main } = await promptsFor(deps, name, { text: true, helpers: {} });
    assert.equal(get(main, 'plugins'), undefined, name);
    if (get(main, 'app')) assert.doesNotMatch(get(main, 'app'), /plugins section/, name);
  }
});

test('browser: the plugins skill file exists in the workspace at the path the prompt names (seeded from the single source)', { skip, timeout: 120000 }, async () => {
  const { readFile } = await import('node:fs/promises');
  let env;
  const stock = CONFIGURATIONS.browserPlugins;
  CONFIGURATIONS.browserSeeded = () => { const configuration = stock(); env = configuration.options.env; return configuration; };
  const { main } = await promptsFor(deps, 'browserSeeded', { text: true, helpers: {} });
  const named = get(main, 'plugins').match(/read (\/workspace\/\S+SKILL\.md)/)?.[1];
  assert.equal(named, '/workspace/.skills/core-plugin-management/plugins/SKILL.md');
  const { until } = await import('./plugin-agent-support.mjs');
  await until(() => env.files.has(named), 'the skill file was not written');
  const source = await readFile(new URL('../plugins/core-plugin-management/web/skills/plugins/SKILL.md', import.meta.url), 'utf8');
  assert.equal(env.files.get(named), source, 'same text as the single source');
  assert.equal(source, await readFile(new URL('../skills/plugins/SKILL.md', import.meta.url), 'utf8'), 'source-tree copy is in step');
  assert.match(get(main, 'skills') ?? '', /- plugins: .*\(\/workspace\/\.skills\/core-plugin-management\/plugins\/SKILL\.md\)/);
});
