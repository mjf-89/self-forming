// Ordinary service adapter plus an agent tool. No DOM, host internals, automatic calls or retries.
export function setup(ctx) {
  const value = Object.freeze({
    get: () => ctx.native.call('get', {}),
    increment: () => ctx.native.call('increment', {}),
  });
  ctx.provide('counter.value', 1, value);
  if (!ctx.pi || typeof ctx.native?.call !== 'function') return; // older hosts, or registered as a built-in without a native facet
  const { defineExtension, defineTool, Type } = ctx.pi; // always the host's pi-durable, never a bundled copy
  ctx.contribute('agent.extensions', 'counter-tools', defineExtension({
    name: 'counter-tools', // permanent identifier once shipped
    tools: [defineTool({
      name: 'counter_value',
      description: 'Read the current value of the Counter plugin.',
      parameters: Type.Object({}),
      replay: 'safe',
      async execute(_args, _api, context) {
        context.abortSignal?.throwIfAborted();
        return { output: [{ type: 'text', text: JSON.stringify(await value.get()) }] };
      }
    })]
  }));
  // The runtime owns these registrations and removes them when this scope closes.
}
