// Manual/on-device helper for step P5 (not a test): a fake OpenAI-compatible server on
// 127.0.0.1 (GET /v1/models, streaming POST /v1/chat/completions) answering with
// smartAnswer from plugin-p5-support.mjs. No model, no network, no keys.
// Usage: node tests/plugin-p5-fixture-server.mjs [port]   (default 8091; run it under manage_server)
import { smartAnswer, startFixtureServer } from './plugin-p5-support.mjs';

const port = Number(process.argv[2] ?? 8091);
const server = await startFixtureServer({ port, answer: smartAnswer, models: [{ id: 'fixture-model', object: 'model', owned_by: 'p5-fixture' }] });
console.log(`P5 fixture server: ${server.base} (model fixture-model)`);
const stop = async () => { await server.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
