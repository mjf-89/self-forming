# Model access

OpenAI API-key, ChatGPT subscription and Claude subscription requests use native HTTP on Android. The same transport handles model discovery, authentication and inference. Pi AI handles provider protocols and SSE events in JavaScript; upstream packages and global fetch remain unchanged. The application passes a Fetch-compatible adapter to Pi and its authentication controllers.

The transport imposes no total request or response body limit. Request bytes cross the bridge in acknowledged chunks of at most 64 KiB and are staged in a private temporary file. Kotlin sends that file with a 64-bit Content-Length. Response bytes are read only when JavaScript asks for the next chunk. The 4 MiB bridge-envelope limit applies to individual messages, not complete HTTP bodies. Available disk space, memory used by Pi/the provider SDK, and provider limits still apply.

Cancellation, page teardown and bridge reset close native connections and release temporary uploads. A slow JavaScript consumer does not accumulate a queue of native stream events. Errors expose a short credential-redacted provider explanation; the 32 KiB diagnostic JSON read bound is separate from HTTP transport and does not truncate successful responses or impose a model-body limit.

The development app supplies the same chunked protocol through its local host. A standalone browser-library consumer can still use ordinary browser fetch or supply its own transport; native adapters remain outside the upstream browser archive.

## Sign in

ChatGPT retains its existing external-browser callback flow and saved credentials. Claude uses the same PKCE copy-code protocol as upstream Pi's Claude Code subscription login. Select Continue with Claude, authorize in the external browser, then paste the displayed code into the app. Cancel discards the pending attempt. Sign out clears only the selected provider's saved credentials. Token refresh is serialized and happens before model requests as needed.

The former bounded `auth.request` operation is replaced by the same streaming native HTTP transport used for models. Native policy permits only the supported OpenAI/Anthropic model endpoints and the five exact discovery, JWKS, token and revocation URLs needed by the sign-in flows. Redirects are rejected. HTTP framing, browser-origin headers and cookies are not forwarded; provider authorization, beta headers and upstream User-Agent are preserved. Browser-only direct-access opt-in headers are omitted because the HTTP client is native.

Native credentials remain encrypted at rest and separate for each provider. Local developments keep them in process memory. No credentials are copied into model preferences, conversation documents, drafts or service-secret environment variables.

“Connected” means that credentials were saved or restored; it does not verify inference access. ChatGPT loads its account-specific model list over the network. Loading failures and Refresh status appear directly in Settings. Claude's list comes from the bundled catalog, so seeing a model there does not establish that the account can use it.

## Thinking effort

Settings shows supported effort levels for the selected model, obtained from Pi AI's catalog. Models without reasoning have no effort control; unsupported levels are rejected before sending. The default is explicitly labeled: off if supported, otherwise the lowest supported effort. It never silently carries over another model's setting.

Before admitting a new message, the app saves the selected `thinkingLevel` through the upstream conversation configuration. A fork inherits it; reopening and resuming a pending generation retain the checkpoint's original effort even if the UI preference has since changed.

## Why native HTTP

Version 0.9.0 moved model requests into browser fetch. A phone then received Anthropic's explicit organization-level denial of CORS requests. The bundled model list did not verify inference access, and unauthenticated endpoint probes could not establish browser access for the signed-in account. Version 0.9.2 therefore uses native HTTP for all supported providers, including the ChatGPT model list.

An Android check against an earlier build confirmed that a dummy-token model-list request passed MainActivity's endpoint gate and returned a readable 401. That result was useful for excluding the proposed missing-Origin failure on the tested WebView, but it did not establish authenticated access.

Native transport removes dependence on browser CORS and preserves provider headers that Chromium may replace. Account entitlement, token validity and provider-side restrictions still require verification with the user's account. No real account credentials or paid inference are used in local or CI checks.
