// Regenerates tests/plugin-p0-providers.snapshot.json from the CURRENT apps/common.
// Captured once against the pre-P1 code (session.js owning every provider by hand);
// plugin-p0-providers.test.mjs compares later constructions (provider table, session
// engine, agent.providers adapter) against that file. Only rerun it on purpose, after an
// intended provider behaviour change: node tests/plugin-p0-capture.mjs
// Pass --print to print the capture instead of writing it.
import { writeFile } from 'node:fs/promises';
import { assembleApp, libraryAvailable } from './plugin-agent-support.mjs';
import {
  MODEL_ERRORS, RECOVERY, SENDS, idleResumeBehaviour, migrationBehaviour, modelErrorBehaviour, modelSettingsBehaviour,
  offlineDemoBehaviour, recoveryBehaviour, sendBehaviour, staticBehaviour, subagentBehaviour
} from './plugin-p0-support.mjs';

export const SECTIONS = ['static', 'modelSettings', 'migration', 'send', 'idleResume', 'subagents', 'recovery', 'offlineDemo', 'modelError'];

/** Loads the modules the capture needs from an assembled app. */
export async function loadDeps(app) {
  return {
    pd: await app.load('library/pi-durable.js'), ai: await app.load('library/pi-ai.js'),
    chord: await app.load('library/chord/context.js'), session: await app.load('session.js'),
    openaiModels: await app.load('library/pi-ai/providers/openai.models.js'),
    anthropicModels: await app.load('library/pi-ai/providers/anthropic.models.js'),
    modelError: await app.load('model-error.js'), env: await app.load('library/pi-durable/env.js')
  };
}

/**
 * One section of the snapshot (sections are independent; each opens its own sessions),
 * normalized like the JSON file (undefined fields dropped).
 */
export async function captureSection(deps, section) {
  return JSON.parse(JSON.stringify(await captureRaw(deps, section)));
}
async function captureRaw(deps, section) {
  switch (section) {
    case 'static': return staticBehaviour(deps);
    case 'modelSettings': return modelSettingsBehaviour(deps);
    case 'migration': return migrationBehaviour(deps);
    case 'send': {
      const result = {};
      for (const name of Object.keys(SENDS)) result[name] = await sendBehaviour(deps, name);
      return result;
    }
    case 'idleResume': return idleResumeBehaviour(deps);
    case 'subagents': {
      const result = {};
      for (const parent of ['chatgpt', 'claude', 'openai']) result[parent] = await subagentBehaviour(deps, parent);
      return result;
    }
    case 'recovery': {
      const result = {};
      for (const name of Object.keys(RECOVERY)) result[name] = await recoveryBehaviour(deps, name);
      return result;
    }
    case 'offlineDemo': return { offline: await offlineDemoBehaviour(deps, 'offline'), native: await offlineDemoBehaviour(deps, 'native') };
    case 'modelError': return modelErrorBehaviour(deps);
    default: throw new Error(`Unknown section ${section}`);
  }
}

export async function capture(deps, sections = SECTIONS) {
  const snapshot = {};
  for (const section of sections) snapshot[section] = await captureSection(deps, section);
  return snapshot;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!await libraryAvailable()) throw new Error('dist/app/library is required');
  const only = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const app = await assembleApp();
  try {
    const deps = await loadDeps(app);
    const snapshot = await capture(deps, only.length ? only : SECTIONS);
    if (process.argv.includes('--print') || only.length) console.log(JSON.stringify(snapshot, null, 1));
    else {
      await writeFile(new URL('./plugin-p0-providers.snapshot.json', import.meta.url), `${JSON.stringify(snapshot, null, 1)}\n`);
      console.log(`wrote ${SECTIONS.length} sections: ${Object.keys(snapshot.send).length} sends, ${Object.keys(snapshot.recovery).length} recoveries, ${Object.keys(MODEL_ERRORS).length} model errors`);
    }
  } finally {
    await app.remove();
  }
}
