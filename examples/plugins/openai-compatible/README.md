# openai-compatible (example plugin, step P5)

A model provider for any server that speaks the OpenAI `/v1/chat/completions` API
(llama-server, Ollama, vLLM, LM Studio, OpenRouter, …). Web-only, `reload: "page"`.
Design: `docs/plugins-providers-agent-core.md` §B1, §D P5, §F.4.

- `web/index.js` – setup: contributes `agent.providers` mode `openai-compatible`, the
  service `openai-compatible.endpoints@1` and the agent tool `openai_compatible_endpoints`
  (extension `openai-compatible`; endpoint list only, never keys).
- `web/provider.js` – the provider row (auth `none`, optional key per endpoint).
- `web/endpoints.js` – endpoint config (localStorage `self-forming.plugin.openai-compatible.v1`),
  model discovery (`GET <base>/models`), keys as plugin credentials
  `plugin:openai-compatible:<slug>`, native allow-list entries for https hosts.
- `web/openai-completions.js` – port of pi-ai v1.0.4 `api/openai-completions.ts` (see below).

Needs the host's pi-ai exports as `ctx.pi.ai` (createAssistantMessageEventStream,
parseStreamingJson, calculateCost, resolveTranscript, resolveTranscriptTools,
getDeclaredTools, getSystemMessageText, renderSystemMessageUpdate). Optional lanes:
`ctx.credentials` (stored keys) and `ctx.http` (`allowList`, `fetch`).

Permanent identifiers: mode and provider id `openai-compatible`, model ids
`<endpoint slug>/<server model id>`, credential names `<endpoint slug>`, extension
`openai-compatible`, localStorage key above.

Check: `./scripts/plugin.sh check examples/plugins/openai-compatible`; tests
`node --test tests/plugin-p5-*.test.mjs`; a fake server for manual checks:
`node tests/plugin-p5-fixture-server.mjs 8091`.

## Third-party notice

`web/openai-completions.js` contains code ported from pi-ai (`@earendil-works/pi-ai`
v1.0.4, https://github.com/earendil-works/pi, `packages/ai/src/api/openai-completions.ts`
and the helpers it imports), MIT License, Copyright (c) 2025 Mario Zechner. The full
notice is in the file header.
