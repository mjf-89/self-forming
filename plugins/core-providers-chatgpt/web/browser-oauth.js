// Browser callback adapter for the FIXED createChatGPTAuth controller.
// That controller still owns PKCE, state/nonce randomness, token exchange, refresh,
// and signed ID-token verification. No provider credentials or protocol are replaced.
// Pi 1.0.4 openai-chatgpt.ts uses this loopback URI and accepts a pasted full URL.
// There is no listener in a static browser page; never fetch the loopback callback.
export const CHATGPT_CALLBACK = "http://127.0.0.1:1455/auth/callback";
export const MAX_CALLBACK_LENGTH = 16 * 1024;
const MAX_RECORD = 64 * 1024;
const failure = (message) => Object.assign(new Error(message), { code: "AUTH_ERROR" });
const cancelled = () => Object.assign(new Error("ChatGPT sign-in cancelled."), { code: "AUTH_CANCELLED" });
const text = (v, max = 32768) => typeof v === "string" && v.length > 0 && v.length <= max;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function boundedUrl(input, max) {
  if (!text(input, max) || /[\s\\\u0000-\u001f\u007f]/.test(input) || /%(?![0-9a-f]{2})/i.test(input)) {
    throw failure("Paste the full, unmodified callback URL from the address bar.");
  }
  try { return new URL(input); } catch { throw failure("Paste the full callback URL from the address bar."); }
}

export function parseChatGPTCallback(input, expectedState) {
  // Do not normalize misleading hosts, paths, credentials, fragments, or duplicate fields.
  const url = boundedUrl(input, MAX_CALLBACK_LENGTH);
  if (!input.startsWith(`${CHATGPT_CALLBACK}?`) || url.origin !== "http://127.0.0.1:1455"
    || url.pathname !== "/auth/callback" || url.username || url.password || input.includes("#")) {
    throw failure("The callback must start with http://127.0.0.1:1455/auth/callback?.");
  }
  for (const key of ["state", "code", "client_id", "error"]) {
    if (url.searchParams.getAll(key).length > 1) throw failure("The callback contains repeated sign-in fields.");
  }
  if (!text(expectedState, 256) || url.searchParams.get("state") !== expectedState) {
    throw failure("This callback does not match the current sign-in. Use the latest sign-in tab.");
  }
  if (url.searchParams.has("error")) return { denied: true };
  if (!text(url.searchParams.get("code"), 8192) || /[^\x21-\x7e]/.test(url.searchParams.get("code"))) {
    throw failure("The callback has no valid authorization code.");
  }
  // The fixed controller additionally checks issued client ID / remembered account.
  const client = url.searchParams.get("client_id");
  if (client !== null && (!text(client, 1024) || /[^\x21-\x7e]/.test(client) || client === "dynamic_agent_client")) {
    throw failure("The callback has no valid registered client.");
  }
  // Keep only protocol fields. Error descriptions and arbitrary URL data never reach storage.
  const clean = new URL(CHATGPT_CALLBACK);
  for (const key of ["state", "code", "client_id"]) if (url.searchParams.has(key)) clean.searchParams.set(key, url.searchParams.get(key));
  return { url: clean.href };
}

/** Only the documented native auth record fields can enter browser storage. */
export function sanitizeChatGPTRecord(value) {
  if (value === null) return null;
  const invalid = () => { throw failure("Saved ChatGPT sign-in data is invalid. Sign out and try again."); };
  let size;
  try { size = new TextEncoder().encode(JSON.stringify(value)).length; } catch { return invalid(); }
  if (size > MAX_RECORD || !object(value) || value.version !== 1) return invalid();
  const result = { version: 1 };
  if (value.identity !== undefined) {
    const i = value.identity;
    if (!object(i) || i.issuer !== "https://auth.openai.com" || !text(i.subject, 1024)
      || !text(i.clientId, 1024) || i.clientId === "dynamic_agent_client"
      || (i.email !== undefined && !text(i.email, 320))) return invalid();
    result.identity = { issuer: i.issuer, subject: i.subject, clientId: i.clientId, ...(i.email !== undefined ? { email: i.email } : {}) };
  }
  if (value.tokens !== undefined) {
    const t = value.tokens;
    if (!result.identity || !object(t) || !text(t.access) || !text(t.refresh) || !text(t.idToken) || !text(t.nonce, 256)
      || !Number.isFinite(t.expires) || !Array.isArray(t.scopes) || !t.scopes.every(s => text(s, 256))
      || !t.scopes.includes("chatgpt.tokens.use.direct")) return invalid();
    result.tokens = { access: t.access, refresh: t.refresh, expires: t.expires, scopes: [...t.scopes], idToken: t.idToken, nonce: t.nonce };
  }
  return result;
}

export function loadChatGPTRecord(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    if (raw.length > MAX_RECORD) throw failure("");
    return sanitizeChatGPTRecord(JSON.parse(raw));
  } catch { throw failure("Saved ChatGPT sign-in data is invalid. Sign out and try again."); }
}

export function createBrowserOAuth({ crypto = globalThis.crypto, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 5 * 60 * 1000 } = {}) {
  let active;
  const observers = new Set();
  const snapshot = () => Object.freeze(active ? { pending: true, awaitingPaste: !active.used && Boolean(active.url), url: active.url } : { pending: false, awaitingPaste: false });
  const publish = () => { for (const observer of observers) { try { observer(snapshot()); } catch { /* UI cannot own auth. */ } } };
  const finish = (error) => {
    if (!active) return;
    const old = active;
    active = undefined;
    clearTimer(old.timer);
    old.url = undefined; old.state = undefined;
    old.reject(error);
    publish();
  };
  const current = (id) => {
    if (active && now() >= active.deadline) finish(failure("ChatGPT sign-in timed out. Start again."));
    if (!active || active.id !== id) throw failure("This sign-in is no longer pending. Start again.");
    return active;
  };
  const methods = {
    "auth.listen"({ state }) {
      if (!text(state, 256) || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw failure("Invalid sign-in state.");
      if (active) throw failure("A ChatGPT sign-in is already pending.");
      let resolve, reject;
      const result = new Promise((yes, no) => { resolve = yes; reject = no; });
      void result.catch(() => {}); // cancellation can precede auth.wait
      active = { id: crypto.randomUUID(), state, result, resolve, reject, used: false, waited: false, deadline: now() + timeoutMs };
      active.timer = setTimer(() => finish(failure("ChatGPT sign-in timed out. Start again.")), timeoutMs);
      publish();
      return { attemptId: active.id, redirectUri: CHATGPT_CALLBACK };
    },
    "auth.open"({ attemptId, url }) {
      const attempt = current(attemptId);
      if (attempt.url || attempt.used) throw failure("The sign-in page was already prepared.");
      const parsed = boundedUrl(url, 32768);
      if (parsed.origin !== "https://auth.openai.com" || parsed.pathname !== "/api/accounts/authorize"
        || parsed.username || parsed.password || parsed.hash
        || parsed.searchParams.getAll("redirect_uri").length !== 1 || parsed.searchParams.get("redirect_uri") !== CHATGPT_CALLBACK
        || parsed.searchParams.getAll("state").length !== 1 || parsed.searchParams.get("state") !== attempt.state) {
        throw failure("Invalid ChatGPT sign-in page.");
      }
      // A real link in Settings provides an explicit user gesture, even if popups are blocked.
      attempt.url = parsed.href;
      publish();
    },
    "auth.wait"({ attemptId }) {
      const attempt = current(attemptId);
      if (attempt.waited) throw failure("This callback has already been claimed.");
      attempt.waited = true;
      return attempt.result;
    },
    "auth.cancel"({ attemptId } = {}) { if (active?.id === attemptId) finish(cancelled()); },
  };
  return {
    methods,
    subscribe(observer) { observers.add(observer); observer(snapshot()); return () => observers.delete(observer); },
    submit(input) {
      const attempt = current(active?.id);
      if (attempt.used || !attempt.url) throw failure("This sign-in is not waiting for a callback.");
      const returned = parseChatGPTCallback(input, attempt.state);
      if (returned.denied) { finish(failure("ChatGPT sign-in was not approved. Start again.")); return; }
      attempt.used = true;
      attempt.state = undefined;
      attempt.url = undefined;
      attempt.resolve(returned);
      publish();
    },
    dispose() { finish(cancelled()); observers.clear(); },
  };
}

/** Browser-only Settings UI. Shared Android markup and auth behavior stay untouched. */
export function mountBrowserOAuth(oauth, document = globalThis.document) {
  const account = document.getElementById("chatgpt-account");
  if (!account) return;
  const container = document.createElement("div");
  container.innerHTML = `<p class="settings-note">Access and refresh tokens are stored in this browser's local storage, like other browser credentials in this app—not in a secure vault.</p>
    <p class="settings-note">Browser CORS rules can block OpenAI's required identity checks even when the token exchange works. No credentials are saved if those checks fail. These checks go through the selected network route (Tailscale or Tor). Model access is a separate check.</p>
    <div hidden data-pending>
      <p class="settings-note" role="status" data-status></p>
      <a class="auth-link" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" data-open>Open ChatGPT sign-in in a new tab</a>
      <form class="key-settings" autocomplete="off">
        <label>Full callback URL<input type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="16384" placeholder="http://127.0.0.1:1455/auth/callback?…" /></label>
        <button class="login-button" type="submit">Finish sign-in</button>
        <p class="settings-note" role="alert" data-error></p>
      </form>
    </div>`;
  account.append(container);
  const pending = container.querySelector("[data-pending]");
  const status = container.querySelector("[data-status]");
  const link = container.querySelector("[data-open]");
  const form = container.querySelector("form");
  const input = container.querySelector("input");
  const error = container.querySelector("[data-error]");
  oauth.subscribe(state => {
    pending.hidden = !state.pending;
    form.hidden = !state.awaitingPaste;
    link.hidden = !state.url;
    if (state.url) link.href = state.url; else link.removeAttribute("href");
    status.textContent = state.awaitingPaste
      ? "Open the sign-in tab and approve access. The final localhost page may fail to load; copy its entire address and paste it below, never in chat. This attempt expires after five minutes."
      : "Completing sign-in… Keep this page open. OpenAI must allow the token and identity checks from this browser.";
    if (!state.awaitingPaste) { input.value = ""; error.textContent = ""; }
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const value = input.value;
    input.value = "";
    error.textContent = "";
    try { oauth.submit(value); } catch (cause) { error.textContent = cause.message; }
  });
}
