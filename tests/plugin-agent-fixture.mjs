// Fixture plugin web facet (as an installed web/index.js would be): contributes one
// agent tool built with the host's pi-durable from ctx.pi, calling its native facet.
// Fork-safe (docs/plugins.md §9b): it also runs as a built-in definition and
// feature-detects ctx.pi / ctx.native instead of assuming dynamic loading.
export function setup(ctx) {
  if (!ctx.pi || typeof ctx.native?.call !== 'function') return; // nothing to offer without them
  const { defineExtension, defineTool, Type } = ctx.pi;
  const native = ctx.native;
  ctx.contribute('agent.extensions', 'counter-tools', defineExtension({
    name: 'plugin-agent-fixture',
    tools: [defineTool({
      name: 'counter_value',
      description: 'Read the current counter value.',
      parameters: Type.Object({}),
      replay: 'safe',
      async execute(_args, _api, context) {
        context.abortSignal?.throwIfAborted();
        const value = await native.call('get', {});
        return { content: [{ type: 'text', text: JSON.stringify(value) }] };
      }
    })]
  }));
}
