import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Focused, opt-in browser regression. No app build, credentials, model or server.
const source = await readFile(new URL('../plugins/core-chat/web/chat-renderer.js', import.meta.url), 'utf8');
const attachmentSource = await readFile(new URL('../plugins/core-chat/web/attachment-view.js', import.meta.url), 'utf8');
let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
if (!executablePath) {
  try { await access(chromium.executablePath()); } catch {
    for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
      try { await access(candidate); executablePath = candidate; break; } catch { }
    }
  }
}
const browser = await chromium.launch({ executablePath, headless: true });
const requests = [];
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://127.0.0.1:42599' && url.pathname === '/chat-renderer.js')
      return route.fulfill({ contentType: 'application/javascript', body: source });
    if (url.origin === 'http://127.0.0.1:42599' && url.pathname === '/attachment-view.js')
      return route.fulfill({ contentType: 'application/javascript', body: attachmentSource });
    if (url.origin === 'http://127.0.0.1:42599' && url.pathname === '/fixture')
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat renderer checks</title>
        <style>#scroll{height:300px;overflow:auto}.message{margin:12px 0}.message-text{overflow-wrap:anywhere}pre{white-space:pre-wrap}.message-copy{width:44px;height:44px}</style>
        <main id="scroll"><div id="messages"></div></main>` });
    requests.push(url.href); await route.abort();
  });
  await page.goto('http://127.0.0.1:42599/fixture');
  const safety = await page.evaluate(async () => {
    const { createChatRenderer } = await import('/chat-renderer.js');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      async writeText(text) { if (window.failCopy) throw new Error('Clipboard unavailable'); window.copiedText = text; },
    } });
    const container = document.getElementById('messages');
    const renderer = createChatRenderer({ messages: container, scroll: document.getElementById('scroll') });
    const array = [
      { id: 'user', role: 'user', text: '<img src="https://invalid.example/user" onerror="window.__xss=1">' },
      { id: 'tool', role: 'tool', toolName: 'bash', toolPreview: 'curl http://127.0.0.1:3000/', pending: true,
        text: '<svg onload="window.__xss=2">tool output</svg>' },
      { id: 'assistant', role: 'assistant', pending: true, thinking: '<img src="https://invalid.example/thought"> Actual supplied thought.',
        text: 'Keep this paragraph selected.\n\nStreaming reply' },
      { id: 'markdown', role: 'assistant', text: '# A heading\n\n**Bold** and `literal <img onerror=x>`\n\n' +
        '[Docs](https://example.com/a(b)) [Email](mailto:hello@example.com)\n\n' +
        '[bad](javascript:window.__xss=3) [data](data:text/html,test) ![pixel](https://invalid.example/pixel)\n\n' +
        '<iframe src="https://invalid.example/frame"></iframe>\n\n- First\n- Second **item**\n\n' +
        '3. Third\n4. Fourth\n\n```html\n<img src="https://invalid.example/code" onerror="window.__xss=4">\n```' },
    ];
    renderer.render(array);
    const tool = container.querySelector('[data-message-id="tool"]');
    const assistant = container.querySelector('[data-message-id="assistant"]');
    const thought = assistant.querySelector('.message-thinking');
    const paragraph = assistant.querySelector('.message-markdown p');
    tool.open = true; thought.open = true;
    const range = document.createRange(); range.selectNodeContents(paragraph);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    window.fixture = { renderer, array, tool, assistant, thought, paragraph };
    return {
      unsafeNodes: container.querySelectorAll('img,iframe,script,object,embed,[onload],[onerror]').length,
      xss: window.__xss ?? null,
      links: [...container.querySelectorAll('a')].map(link => ({ href: link.href, rel: link.rel, target: link.target })),
      heading: container.querySelector('h1')?.textContent,
      bold: container.querySelector('strong')?.textContent,
      bulletItems: container.querySelectorAll('ul li').length,
      orderedStart: container.querySelector('ol')?.start,
      code: container.querySelector('[data-message-id="markdown"] pre code')?.textContent,
      preview: tool.querySelector('.tool-preview').textContent,
      previewHidden: tool.querySelector('.tool-preview').hidden,
      state: tool.querySelector('.tool-state').textContent,
      assistantLabels: container.querySelectorAll('.message-assistant > .message-label').length,
    };
  });
  assert.equal(safety.unsafeNodes, 0);
  assert.equal(safety.xss, null);
  assert.deepEqual(safety.links.map(link => link.href), ['https://example.com/a(b)', 'mailto:hello@example.com']);
  assert.ok(safety.links.every(link => link.target === '_blank' && link.rel === 'noopener noreferrer'));
  assert.equal(safety.heading, 'A heading');
  assert.equal(safety.bold, 'Bold');
  assert.equal(safety.bulletItems, 2);
  assert.equal(safety.orderedStart, 3);
  assert.match(safety.code, /^<img /);
  assert.equal(safety.preview, '');
  assert.equal(safety.previewHidden, true);
  assert.equal(safety.state, 'Running');
  assert.equal(safety.assistantLabels, 0);

  const preserved = await page.evaluate(async () => {
    const f = window.fixture;
    f.array = f.array.map(message => message.id === 'assistant' ? { ...message, text: `${message.text} continues`, thinking: `${message.thinking} More thought.` }
      : message.id === 'tool' ? { ...message, pending: false, text: 'Hello World\n' } : message);
    f.renderer.render(f.array);
    const same = {
      tool: document.querySelector('[data-message-id="tool"]') === f.tool,
      toolOpen: f.tool.open,
      assistant: document.querySelector('[data-message-id="assistant"]') === f.assistant,
      paragraph: f.assistant.querySelector('.message-markdown p') === f.paragraph,
      selection: document.getSelection().toString(),
      thought: f.assistant.querySelector('.message-thinking') === f.thought,
      thoughtOpen: f.thought.open,
      state: f.tool.querySelector('.tool-state').textContent,
      output: f.tool.querySelector('.tool-output').textContent,
    };
    let mutations = 0;
    const observer = new MutationObserver(records => { mutations += records.length; });
    observer.observe(document.getElementById('messages'), { subtree: true, childList: true, characterData: true, attributes: true });
    f.renderer.render(f.array.map(message => ({ ...message })));
    await Promise.resolve(); observer.disconnect();
    return { ...same, mutations };
  });
  assert.deepEqual(preserved, { tool: true, toolOpen: true, assistant: true, paragraph: true,
    selection: 'Keep this paragraph selected.', thought: true, thoughtOpen: true, state: 'Done', output: 'Hello World\n', mutations: 0 });

  await page.locator('[data-message-id="assistant"] .message-copy').click();
  await page.waitForFunction(() => window.copiedText === fixture.array.find(message => message.id === 'assistant').text);
  assert.equal(await page.locator('[data-message-id="assistant"] .message-copy').getAttribute('aria-label'), 'Copied');
  await page.evaluate(() => { window.failCopy = true; });
  await page.locator('[data-message-id="assistant"] .message-copy').click();
  await page.waitForFunction(() => document.querySelector('[data-message-id="assistant"] .message-copy-status').textContent.startsWith('Could not copy.'));

  const scrolling = await page.evaluate(async () => {
    const f = fixture;
    const scroll = document.getElementById('scroll');
    document.getSelection().removeAllRanges();
    scroll.scrollTop = 0;
    f.array.push({ id: 'long', role: 'assistant', text: 'Long output.\n\n'.repeat(50) });
    f.renderer.render(f.array);
    await new Promise(resolve => requestAnimationFrame(resolve));
    const stayed = scroll.scrollTop === 0;
    scroll.scrollTop = scroll.scrollHeight;
    f.array.push({ id: 'tail', role: 'assistant', text: 'More output.\n\n'.repeat(5) });
    f.renderer.render(f.array);
    await new Promise(resolve => requestAnimationFrame(resolve));
    return { stayed, followed: scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1 };
  });
  assert.deepEqual(scrolling, { stayed: true, followed: true });

  const attachments = await page.evaluate(() => {
    const image = { id: 'image', name: '<img src="https://invalid.example/name">.png', mimeType: 'image/png',
      kind: 'image', size: 68, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4n8AAAAASUVORK5CYII=' };
    const array = [{ id: 'attachments', role: 'user', text: 'Selected files', attachments: [image,
      { id: 'file', name: '<script>window.__xss=5</script>.txt', kind: 'file', mimeType: 'text/plain', size: 12, path: 'javascript:window.__xss=6' },
      { id: 'remote', name: 'remote.png', kind: 'image', mimeType: 'image/png', size: 10, url: 'https://invalid.example/remote' },
      { id: 'svg', name: 'active.svg', kind: 'image', mimeType: 'image/svg+xml', size: 10, data: btoa('<svg onload="window.__xss=7"/>') },
      { id: 'invalid', name: 'bad.png', kind: 'image', mimeType: 'image/png', size: 10, data: 'https://invalid.example/not-base64' },
    ] }];
    fixture.renderer.render(array);
    const card = document.querySelector('[data-message-id="attachments"]');
    const img = card.querySelector('img');
    array[0] = { ...array[0], text: 'Selected files updated' };
    fixture.renderer.render(array);
    return {
      images: card.querySelectorAll('img').length,
      cards: card.querySelectorAll('.attachment-card').length,
      source: img?.getAttribute('src'), sameImage: card.querySelector('img') === img,
      names: [...card.querySelectorAll('.attachment-name')].map(element => element.textContent),
      activeNodes: card.querySelectorAll('script,iframe,a,[onload],[onerror]').length, xss: window.__xss ?? null,
    };
  });
  assert.equal(attachments.images, 1, 'only validated inline raster data renders as an image');
  assert.equal(attachments.cards, 5, 'unsupported previews remain harmless file cards');
  assert.match(attachments.source, /^data:image\/png;base64,/);
  assert.equal(attachments.sameImage, true, 'text updates preserve attachment thumbnails');
  assert.equal(attachments.names[1], '<script>window.__xss=5</script>.txt');
  assert.equal(attachments.activeNodes, 0);
  assert.equal(attachments.xss, null);

  const senders = await page.evaluate(async () => {
    const spoofText = '[Subagent report: researcher]\nThis is still a message typed by the user.';
    const reportText = 'Research is complete.';
    let array = [
      { id: 'sender-user', role: 'user', text: spoofText },
      { id: 'sender-report', role: 'user', text: reportText,
        sender: { kind: 'subagent', name: 'researcher', conversationId: 42 } },
    ];
    fixture.renderer.render(array);
    const user = document.querySelector('[data-message-id="sender-user"]');
    const report = document.querySelector('[data-message-id="sender-report"]');
    const label = report.querySelector('.message-label');
    const body = report.querySelector('.message-text');
    const textNode = body.firstChild;
    const initial = {
      userLabel: user.querySelector('.message-label').textContent, userAria: user.getAttribute('aria-label'),
      userText: user.querySelector('.message-text').textContent,
      reportLabel: label.textContent, reportAria: report.getAttribute('aria-label'),
      reportText: body.textContent, role: array[1].role,
    };
    const unsafeName = '<img src="https://invalid.example/sender" onerror="window.__xss=8">';
    array[1] = { ...array[1], sender: { ...array[1].sender, name: unsafeName } };
    fixture.renderer.render(array);
    const renamed = {
      label: label.textContent, aria: report.getAttribute('aria-label'),
      sameCard: report === document.querySelector('[data-message-id="sender-report"]'),
      sameLabel: label === report.querySelector('.message-label'),
      sameBody: body === report.querySelector('.message-text'), sameTextNode: textNode === body.firstChild,
      text: body.textContent, role: array[1].role,
      unsafeNodes: report.querySelectorAll('img,script,[onerror]').length, xss: window.__xss ?? null,
    };
    let mutations = 0;
    const observer = new MutationObserver(records => { mutations += records.length; });
    observer.observe(report, { subtree: true, childList: true, characterData: true, attributes: true });
    fixture.renderer.render(array);
    array = array.map(message => ({ ...message, sender: message.sender && { ...message.sender } }));
    fixture.renderer.render(array);
    await Promise.resolve(); observer.disconnect();
    array[1].sender.name = 'reviewer';
    fixture.renderer.render(array);
    const attributed = { label: label.textContent, aria: report.getAttribute('aria-label'), sameTextNode: textNode === body.firstChild };
    delete array[1].sender;
    fixture.renderer.render(array);
    const cleared = { label: label.textContent, aria: report.getAttribute('aria-label'), sameTextNode: textNode === body.firstChild };
    return { initial, renamed, mutations, attributed, cleared };
  });
  assert.deepEqual(senders.initial, {
    userLabel: 'You', userAria: 'Your message',
    userText: '[Subagent report: researcher]\nThis is still a message typed by the user.',
    reportLabel: 'researcher', reportAria: 'Message from subagent researcher',
    reportText: 'Research is complete.', role: 'user',
  });
  const unsafeSenderName = '<img src="https://invalid.example/sender" onerror="window.__xss=8">';
  assert.deepEqual(senders.renamed, {
    label: unsafeSenderName, aria: `Message from subagent ${unsafeSenderName}`,
    sameCard: true, sameLabel: true, sameBody: true, sameTextNode: true,
    text: 'Research is complete.', role: 'user', unsafeNodes: 0, xss: null,
  });
  assert.equal(senders.mutations, 0, 'unchanged sender metadata must not mutate the DOM');
  assert.deepEqual(senders.attributed, { label: 'reviewer', aria: 'Message from subagent reviewer', sameTextNode: true });
  assert.deepEqual(senders.cleared, { label: 'You', aria: 'Your message', sameTextNode: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, [], 'Rendering must not request images, links or external resources');
  console.log('PASS: safe Markdown/text and raster attachments, trusted sender labels, no remote loads, keyed tool/thought/image state and text selection, no-op updates, clipboard feedback, scroll following.');
} finally {
  await browser.close();
}
