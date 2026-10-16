# Pi Durable for the browser

This distribution bundles the public, runtime-neutral entrypoints of `@earendil-works/pi-durable` 1.0.4 as browser ES modules. Each entry exposes the same named runtime exports as its upstream counterpart. `Harness`, `createSession`, extensions, tasks and storage retain their upstream APIs.

The archive contains the upstream libraries and their shared chunks. It does not add a session wrapper, Android bridge, authentication controller or native host adapters to the public API. Those application features live separately in the source repository.

Serve the complete directory over HTTP(S), or package it as assets in a native WebView. Keep the relative directory structure, including shared chunks. No Node, Bun, package loader or dependency download is needed at runtime. Browser module loading from `file://` is not supported.

## Use the upstream Harness directly

Open `example.html` for a runnable version of this offline conversation:

```js
import { Harness, MemoryStorage, createRegistry } from './pi-durable.js';
import { createModels } from './pi-ai.js';
import { fauxProvider, fauxAssistantMessage } from './pi-ai/providers/faux.js';
import { BACKGROUND_CONTEXT } from './chord/context.js';

const context = BACKGROUND_CONTEXT;
const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage('Hello from upstream Pi Durable.')]);

const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
const harness = await Harness.open(new MemoryStorage(), {
  models,
  registry: createRegistry(),
}, context);

try {
  const conversation = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  const submission = await conversation.submit({
    type: 'input', content: 'Hello from this browser.',
  }, context);
  await submission.wait(context);
  await conversation.waitForIdle(context);
  console.log((await conversation.context(context)).messages);
} finally {
  await harness.close(context);
}
```

The faux provider is scripted and makes no model-network requests. `MemoryStorage` lasts only for this page's lifetime; reloading loses its state. Pi AI and Chord are imported through their own modules, as they are when using the upstream packages.

## Entrypoints

The build generates these entry modules from the installed `@earendil-works/pi-durable/package.json` export map. It excludes the metadata entry `./package.json` and the Node-only entries `./env/node`, `./storage/jsonl/node` and `./storage/sqlite/node`. The generator creates virtual build entries; no forwarding TypeScript files are checked in or generated into the source tree. The browser filenames and upstream APIs below remain the public output.

| Upstream specifier | Browser file | Runtime API |
| --- | --- | --- |
| `@earendil-works/pi-durable` | `pi-durable.js` | All upstream root exports, including `Harness`, `createSession`, `createRegistry`, definitions, documents, entries and `MemoryStorage` |
| `@earendil-works/pi-durable/env` | `pi-durable/env.js` | Environment errors, result helpers and decoding utilities |
| `@earendil-works/pi-durable/tools` | `pi-durable/tools.js` | `CodingTools` and the read, write, edit, bash and PowerShell tool factories |
| `@earendil-works/pi-durable/storage/memory` | `pi-durable/storage/memory.js` | `MemoryStorage` |
| `@earendil-works/pi-durable/storage/jsonl` | `pi-durable/storage/jsonl.js` | `JsonlStorage` and its errors |
| `@earendil-works/pi-durable/storage/sqlite` | `pi-durable/storage/sqlite.js` | `SqliteStorage`, migrations and schema version |
| `@earendil-works/pi-durable/testing` | `pi-durable/testing.js` | Upstream conformance and benchmark helpers |

Pi AI and Chord follow an explicit peer selection, rather than including all provider exports. Each selected entry retains its own upstream namespace:

- `@earendil-works/pi-ai` → `pi-ai.js`
- `@earendil-works/pi-ai/providers/faux` → `pi-ai/providers/faux.js`
- `@earendil-works/pi-ai/providers/openai.models` → `pi-ai/providers/openai.models.js`
- `@earendil-works/pi-ai/api/openai-responses` → `pi-ai/api/openai-responses.js`
- `@earendil-works/pi-ai/providers/anthropic.models` → `pi-ai/providers/anthropic.models.js`
- `@earendil-works/pi-ai/api/anthropic-messages` → `pi-ai/api/anthropic-messages.js`
- `@earendil-works/chord/context` → `chord/context.js`

Use relative imports as above, or place the generated `import-map.json` contents inside a `<script type="importmap">` element before your module scripts. Its paths are relative to the document containing the import map; adjust them if that document is outside this directory. This lets your code keep the upstream package specifiers. The JSON file is not installed automatically by importing a library module.

## Host capabilities and scope

The Node-only entrypoints `pi-durable/env/node`, `pi-durable/storage/jsonl/node` and `pi-durable/storage/sqlite/node` are excluded. Their `NodeExecutionEnv`, `openNodeJsonlStorage`, `NodeSqliteDatabase`, `openNodeSqliteDatabase` and `openNodeSqliteStorage` APIs require Node.

These storage classes still need their upstream storage adapters: `SqliteStorage` needs a `SqliteDatabase`, and `JsonlStorage` needs its store implementation. This archive does not supply IndexedDB, OPFS or native SQLite automatically. Coding tools need an application-provided `ExecutionEnv`; bundling a bash tool does not give a browser a shell. Conformance helpers likewise need the storage/environment and runner supplied by the host.

Real model requests require the chosen provider configuration, credentials and a working transport. Browser requests remain subject to CORS. The selected peer modules are listed above; other provider entrypoints are not included implicitly. The archive supplies runtime JavaScript; use the matching upstream npm packages for TypeScript declarations.

`manifest.json` records the upstream versions, `entryPoints` mapping, per-entry runtime export names, and each JavaScript file's byte count and SHA-256. `import-map.json` maps upstream specifiers to the emitted files. `build-inputs.json` records dependencies examined by the bundler. Build targets are Chromium 120 and Safari/WebKit 17; these targets are not a device compatibility certification.

Keep `LICENSE`, `THIRD_PARTY_NOTICES.md` and generated legal-comment files when redistributing the archive. This is an independent project using [Earendil's Pi](https://github.com/earendil-works/pi); it is not an official upstream release.
