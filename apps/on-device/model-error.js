// apps/on-device/model-error.js
var MAX_BODY_BYTES = 32 * 1024;
var REDACTED = "[redacted]";
function credentials(input, init) {
  try {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : void 0));
    const values = [headers.get("authorization"), headers.get("x-api-key")].filter((value) => typeof value === "string" && value.length > 0);
    const authorization = headers.get("authorization");
    if (authorization) values.push(authorization.replace(/^\S+\s+/, ""));
    return [...new Set(values)].sort((a, b) => b.length - a.length);
  } catch {
    return [];
  }
}
function decodeEscapes(text) {
  for (let pass = 0; pass < 4; pass++) {
    const next = text.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\([\\"'/])/g, "$1").replace(/(?:%[0-9a-f]{2})+/gi, (value) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    });
    if (next === text) break;
    text = next;
  }
  return text;
}
function redact(text, secrets) {
  text = decodeEscapes(text).normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "");
  for (const secret of secrets) if (secret) text = text.split(secret).join(REDACTED);
  text = text.replace(/[A-Za-z0-9_-]*(?:\.{2,}|…+|\*{2,})[A-Za-z0-9_-]*/g, (value) => {
    const [prefix, suffix] = value.split(/\.{2,}|…+|\*{2,}/);
    if (!prefix && !suffix || Math.max(prefix?.length ?? 0, suffix?.length ?? 0) < 4) return value;
    return secrets.some((secret) => (!prefix || secret.startsWith(prefix)) && (!suffix || secret.endsWith(suffix))) ? REDACTED : value;
  });
  text = text.replace(/\bsk-[A-Za-z0-9_-]*(?:(?:\.{2,}|…+|\*{2,})[A-Za-z0-9_-]*)*/gi, REDACTED).replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){0,2}/g, REDACTED).replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED).replace(/\bBearer\s+["']?[^\s"'<>;,]+["']?/gi, `Bearer ${REDACTED}`);
  text = text.replace(/[A-Za-z0-9_./+=~-]{8,}/g, (value) => {
    const fragment = value.replace(/^[./]+|[./]+$/g, "");
    return fragment.length >= 8 && secrets.some((secret) => secret.includes(fragment)) ? REDACTED : value;
  });
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
}
async function readError(response, signal) {
  const contentType = response.headers.get("content-type");
  const length = Number(response.headers.get("content-length"));
  if (!response.body || contentType && !/\b(?:application|text)\/(?:[\w.+-]+\+)?json\b/i.test(contentType) || length > MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => {
    });
    return void 0;
  }
  let reader;
  try {
    reader = response.body.getReader();
  } catch {
    return void 0;
  }
  const timeout = AbortSignal.timeout(5e3);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(new Error("Model error read interrupted"));
    if (stop.aborted) abort();
    else stop.addEventListener("abort", abort, { once: true });
  });
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0, text = "";
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) return void 0;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const body = JSON.parse(text);
    const error = body && typeof body === "object" && !Array.isArray(body) ? body.error : void 0;
    return error && typeof error === "object" && !Array.isArray(error) ? error : void 0;
  } catch {
    return void 0;
  } finally {
    stop.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {
    });
  }
}
async function safeModelErrorResponse(response, { provider, input, init } = {}) {
  if (response.ok) return response;
  const label = ["Claude", "ChatGPT", "OpenAI"].includes(provider) ? provider : "Model";
  const prefix = `${label} request failed (${response.status}).`;
  const fallback = `${prefix} Check your ${label === "OpenAI" ? "API key" : "sign-in"}, model access and account limits.`;
  const secrets = credentials(input, init);
  const error = await readError(response, init?.signal ?? (input instanceof Request ? input.signal : void 0));
  const fields = {};
  if (error) for (const [name, limit] of [["message", 8192], ["type", 128], ["code", 128]]) {
    const value = error[name];
    if (typeof value !== "string" || value.length === 0 || value.length > limit) continue;
    const safe = redact(value, secrets);
    if (safe) fields[name] = safe;
  }
  const kind = [...new Set([fields.type, fields.code].filter(Boolean))].join("; ");
  const reason = [fields.message, kind ? `(${kind})` : ""].filter(Boolean).join(" ");
  const message = Array.from(reason ? `${prefix} ${reason}` : fallback);
  const safeMessage = message.length > 500 ? message.slice(0, 499).join("") + "\u2026" : message.join("");
  return new Response(response.status === 304 ? null : JSON.stringify({ error: { ...fields, message: safeMessage } }), {
    status: response.status,
    headers: { "content-type": "application/json" }
  });
}
export {
  safeModelErrorResponse
};
