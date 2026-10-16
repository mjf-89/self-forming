// OpenAI Chat Completions stream for the openai-compatible plugin (plain browser JS).
//
// Ported from pi-ai v1.0.4, packages/ai/src/api/openai-completions.ts and the pieces it
// imports (api/transform-messages.ts, api/simple-options.ts, api/openai-prompt-cache.ts,
// utils/error-body.ts, utils/provider-retry.ts, utils/sanitize-unicode.ts, utils/hash.ts,
// utils/estimate.ts), https://github.com/earendil-works/pi (tag v1.0.4).
//
//   MIT License
//   Copyright (c) 2025 Mario Zechner
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software
//   without restriction, including without limitation the rights to use, copy, modify,
//   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following
//   conditions: The above copyright notice and this permission notice shall be included
//   in all copies or substantial portions of the Software.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
//   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
//   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
//   OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// Differences from upstream (on purpose):
// - No OpenAI SDK: the request is a plain fetch (options.fetch, the transport the host
//   gives this request) and the SSE stream is parsed here, with the SDK's error shape
//   ({status, error: <parsed body.error>, headers}) so error formatting stays the same.
// - The API key is optional (keyless local servers): no key means no Authorization header.
// - Errors carry a prefix ("<label> API error (<status>): {...}") so the app shows the
//   host's safe, redacted "<label> request failed (<status>)." text (session.js
//   modelErrorText), like the bundled openai-responses stream does.
// - Not ported: provider-specific thinking formats (zai, qwen, chat-template, baseten,
//   deepseek, openrouter, ant-ling, together, string-thinking, thinking budgets; this
//   plugin has no thinking control), GitHub Copilot headers, grammar/custom tools and
//   strict JSON-schema tools (a tool that *requires* strict sampling is refused, as
//   upstream does when strict tools are unsupported), Kimi mid-conversation tool
//   messages (supportsMidConvoToolAdditions), telemetry.
// - Streamed reasoning (reasoning_content / reasoning / reasoning_text, reasoning_details)
//   is still parsed into thinking blocks, as upstream, because local servers (llama.cpp
//   with gpt-oss, Qwen, DeepSeek) send it without being asked.
//
// The host's own pi-ai pieces come in as `ai` (ctx.pi.ai): createAssistantMessageEventStream,
// parseStreamingJson, calculateCost, resolveTranscript, resolveTranscriptTools,
// getDeclaredTools, getSystemMessageText, renderSystemMessageUpdate (clampThinkingLevel is
// used when present).

export const API = "openai-completions";
export const REQUIRED_AI = Object.freeze([
  "createAssistantMessageEventStream", "parseStreamingJson", "calculateCost", "resolveTranscript",
  "resolveTranscriptTools", "getDeclaredTools", "getSystemMessageText", "renderSystemMessageUpdate"
]);

// ---- utils/sanitize-unicode.ts, utils/hash.ts, api/openai-prompt-cache.ts ----
function sanitizeSurrogates(text) {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
function shortHash(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
function clampOpenAIPromptCacheKey(key) {
  if (key === undefined) return undefined;
  const chars = Array.from(key);
  return chars.length <= 64 ? key : chars.slice(0, 64).join("");
}

// ---- utils/error-body.ts ----
const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;
function safeJsonStringify(value) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}
function isPlainNonEmptyObject(value) {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.keys(value).length > 0;
}
function truncateErrorText(text, maxChars) {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}
export function normalizeProviderError(error) {
  if (!(error instanceof Error)) return { message: safeJsonStringify(error), messageCarriesBody: false };
  const status = typeof error.statusCode === "number" ? error.statusCode : typeof error.status === "number" ? error.status : undefined;
  let bodyText;
  if (typeof error.body === "string") bodyText = error.body;
  else if (isPlainNonEmptyObject(error.error)) bodyText = safeJsonStringify(error.error);
  const trimmed = bodyText?.trim();
  const body = trimmed ? truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS) : undefined;
  return { status, body, message: error.message, messageCarriesBody: body === undefined || error.message.includes(body) };
}
export function formatProviderError(norm, prefix) {
  if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
    return prefix !== undefined && norm.status !== undefined ? `${prefix} (${norm.status}): ${norm.message}` : norm.message;
  }
  return prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
}

// ---- The OpenAI SDK's APIError shape (status, parsed error object, headers) ----
export class ProviderHttpError extends Error {
  constructor(status, error, message, headers) {
    const text = error?.message ? (typeof error.message === "string" ? error.message : JSON.stringify(error.message)) : error ? JSON.stringify(error) : message;
    super(status && text ? `${status} ${text}` : status ? `${status} status code (no body)` : text || "(no status code or body)");
    this.name = "ProviderHttpError";
    this.status = status;
    this.error = error;
    this.headers = headers;
  }
}

// ---- utils/provider-retry.ts ----
function isRetryableProviderError(error) {
  const shouldRetry = error.headers?.get?.("x-should-retry");
  if (shouldRetry === "true") return true;
  if (shouldRetry === "false") return false;
  if (error.status === undefined) return true;
  return error.status === 408 || error.status === 409 || error.status === 429 || (typeof error.status === "number" && error.status >= 500);
}
function retryDelayMs(error, retryIndex, maxRetryDelayMs) {
  const check = (delayMs) => {
    const max = maxRetryDelayMs ?? 60000;
    if (max > 0 && delayMs > max) throw new Error(`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(max / 1000)}s). ${error.message}`);
    return delayMs;
  };
  const ms = error.headers?.get?.("retry-after-ms");
  if (ms && Number.isFinite(Number.parseFloat(ms))) return check(Number.parseFloat(ms));
  const after = error.headers?.get?.("retry-after");
  if (after) {
    const seconds = Number.parseFloat(after);
    const delay = Number.isNaN(seconds) ? Date.parse(after) - Date.now() : seconds * 1000;
    if (Number.isFinite(delay)) return check(delay);
  }
  return Math.min(0.5 * 2 ** retryIndex, 8) * 1000 * (1 - Math.random() * 0.25);
}
function abortError() {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
async function retryProviderRequest(request, { maxRetries = 0, maxRetryDelayMs, signal } = {}) {
  let remaining = maxRetries;
  for (;;) {
    try {
      return await request();
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (remaining <= 0 || !(error instanceof ProviderHttpError) || !isRetryableProviderError(error)) throw error;
      const index = maxRetries - remaining;
      remaining--;
      await sleep(retryDelayMs(error, index, maxRetryDelayMs), signal);
    }
  }
}

// ---- Server-sent events (what the OpenAI SDK's Stream does for chat completions) ----
async function* sseEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  let event = null;
  const flush = function* () {
    if (data.length === 0 && event === null) return;
    const item = { event, data: data.join("\n") };
    data = [];
    event = null;
    yield item;
  };
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(buffer[index] === "\r" && buffer[index + 1] === "\n" ? index + 2 : index + 1);
        if (line === "") { yield* flush(); continue; }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") data.push(value);
        else if (field === "event") event = value;
      }
      if (done) {
        if (buffer) { if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, "")); buffer = ""; }
        yield* flush();
        return;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}
async function* chatCompletionChunks(response, signal) {
  if (!response.body) throw new Error("The model server sent an empty response.");
  for await (const sse of sseEvents(response.body, signal)) {
    if (sse.data.startsWith("[DONE]")) return;
    if (sse.event === "error") throw new ProviderHttpError(undefined, safeParse(sse.data) ?? { message: sse.data }, undefined, response.headers);
    if (!sse.data) continue;
    const data = safeParse(sse.data);
    if (data === undefined) throw new Error(`Could not parse a streamed chunk from the model server: ${truncateErrorText(sse.data, 200)}`);
    if (data && data.error) throw new ProviderHttpError(undefined, data.error, undefined, response.headers);
    yield data;
  }
}
function safeParse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}
async function readErrorBody(response) {
  let text = "";
  try { text = await response.text(); } catch { /* unreadable */ }
  const json = safeParse(text);
  return json !== undefined ? { error: json?.error ?? json } : { message: text.trim() ? truncateErrorText(text.trim(), 500) : undefined };
}

// ---- api/simple-options.ts, utils/estimate.ts ----
const CHARS_PER_TOKEN = 4;
function estimateMessageTokens(message, getSystemMessageText) {
  const chars = (content) => typeof content === "string" ? content.length : (content ?? []).reduce((n, b) => n + (b.type === "text" ? b.text.length : b.type === "image" ? 4800 : 0), 0);
  if (message.role === "system") {
    const tools = [...(message.toolsAdded ?? []), ...(message.toolsRemoved ?? [])];
    return Math.ceil(getSystemMessageText(message).length / CHARS_PER_TOKEN) + (tools.length ? Math.ceil(safeJsonStringify(tools).length / CHARS_PER_TOKEN) : 0);
  }
  if (message.role === "user" || message.role === "toolResult") return Math.ceil(chars(message.content) / CHARS_PER_TOKEN);
  let n = 0;
  for (const block of message.content ?? []) {
    if (block.type === "text") n += block.text.length;
    else if (block.type === "thinking") n += block.thinking.length;
    else if (block.type === "toolCall") n += block.name.length + safeJsonStringify(block.arguments).length;
  }
  return Math.ceil(n / CHARS_PER_TOKEN);
}
function estimateContextTokens(messages, getSystemMessageText) {
  const total = (usage) => usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  let latest = Number.NEGATIVE_INFINITY, usageIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant" && message.timestamp >= latest && message.stopReason !== "aborted" && message.stopReason !== "error" && message.usage && total(message.usage) > 0) usageIndex = i;
    latest = Math.max(latest, message.timestamp ?? 0);
  }
  let tokens = usageIndex >= 0 ? total(messages[usageIndex].usage) : 0;
  for (let i = usageIndex + 1; i < messages.length; i++) tokens += estimateMessageTokens(messages[i], getSystemMessageText);
  return tokens;
}

// ---- api/transform-messages.ts ----
function replaceImagesWithPlaceholder(content, placeholder) {
  const result = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (block.type === "image") {
      if (!previousWasPlaceholder) result.push({ type: "text", text: placeholder });
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = block.text === placeholder;
  }
  return result;
}
function downgradeUnsupportedImages(messages, model) {
  if (model.input.includes("image")) return messages;
  return messages.map((msg) => {
    if (msg.role === "user" && Array.isArray(msg.content)) return { ...msg, content: replaceImagesWithPlaceholder(msg.content, "(image omitted: model does not support images)") };
    if (msg.role === "toolResult") return { ...msg, content: replaceImagesWithPlaceholder(msg.content, "(tool image omitted: model does not support images)") };
    return msg;
  });
}
export function transformMessages(messages, model, normalizeToolCallId) {
  const toolCallIdMap = new Map();
  const normalized = messages.map((msg) => msg.content == null ? { ...msg, content: [] } : msg);
  const transformed = downgradeUnsupportedImages(normalized, model).map((msg) => {
    if (msg.role === "system" || msg.role === "user") return msg;
    if (msg.role === "toolResult") {
      const id = toolCallIdMap.get(msg.toolCallId);
      return id && id !== msg.toolCallId ? { ...msg, toolCallId: id } : msg;
    }
    if (msg.role === "assistant") {
      const isSameModel = msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
      const content = msg.content.flatMap((block) => {
        if (block.type === "thinking") {
          if (block.redacted) return isSameModel ? block : [];
          if (isSameModel && block.thinkingSignature) return block;
          if (!block.thinking || block.thinking.trim() === "") return [];
          if (isSameModel) return block;
          return { type: "text", text: block.thinking };
        }
        if (block.type === "text") return isSameModel ? block : { type: "text", text: block.text };
        if (block.type === "toolCall") {
          let call = block;
          if (!isSameModel && call.thoughtSignature) {
            call = { ...call };
            delete call.thoughtSignature;
          }
          if (!isSameModel && normalizeToolCallId) {
            const id = normalizeToolCallId(block.id, model, msg);
            if (id !== block.id) {
              toolCallIdMap.set(block.id, id);
              call = { ...call, id };
            }
          }
          return call;
        }
        return block;
      });
      return { ...msg, content };
    }
    return msg;
  });
  const result = [];
  let pending = [];
  let answered = new Set();
  const held = [];
  const close = () => {
    for (const call of pending) {
      if (!answered.has(call.id)) result.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "No result provided" }], isError: true, timestamp: Date.now() });
    }
    pending = [];
    answered = new Set();
    result.push(...held);
    held.length = 0;
  };
  for (const msg of transformed) {
    if (msg.role === "assistant") {
      close();
      if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
      const calls = msg.content.filter((b) => b.type === "toolCall");
      if (calls.length > 0) {
        pending = calls;
        answered = new Set();
      }
      result.push(msg);
    } else if (msg.role === "toolResult") {
      answered.add(msg.toolCallId);
      result.push(msg);
    } else if (msg.role === "system") {
      if (pending.length > 0) held.push(msg);
      else result.push(msg);
    } else if (msg.role === "user") {
      close();
      result.push(msg);
    } else result.push(msg);
  }
  close();
  return result;
}

// ---- openai-completions.ts: reasoning details ----
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function isOpenAIReasoningDetail(detail) {
  if (!isObject(detail)) return false;
  if (!((detail.id === undefined || detail.id === null || typeof detail.id === "string") && (detail.format === undefined || typeof detail.format === "string") && (detail.index === undefined || typeof detail.index === "number"))) return false;
  switch (detail.type) {
    case "reasoning.summary": return typeof detail.summary === "string";
    case "reasoning.encrypted": return typeof detail.data === "string";
    case "reasoning.text": return typeof detail.text === "string" && (detail.signature === undefined || detail.signature === null || typeof detail.signature === "string");
    default: return false;
  }
}
function parseOpenAIReasoningDetails(signature) {
  if (!signature) return undefined;
  const parsed = safeParse(signature);
  return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isOpenAIReasoningDetail) ? parsed : undefined;
}
function parseLegacyEncryptedReasoningDetail(signature) {
  if (!signature) return undefined;
  const parsed = safeParse(signature);
  return isOpenAIReasoningDetail(parsed) && parsed.type === "reasoning.encrypted" && typeof parsed.id === "string" && parsed.id.length > 0 && parsed.data.length > 0 ? parsed : undefined;
}
function appendOpenAIReasoningDetail(details, detail) {
  const last = details[details.length - 1];
  const fill = (target) => {
    target.id ??= detail.id;
    target.format ||= detail.format;
    target.index ??= detail.index;
  };
  if (detail.type === "reasoning.text" && last?.type === "reasoning.text") {
    last.text += detail.text;
    last.signature ||= detail.signature;
    fill(last);
    return;
  }
  if (detail.type === "reasoning.summary" && last?.type === "reasoning.summary") {
    last.summary += detail.summary;
    fill(last);
    return;
  }
  details.push({ ...detail });
}
const REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"];
const hasToolHistory = (messages) => messages.some((msg) => msg.role === "toolResult" || (msg.role === "assistant" && msg.content.some((block) => block.type === "toolCall")));

// ---- openai-completions.ts: compatibility (detectCompat / getCompat) ----
export function detectCompat(model) {
  const provider = model.provider;
  const baseUrl = model.baseUrl;
  const isZai = provider === "zai" || provider === "zai-coding-cn" || baseUrl.includes("api.z.ai") || baseUrl.includes("open.bigmodel.cn");
  const isTogether = provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
  const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
  const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
  const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
  const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
  const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
  const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
  const isCerebras = provider === "cerebras" || baseUrl.includes("cerebras.ai");
  const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");
  const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
  const isNonStandard = isNvidia || isCerebras || isGrok || isTogether || baseUrl.includes("chutes.ai") || isDeepSeek || isZai || isMoonshot ||
    provider === "opencode" || baseUrl.includes("opencode.ai") || isCloudflareWorkersAI || isCloudflareAiGateway || isAntLing;
  const useMaxTokens = baseUrl.includes("chutes.ai") || isDeepSeek || isMoonshot || isCloudflareAiGateway || isTogether || isNvidia || isAntLing || isZai;
  const isOpenRouterDeveloperRoleModel = isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
  return {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
    supportsReasoningEffort: !isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
    supportsUsageInStreaming: true,
    supportsFinishReason: true,
    maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: isDeepSeek,
    supportsStrictMode: false,
    supportsMidConvoSystemMessages: false,
    cacheControlFormat: provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : undefined,
    sendSessionAffinityHeaders: isOpenRouter,
    sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
    supportsLongCacheRetention: !(isTogether || isCloudflareWorkersAI || isCloudflareAiGateway || isNvidia || isAntLing),
    openRouterRouting: {}
  };
}
export function getCompat(model) {
  const detected = detectCompat(model);
  if (!model.compat) return detected;
  const resolved = { ...detected };
  for (const key of Object.keys(detected)) if (model.compat[key] !== undefined) resolved[key] = model.compat[key];
  if (model.compat.vllmPriority !== undefined) resolved.vllmPriority = model.compat.vllmPriority;
  return resolved;
}

// ---- openai-completions.ts: anthropic-style cache control (OpenRouter anthropic/ models) ----
function addCacheControlToTextContent(message, cacheControl) {
  const content = message.content;
  if (typeof content === "string") {
    if (content.length === 0) return false;
    message.content = [{ type: "text", text: content, cache_control: cacheControl }];
    return true;
  }
  if (!Array.isArray(content)) return false;
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i]?.type === "text") {
      content[i].cache_control = cacheControl;
      return true;
    }
  }
  return false;
}
function applyAnthropicCacheControl(messages, tools, cacheControl) {
  const system = messages.find((message) => message.role === "system" || message.role === "developer");
  if (system) addCacheControlToTextContent(system, cacheControl);
  if (tools?.length) tools[tools.length - 1].cache_control = cacheControl;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if ((message.role === "user" || message.role === "assistant" || message.role === "tool") && addCacheControlToTextContent(message, cacheControl)) return;
  }
}

function mapStopReason(reason) {
  if (reason === null) return { stopReason: "stop" };
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
    case "network_error":
      return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
    default:
      return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
  }
}

/**
 * createOpenAICompletions(ai, {errorPrefix}) → {stream, streamSimple, convertMessages,
 * convertTools, buildParams, parseChunkUsage, mapStopReason, getCompat}.
 * stream(model, transcript, options): options.apiKey or resolveApiKey(model) (both
 * optional; no key = no Authorization header), options.fetch (the
 * transport for this request; globalThis.fetch if absent), signal, headers, maxTokens,
 * temperature, toolChoice, sessionId, cacheRetention, onPayload, onResponse,
 * onProviderStreamEvent, maxRetries, maxRetryDelayMs, timeoutMs.
 */
export function createOpenAICompletions(ai, { errorPrefix = (model) => `${model.provider} API error` } = {}) {
  const missing = REQUIRED_AI.filter((name) => typeof ai?.[name] !== "function");
  if (missing.length) throw new Error(`The host's pi-ai exports are missing ${missing.join(", ")} (ctx.pi.ai)`);
  const { createAssistantMessageEventStream, parseStreamingJson, calculateCost, resolveTranscript, resolveTranscriptTools, getDeclaredTools, getSystemMessageText, renderSystemMessageUpdate } = ai;
  const effectiveThinking = (model, level) => !model.reasoning ? "off" : typeof ai.clampThinkingLevel === "function" ? ai.clampThinkingLevel(model, level) : level;

  function resolveSamplingParams(model, thinkingLevel, requestParams) {
    const byLevel = model.samplingParamsByThinkingLevel?.[effectiveThinking(model, thinkingLevel)];
    return model.samplingParams || byLevel || requestParams ? { ...model.samplingParams, ...byLevel, ...requestParams } : undefined;
  }
  function clampMaxTokensToContext(model, context, maxTokens) {
    if (model.contextWindow <= 0) return Math.max(1, maxTokens);
    const available = model.contextWindow - estimateContextTokens(context.messages, getSystemMessageText) - 4096;
    return Math.min(maxTokens, Math.max(1, available));
  }
  const resolveCacheRetention = (retention) => retention ?? "short";

  function convertTools(tools, compat) {
    return tools.map((tool) => {
      if (tool.constrainedSampling?.type === "json_schema" && tool.constrainedSampling.strict === "require") {
        throw new Error(`Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`);
      }
      if (tool.constrainedSampling && tool.constrainedSampling.type !== "json_schema" && tool.constrainedSampling.strict === "require") {
        throw new Error(`Tool "${tool.name}" requires grammar-constrained sampling, which this provider does not support.`);
      }
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(compat.supportsStrictMode !== false && { strict: false })
        }
      };
    });
  }

  function convertMessages(model, context, compat) {
    const normalizedContext = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
    const params = [];
    const normalizeToolCallId = (id) => {
      if (id.includes("|")) {
        const separator = id.indexOf("|");
        const callId = id.slice(0, separator).replace(/[^a-zA-Z0-9_-]/g, "_");
        const itemId = id.slice(separator + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
        const combined = itemId.length > 0 ? `${callId}_${itemId}` : callId;
        if (combined.length <= 40) return combined;
        const hash = shortHash(id).slice(0, 8);
        return `${callId.slice(0, Math.max(1, 40 - hash.length - 1))}_${hash}`;
      }
      return id;
    };
    const messages = transformMessages(normalizedContext.messages, model, normalizeToolCallId);
    const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";
    let lastRole = null;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
        params.push({ role: "assistant", content: "I have processed the tool results." });
      }
      if (msg.role === "system") {
        const text = i === 0 ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg);
        if (text.length > 0) params.push({ role: instructionRole, content: sanitizeSurrogates(text) });
      } else if (msg.role === "user") {
        if (typeof msg.content === "string") {
          params.push({ role: "user", content: sanitizeSurrogates(msg.content) });
        } else {
          const content = msg.content
            .filter((item) => item.type !== "text" || item.text.length > 0)
            .map((item) => item.type === "text"
              ? { type: "text", text: sanitizeSurrogates(item.text) }
              : { type: "image_url", image_url: { url: `data:${item.mimeType};base64,${item.data}` } });
          if (content.length === 0) continue;
          params.push({ role: "user", content });
        }
      } else if (msg.role === "assistant") {
        const assistantMsg = { role: "assistant", content: compat.requiresAssistantAfterToolResult ? "" : null };
        const textParts = msg.content.filter((b) => b.type === "text").filter((b) => b.text.trim().length > 0).map((b) => ({ type: "text", text: sanitizeSurrogates(b.text) }));
        const assistantText = textParts.map((part) => part.text).join("");
        const thinkingBlocks = msg.content.filter((b) => b.type === "thinking");
        const toolCalls = msg.content.filter((b) => b.type === "toolCall");
        const signed = thinkingBlocks.map((b) => parseOpenAIReasoningDetails(b.thinkingSignature)).find((d) => d !== undefined);
        const legacy = toolCalls.map((tc) => parseLegacyEncryptedReasoningDetail(tc.thoughtSignature)).filter((d) => d !== undefined);
        const preserved = signed ?? (legacy.length > 0 ? legacy : undefined);
        const nonEmptyThinking = thinkingBlocks.filter((b) => b.thinking.trim().length > 0);
        if (nonEmptyThinking.length > 0) {
          if (compat.requiresThinkingAsText) {
            assistantMsg.content = [{ type: "text", text: nonEmptyThinking.map((b) => sanitizeSurrogates(b.thinking)).join("\n\n") }, ...textParts];
          } else {
            if (assistantText.length > 0) assistantMsg.content = assistantText;
            if (!preserved) {
              const signature = nonEmptyThinking[0].thinkingSignature;
              if (signature && REASONING_FIELDS.includes(signature)) assistantMsg[signature] = nonEmptyThinking.map((b) => b.thinking).join("\n");
            }
          }
        } else if (assistantText.length > 0) {
          assistantMsg.content = assistantText;
        }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }));
        }
        if (preserved) assistantMsg.reasoning_details = preserved;
        if (compat.requiresReasoningContentOnAssistantMessages && model.reasoning && assistantMsg.reasoning_content === undefined) assistantMsg.reasoning_content = "";
        const content = assistantMsg.content;
        const hasContent = content !== null && content !== undefined && content.length > 0;
        if (!hasContent && !assistantMsg.tool_calls) continue;
        params.push(assistantMsg);
      } else if (msg.role === "toolResult") {
        const imageBlocks = [];
        let j = i;
        for (; j < messages.length && messages[j].role === "toolResult"; j++) {
          const toolMsg = messages[j];
          const textResult = toolMsg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
          const hasImages = toolMsg.content.some((c) => c.type === "image");
          const toolResultMsg = {
            role: "tool",
            content: sanitizeSurrogates(textResult.length > 0 ? textResult : hasImages ? "(see attached image)" : "(no tool output)"),
            tool_call_id: toolMsg.toolCallId
          };
          if (compat.requiresToolResultName && toolMsg.toolName) toolResultMsg.name = toolMsg.toolName;
          params.push(toolResultMsg);
          if (hasImages && model.input.includes("image")) {
            for (const block of toolMsg.content) {
              if (block.type === "image") imageBlocks.push({ type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } });
            }
          }
        }
        i = j - 1;
        if (imageBlocks.length > 0) {
          if (compat.requiresAssistantAfterToolResult) params.push({ role: "assistant", content: "I have processed the tool results." });
          params.push({ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...imageBlocks] });
          lastRole = "user";
        } else {
          lastRole = "toolResult";
        }
        continue;
      }
      lastRole = msg.role;
    }
    return params;
  }

  function buildParams(model, context, options, compat = getCompat(model), cacheRetention = resolveCacheRetention(options?.cacheRetention)) {
    const transcriptTools = resolveTranscriptTools(context.messages, false);
    const messages = convertMessages(model, context, compat);
    const cacheControl = compat.cacheControlFormat === "anthropic" && cacheRetention !== "none"
      ? { type: "ephemeral", ...(cacheRetention === "long" && compat.supportsLongCacheRetention ? { ttl: "1h" } : {}) }
      : undefined;
    const params = {
      model: model.requestModelId ?? model.id,
      messages,
      stream: true
    };
    if ((model.baseUrl.includes("api.openai.com") && cacheRetention !== "none") || (cacheRetention === "long" && compat.supportsLongCacheRetention)) {
      const key = clampOpenAIPromptCacheKey(options?.sessionId);
      if (key !== undefined) params.prompt_cache_key = key;
    }
    if (cacheRetention === "long" && compat.supportsLongCacheRetention) params.prompt_cache_retention = "24h";
    if (compat.supportsUsageInStreaming !== false) params.stream_options = { include_usage: true };
    if (compat.supportsStore) params.store = false;
    if (options?.maxTokens) {
      if (compat.maxTokensField === "max_tokens") params.max_tokens = options.maxTokens;
      else params.max_completion_tokens = options.maxTokens;
    }
    if (options?.temperature !== undefined) params.temperature = options.temperature;
    if (transcriptTools.requestTools.length > 0) params.tools = convertTools(transcriptTools.requestTools, compat);
    else if (hasToolHistory(context.messages)) params.tools = [];
    if (cacheControl) applyAnthropicCacheControl(messages, params.tools, cacheControl);
    if (options?.toolChoice) params.tool_choice = options.toolChoice;
    if (compat.vllmPriority !== undefined) params.priority = compat.vllmPriority;
    if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
      params.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
    } else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort && typeof model.thinkingLevelMap?.off === "string") {
      params.reasoning_effort = model.thinkingLevelMap.off;
    }
    if (model.compat?.openRouterRouting) params.provider = model.compat.openRouterRouting;
    const samplingParams = resolveSamplingParams(model, options?.reasoningEffort ?? "off", options?.samplingParams);
    if (samplingParams) Object.assign(params, samplingParams);
    return params;
  }

  function parseChunkUsage(rawUsage, model) {
    const promptTokens = rawUsage.prompt_tokens || 0;
    const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? rawUsage.cached_tokens ?? 0;
    const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
    const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
    const outputTokens = rawUsage.completion_tokens || 0;
    const usage = {
      input,
      output: outputTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
      reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
      totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    };
    calculateCost(model, usage);
    return usage;
  }

  // The request (createClient + chat.completions.create(...).withResponse()).
  async function request(model, params, options, compat) {
    const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
    for (const [name, value] of Object.entries(model.headers ?? {})) if (value != null) headers.set(name, value);
    const sessionId = resolveCacheRetention(options?.cacheRetention) === "none" ? undefined : options?.sessionId;
    if (sessionId && compat.sendSessionAffinityHeaders) {
      if (compat.sessionAffinityFormat === "openrouter") headers.set("x-session-id", sessionId);
      else {
        if (compat.sessionAffinityFormat === "openai") headers.set("session_id", sessionId);
        headers.set("x-client-request-id", sessionId);
        headers.set("x-session-affinity", sessionId);
      }
    }
    if (options?.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);
    for (const [name, value] of Object.entries(options?.headers ?? {})) {
      if (value === null || value === undefined) headers.delete(name);
      else headers.set(name, value);
    }
    const fetchImpl = options?.fetch ?? globalThis.fetch.bind(globalThis);
    const url = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let signal = options?.signal;
    let timer;
    if (options?.timeoutMs !== undefined) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => controller.abort(new Error("Request timed out")), options.timeoutMs);
      signal = controller.signal;
    }
    try {
      const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(params), ...(signal ? { signal } : {}) });
      if (!response.ok) {
        const body = await readErrorBody(response);
        throw new ProviderHttpError(response.status, body.error, body.message, response.headers);
      }
      return { response, signal, done: () => clearTimeout(timer) };
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  }

  function stream(model, context, options) {
    const out = createAssistantMessageEventStream();
    const compat = getCompat(model);
    const normalizedContext = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
    (async () => {
      const output = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "pending",
        timestamp: Date.now()
      };
      let streamedReasoningDetails;
      const applyStreamedReasoningDetails = (block) => {
        if (streamedReasoningDetails !== undefined) block.thinkingSignature = JSON.stringify(streamedReasoningDetails);
      };
      let finished = () => {};
      try {
        const cacheRetention = resolveCacheRetention(options?.cacheRetention);
        let params = buildParams(model, normalizedContext, options, compat, cacheRetention);
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) params = nextParams;
        // The key may be resolved per request (options.resolveApiKey); it only goes into the header.
        const apiKey = options?.apiKey ?? await options?.resolveApiKey?.(model);
        const requestOptions = { ...options, apiKey };
        const { response, signal, done } = await retryProviderRequest(
          () => request(model, params, requestOptions, compat),
          { maxRetries: options?.maxRetries, maxRetryDelayMs: options?.maxRetryDelayMs, signal: options?.signal }
        );
        finished = done;
        await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers.entries()) }, model);
        out.push({ type: "start", partial: output });

        let textBlock = null;
        let thinkingBlock = null;
        let hasFinishReason = false;
        const byIndex = new Map();
        const byId = new Map();
        const blocks = output.content;
        const indexOf = (block) => blocks.indexOf(block);
        const finishBlock = (block) => {
          const contentIndex = indexOf(block);
          if (contentIndex === -1) return;
          if (block.type === "text") out.push({ type: "text_end", contentIndex, content: block.text, partial: output });
          else if (block.type === "thinking") {
            applyStreamedReasoningDetails(block);
            out.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
          } else if (block.type === "toolCall") {
            block.arguments = parseStreamingJson(block.partialArgs);
            delete block.partialArgs;
            delete block.streamIndex;
            out.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
          }
        };
        const ensureTextBlock = () => {
          if (!textBlock) {
            textBlock = { type: "text", text: "" };
            blocks.push(textBlock);
            out.push({ type: "text_start", contentIndex: indexOf(textBlock), partial: output });
          }
          return textBlock;
        };
        const ensureThinkingBlock = (thinkingSignature) => {
          if (!thinkingBlock) {
            thinkingBlock = { type: "thinking", thinking: "", thinkingSignature };
            blocks.push(thinkingBlock);
            out.push({ type: "thinking_start", contentIndex: indexOf(thinkingBlock), partial: output });
          }
          return thinkingBlock;
        };
        const ensureToolCallBlock = (toolCall) => {
          const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
          const name = toolCall.function?.name ?? "";
          let block = streamIndex !== undefined ? byIndex.get(streamIndex) : undefined;
          if (!block && toolCall.id) block = byId.get(toolCall.id);
          if (!block) {
            block = { type: "toolCall", id: toolCall.id || "", name, arguments: {}, partialArgs: "", streamIndex };
            if (streamIndex !== undefined) byIndex.set(streamIndex, block);
            if (toolCall.id) byId.set(toolCall.id, block);
            blocks.push(block);
            out.push({ type: "toolcall_start", contentIndex: indexOf(block), partial: output });
          }
          if (streamIndex !== undefined && block.streamIndex === undefined) {
            block.streamIndex = streamIndex;
            byIndex.set(streamIndex, block);
          }
          if (toolCall.id) byId.set(toolCall.id, block);
          if (!block.name && name) block.name = name;
          return block;
        };

        for await (const chunk of chatCompletionChunks(response, signal)) {
          await options?.onProviderStreamEvent?.(chunk, model);
          if (!chunk || typeof chunk !== "object") continue;
          output.responseId ||= chunk.id;
          if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== (model.requestModelId ?? model.id)) output.responseModel ||= chunk.model;
          if (chunk.usage) output.usage = parseChunkUsage(chunk.usage, model);
          const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
          if (!choice) continue;
          if (!chunk.usage && choice.usage) output.usage = parseChunkUsage(choice.usage, model);
          if (choice.finish_reason) {
            output.rawStopReason = choice.finish_reason;
            const mapped = mapStopReason(choice.finish_reason);
            output.stopReason = mapped.stopReason;
            if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;
            hasFinishReason = true;
          }
          const delta = choice.delta;
          if (!delta) continue;
          if (typeof delta.content === "string" && delta.content.length > 0) {
            const block = ensureTextBlock();
            block.text += delta.content;
            out.push({ type: "text_delta", contentIndex: indexOf(block), delta: delta.content, partial: output });
          }
          // llama.cpp sends reasoning_content, others reasoning; the first non-empty one wins.
          const field = ["reasoning_content", "reasoning", "reasoning_text"].find((name) => typeof delta[name] === "string" && delta[name].length > 0);
          if (field) {
            const block = ensureThinkingBlock(field);
            block.thinking += delta[field];
            out.push({ type: "thinking_delta", contentIndex: indexOf(block), delta: delta[field], partial: output });
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const toolCall of delta.tool_calls) {
              const block = ensureToolCallBlock(toolCall);
              if (!block.id && toolCall.id) {
                block.id = toolCall.id;
                byId.set(toolCall.id, block);
              }
              if (!block.name && toolCall.function?.name) block.name = toolCall.function.name;
              let argsDelta = "";
              if (toolCall.function?.arguments) {
                argsDelta = toolCall.function.arguments;
                block.partialArgs = (block.partialArgs ?? "") + argsDelta;
                block.arguments = parseStreamingJson(block.partialArgs);
              }
              out.push({ type: "toolcall_delta", contentIndex: indexOf(block), delta: argsDelta, partial: output });
            }
          }
          if (Array.isArray(delta.reasoning_details)) {
            for (const detail of delta.reasoning_details) {
              if (!isOpenAIReasoningDetail(detail)) continue;
              ensureThinkingBlock("");
              streamedReasoningDetails ??= [];
              appendOpenAIReasoningDetail(streamedReasoningDetails, detail);
            }
          }
        }
        for (const block of blocks) finishBlock(block);
        if (options?.signal?.aborted) throw new Error("Request was aborted");
        if (output.stopReason === "aborted") throw new Error("Request was aborted");
        if (!hasFinishReason && !compat.supportsFinishReason) output.stopReason = output.content.some((b) => b.type === "toolCall") ? "toolUse" : "stop";
        if (output.stopReason === "error") throw new Error(output.errorMessage || "Provider returned an error stop reason");
        if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === "pending") throw new Error("Stream ended without finish_reason");
        out.push({ type: "done", reason: output.stopReason, message: output });
        out.end();
      } catch (error) {
        for (const block of output.content) {
          if (block.type === "thinking") applyStreamedReasoningDetails(block);
          delete block.index;
          delete block.partialArgs;
          delete block.streamIndex;
        }
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = formatProviderError(normalizeProviderError(error), errorPrefix(model));
        const rawMetadata = error?.error?.metadata?.raw;
        if (rawMetadata && !output.errorMessage.includes(String(rawMetadata))) output.errorMessage += `\n${rawMetadata}`;
        out.push({ type: "error", reason: output.stopReason, error: output });
        out.end();
      } finally {
        finished();
      }
    })();
    return out;
  }

  function streamSimple(model, context, options) {
    const reasoning = options?.reasoning ? effectiveThinking(model, options.reasoning) : undefined;
    return stream(model, context, {
      temperature: options?.temperature,
      samplingParams: resolveSamplingParams(model, options?.reasoning ?? "off", options?.samplingParams),
      maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
      signal: options?.signal,
      apiKey: options?.apiKey,
      resolveApiKey: options?.resolveApiKey,
      fetch: options?.fetch,
      cacheRetention: options?.cacheRetention,
      sessionId: options?.sessionId,
      headers: options?.headers,
      onPayload: options?.onPayload,
      onResponse: options?.onResponse,
      onProviderStreamEvent: options?.onProviderStreamEvent,
      timeoutMs: options?.timeoutMs,
      maxRetries: options?.maxRetries,
      maxRetryDelayMs: options?.maxRetryDelayMs,
      env: options?.env,
      toolChoice: options?.toolChoice,
      reasoningEffort: reasoning === "off" ? undefined : reasoning
    });
  }

  return Object.freeze({ stream, streamSimple, convertMessages, convertTools, buildParams, parseChunkUsage, mapStopReason, getCompat });
}
