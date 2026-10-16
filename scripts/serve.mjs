import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Development/test static server only. No server is shipped in the Android APK. */
export async function serve(directory = resolve('dist/app'), port = 4173, headers = {}, options = {}) {
  const root = resolve(directory);
  const host = options.auth ? await (await import('./dev-host.mjs')).createDevHost(options.auth === true ? {} : options.auth) : undefined;
  const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css', '.ttf':'font/ttf', '.woff2':'font/woff2', '.json':'application/json', '.map':'application/json' };
  const server = createServer(async (request, response) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (host && await host.handle(request, response, origin)) return;
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let path = resolve(root, `.${pathname}`);
      if (path !== root && !path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
      if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
      const content = await readFile(path);
      response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Cache-Control':'no-store', ...headers });
      response.end(content);
    } catch { response.writeHead(404).end('Not found. Run the build first.'); }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}`, close: async () => {
    await host?.close();
    await new Promise((done, fail) => { server.close(error => error ? fail(error) : done()); server.closeAllConnections(); });
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const preview = await serve(undefined, Number(process.env.PORT ?? 4173), {
    'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.openai.com https://api.anthropic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  }, { auth: true });
  console.log(`Self Forming development server: ${preview.url} (browser development app uses temporary memory storage)`);
}
