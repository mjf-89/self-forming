
export async function boundedDirectoryFetch(url, cap, controller) {
  let reader;
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {signal:controller.signal, credentials:'omit', redirect:'error', cache:'no-store'});
    if (!response.ok) throw new Error('directory HTTP status ' + response.status);
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > cap)) throw new Error('directory size limit');
    if (!response.body) throw new Error('directory streaming body required');
    reader = response.body.getReader();
    const chunks = []; let size = 0; let chunkCount = 0;
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      if (++chunkCount > 16384) throw new Error('directory chunk count limit');
      if (!(value instanceof Uint8Array) || value.byteLength > cap - size) throw new Error('directory size limit');
      if (value.byteLength === 0) continue;
      size += value.byteLength; chunks.push(value);
      if (chunks.length > 16384) throw new Error('directory chunk count limit');
    }
    const result = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { result.set(chunk, at); at += chunk.byteLength; }
    return result;
  } finally {
    clearTimeout(timer); controller.abort();
    if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
  }
}
