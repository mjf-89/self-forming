// Regenerates tests/plugin-a2-tools.snapshot.json from the CURRENT apps/common.
// It was run once against the pre-A2 construction (session.js building
// self-forming-native / self-forming-workspace by hand); the A2 test compares the
// plugin-based construction against that file. Only rerun it on purpose, after an
// intended tool change: node tests/plugin-a2-capture.mjs
import { writeFile } from 'node:fs/promises';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';
import { CONFIGURATIONS, STORED, toolsFor } from './plugin-a2-support.mjs';

if (!await libraryAvailable()) throw new Error('dist/app/library is required');
const app = await assembleApp();
try {
  const deps = {
    pd: await app.load('library/pi-durable.js'), ai: await app.load('library/pi-ai.js'),
    chord: await app.load('library/chord/context.js'), session: await app.load('session.js')
  };
  const snapshot = {};
  for (const name of Object.keys(CONFIGURATIONS)) {
    for (const [variant, stored] of Object.entries(STORED)) {
      snapshot[`${name}/${variant}`] = await toolsFor(deps, name, { stored });
    }
  }
  await writeFile(new URL('./plugin-a2-tools.snapshot.json', import.meta.url), `${JSON.stringify(snapshot, null, 1)}\n`);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(snapshot).map(([key, value]) => [key, [value.tools.map((tool) => tool.split('#')[0]).join(','), value.results.join(',')]])), null, 1));
} finally {
  await app.remove();
}
