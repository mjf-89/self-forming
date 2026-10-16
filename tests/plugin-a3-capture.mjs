// Regenerates tests/plugin-a3-prompts.snapshot.json from the CURRENT apps/common.
// It was run once against the pre-A3 construction (session.js installing
// self-forming-prompts itself); the A3 test compares the plugin-based construction
// (essential built-in core-prompt) against that file. Only rerun it on purpose, after
// an intended prompt change: node tests/plugin-a3-capture.mjs
// Pass --text to print the full rendered prompts instead (for reading, not written).
import { writeFile } from 'node:fs/promises';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';
import { CONFIGURATIONS, promptsFor, subagentRunFor } from './plugin-a3-support.mjs';

export const RUNS = { native: [['device', 'transcript'], ['device', 'app', 'agentsGuide'], undefined], browser: [['device', 'app', 'agentsGuide', 'transcript']] };

export async function capture(deps, { text = false } = {}) {
  const snapshot = {};
  for (const name of Object.keys(CONFIGURATIONS)) snapshot[name] = await promptsFor(deps, name, { text });
  for (const [name, runs] of Object.entries(RUNS)) {
    for (const context of runs) snapshot[`${name}/subagentRun:${context ? context.join('+') : 'default'}`] = await subagentRunFor(deps, name, { context, text });
  }
  return snapshot;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!await libraryAvailable()) throw new Error('dist/app/library is required');
  const app = await assembleApp();
  try {
    const deps = {
      pd: await app.load('library/pi-durable.js'), ai: await app.load('library/pi-ai.js'),
      chord: await app.load('library/chord/context.js'), session: await app.load('session.js'),
      prompts: await app.load('builtin/core-prompt/web/prompt-sections.js')
    };
    const text = process.argv.includes('--text');
    const snapshot = await capture(deps, { text });
    if (text) console.log(JSON.stringify(snapshot, null, 1));
    else {
      await writeFile(new URL('./plugin-a3-prompts.snapshot.json', import.meta.url), `${JSON.stringify(snapshot, null, 1)}\n`);
      console.log(JSON.stringify(Object.fromEntries(Object.entries(snapshot).map(([key, value]) => [key, Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Array.isArray(v) ? v.map((s) => s[0]).join(',') : v.tags.join(',')]))])), null, 1));
    }
  } finally {
    await app.remove();
  }
}
