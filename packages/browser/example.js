import { Harness, MemoryStorage, createRegistry } from './pi-durable.js';
import { createModels } from './pi-ai.js';
import { fauxProvider, fauxAssistantMessage } from './pi-ai/providers/faux.js';
import { BACKGROUND_CONTEXT } from './chord/context.js';

const button = document.querySelector('#run');
const output = document.querySelector('#output');
const context = BACKGROUND_CONTEXT;
output.textContent = 'Ready. Run a conversation to see the committed transcript.';
button.disabled = false;

button.addEventListener('click', async () => {
  button.disabled = true;
  output.textContent = 'Running the upstream Harness…';
  let harness;
  try {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage(
      'Hello from upstream Pi Durable. This offline reply passed through the real Harness and MemoryStorage.',
    )]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    harness = await Harness.open(new MemoryStorage(), {
      models,
      registry: createRegistry(),
    }, context);
    const conversation = await harness.root(context, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const submission = await conversation.submit({
      type: 'input', content: 'Hello from the standalone browser example.',
    }, context);
    const settled = await submission.wait(context);
    await conversation.waitForIdle(context);
    if (settled.status !== 'done') throw new Error('The offline conversation did not complete.');
    const transcript = await conversation.context(context);
    output.textContent = transcript.messages.map(message => {
      const text = typeof message.content === 'string' ? message.content
        : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      return `${message.role}: ${text}`;
    }).join('\n\n');
  } catch (error) {
    output.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    try { await harness?.close(context); }
    catch (error) { output.textContent += `\n\nClose failed: ${error instanceof Error ? error.message : String(error)}`; }
    button.disabled = false;
  }
});
