# Browser networking acceptance checklist

Work in progress; this checklist is not a claim of test success.

## Target
A static browser app, no browser extension, Node server, or user-deployed forwarding proxy. Public Tor bridges/exits remain external infrastructure. Node is permitted only for development tests.

## Parallel ownership
- tor-wasm: libs/cors-rot/vendor/webtor, pinned upstream patch/build script, live WASM smoke tests.
- browser-network: libs/cors-rot (network.js, http-stream.js), parser/routing tests under libs/cors-rot/tests.
- browser-git: browser-git.js, vendor/isomorphic-git, adapter tests.
- browser-integration: browser-host/console-worker/main, browser build, smoke page, README.
- tor-directory: snapshot fetch script and Tor directory cache (libs/cors-rot/tor-cache.js).

## Required verification before claiming completion
- Existing browser-edition filesystem, console, persistence, tool naming, revision tests pass.
- HTTP parsing tests cover chunk boundaries, content-length, EOF, no-body responses, interim status, trailers and malformed framing.
- Abort and timeout release streams, including pending reads; terminating console workers releases their requests.
- Independent simultaneous HTTP requests do not block one another.
- Redirects have a finite limit and strip credentials on cross-origin transitions; HTTPS never silently downgrades.
- Failed non-idempotent requests are not automatically replayed through another route.
- Only two transports exist (tailscale default, tor); there is no direct/auto route. Transport initialization is lazy; same-origin requests use the browser's fetch.
- Fresh bootstrap directory is served as static assets; expired snapshots rejected. Hash/timestamp checks do not substitute for Tor authority signatures.
- TLS tests reject wrong-host, expired and untrusted certificates. Inspect underlying implementation, not just a skip_verification=false flag.
- Public unauthenticated HTTP requests work through Tor and an IP-check endpoint reports IsTor=true.
- Streaming response observed before EOF, not just a buffered result with a stream wrapper.
- Git discovery and a real clone/pull tested. Push requires an explicitly authorized disposable remote; do not push into user repositories as an implicit test.
- Real browser smoke page tested separately from Node stand-ins. If unavailable, label browser behavior unverified.
- No API keys/OAuth tokens used until TLS/security review supports it. HTTP 401/400 only demonstrates reachability, not working sign-in/model access.

## Known uncertainties at resume
The prebuilt v0.5.7 worked for some small HTTP responses using Node browser stand-ins. Git discovery hung; chunked framing was only a hypothesis. Upstream cached-directory code skips time validation and appears to consume consensus without checking authority signatures. The WASM TLS implementation uses a custom subtle-tls crate and still needs review/negative tests. Raw stream exposure alone does not guarantee working git or streaming.
