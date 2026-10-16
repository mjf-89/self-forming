# Follow-up remediation after independent review

Date: 2026-10-13. **Release gate remains closed. No credentials used.** This supersedes the initial recovery's security/coverage statements where they differ.

## 1. Authenticated lifetime and refresh — remediated for new circuit selection

- `RelayManager` now retains the authenticated `Lifetime`. Every candidate selection calls `ensure_current()`. Circuit creation checks before creating a tunnel and again after extension/before publication. Expiry is exclusive at `valid-until`; unknown lifetime also fails closed. An unauthenticated legacy `update_relays` invalidates lifetime instead of inheriting trust.
- Directory installation is atomic only after signature, lifetime and complete-descriptor checks. It rechecks time after downloading/processing and refuses a lower `valid-after` than the already installed directory.
- `needs_consensus_refresh` reports the signed `fresh-until` boundary instead of always returning false.
- WASM connect/wait/update paths attempt an on-demand refresh of the configured snapshot after freshness expires. Refresh is serialized per directory, retry-spaced by 30 seconds, bounded by a 30-second deadline, and globally limited to two concurrent directory loads. A failed refresh permits the previous directory **only before its signed expiry**. No expired selection fallback.
- This is on-demand refresh, not autonomous snapshot publication. The separate directory agent still owns keeping served snapshots current. Device wall-clock trust and long-running existing circuits are not solved by this change.

Primary code: `webtor/src/relay.rs` (`ensure_current`, `install_directory`), `directory.rs` (`process_consensus_data`, `needs_refresh`, `DirectoryBudget`), `circuit.rs` (`create_circuit_with_isolation`), `client.rs` (`refresh_if_needed`).

## 2. Descriptor/source-order selection bias — remediated

- Strict coverage policy: all distinct microdescriptor digests named by the signed consensus must be supplied. Missing/unknown/malformed documents reject the directory. Identical repeated documents are deduplicated by digest; they cannot create extra candidates. Repeated RSA/usable Ed25519 identities reject the directory.
- Candidate construction iterates the signed consensus and canonicalizes by authenticated RSA identity, not descriptor-source order. Signed `NoEdConsensus` exclusion is deterministic; coverage is still required for those descriptors.
- Signed bandwidth is populated. Middle/exit/guard role weights are derived with an adaptation of the pinned Arti `tor-netdir/src/weight.rs` algorithm, including measured/unmeasured policy, role/scarcity factors and overflow shift. Only interface adaptations are used (`relays()` and consensus scale lookup instead of full `NetDir`/`NetParameters`). Arti licenses/provenance retained.
- Removed top-ten truncation. CSPRNG-backed `choose_weighted` samples the entire eligible pool; `max_selection` is now only a legacy display hint, never a security-sensitive shortlist.
- This is **not the full Arti path-selection/guard-management implementation**. Existing family/subnet separation, exit-policy selection, persistent guards, isolation policy and anonymity properties still require independent review.

Tests: reverse descriptor order and ten duplicate descriptors produce identical candidate weights and seeded draws; single omission and repeated tiny subset fail; draws reach beyond ten candidates; signed-weight frequency is checked against a heavy-weight group rather than uniform selection. Expiring an already-loaded directory rejects both sampling and a new circuit attempt.

## 3. Resource bounds and cancellation — substantive remediation, not a complete DoS audit

Implemented limits:

| Boundary | Policy |
|---|---|
| WASM directory fetch | Streaming reads, no arrayBuffer fallback; compressed consensus/descriptors <=8 MiB each, certificates <=1 MiB; <=16,384 chunks including empty chunks; 30-second abort deadline; omit credentials, reject redirects |
| Brotli | <=32 MiB decompressed data |
| Bridge directory response | <=16 MiB response, <=64 KiB headers; microdescriptor aggregate <=32 MiB |
| Directory work | At most two concurrent loads globally; refresh serialized per directory |
| WebSocket | At most 16 live/opening sockets per WASM module; reject nonbinary frames; <=256 KiB per message; <=1 MiB/256 queued frames, plus the current <=256 KiB frame; overrun closes the socket |
| WebSocket writes | Respect bufferedAmount <=256 KiB, <=64 KiB per send, timer-based drain polling, cancellable flush |
| JS stream writes | Check Uint8Array length before copying; <=256 KiB per write and aggregate queued bytes; at most four outstanding writes |
| JS stream reads | At most four outstanding reads, <=64 KiB per returned chunk |
| Client streams | At most 16 live/pending stream opens per client |
| Circuits | At most two concurrent builders, 16 managed circuits; closed managers reject publication/new builds |
| KCP | <=1 MiB output collector and <=1 MiB pending output; refuse send saturation at 512 outstanding segments (a single bounded accepted write can add more); <=64 KiB accepted per call |
| Turbo/SMUX | Bounded per-write framed output; pending/partial bytes retained, not replayed or discarded; SMUX refuses exhausted peer windows and caps control backlog |

- Fetch cancellation drops an AbortController guard, aborting the actual request and cancelling its reader.
- A WebSocket owner is now constructed **before** awaiting open. Cancelling pre-open detaches all handlers before dropping their Rust closures and releases its socket reservation.
- Stream drop/close cancels pending IO. Clients retain weak ownership of streams and close them immediately on `client.close()`; native close cancels in-flight operations, terminates the channel and **all** circuits, rather than merely removing idle ones. In-flight builders cannot publish into a closed manager.
- The KCP/Turbo/SMUX partial-write path needed repair once WebSocket backpressure became real: already accepted bytes are now retained and reported accepted, never enqueued twice on `Pending`.
- WebRTC is **unavailable through TorClient** until the separate unbounded DataChannel path is reviewed. This is a deliberate compatibility restriction, not a claim that the old WebRTC implementation was hardened.

Residual limitations:

- The browser may allocate/reassemble an oversized WebSocket message before invoking our handler. The WebSocket API offers no receive-side backpressure; our limits prevent copying/queuing it in WASM but cannot bound browser-internal allocation.
- These are local queue/document caps, **not a measured global browser heap limit**. Parsing/decompression/copies and multiple streams consume additional bounded or library-managed memory.
- Arti's existing `MemoryQuotaTracker::new_noop()` has not been replaced with end-to-end memory accounting. Full KCP/SMUX congestion, retransmission, peer-flood/CPU behavior, reactor fairness and hostile browser behavior are not exhaustively audited. Saturation may intentionally fail a connection rather than recover it.
- Alternate internal Rust transport entrypoints and legacy HTTP APIs are not all covered by the Node stream harness. Native-target tests were not run.

## 4. Trust regression tests — expanded

The test-feature build has a root-injection hook solely for generated test CA material. It uses the **same** rustls/webpki connector configuration and checks, not an accept-any verifier. No hook, custom-root setting or test root is exported by the production build; tests and the build script assert this.

Passing cases now include:

- Valid trusted CA-signed TLS leaf succeeds.
- The same trusted chain fails for wrong hostname, expired leaf and not-yet-valid leaf.
- Unknown-root and TLS1.2-only endpoints fail as before.
- Authority certification signature changed while preserving valid base64 fails signature checking.
- Cryptographically signed but expired pinned authority certificate fails validity.
- A cryptographically valid/current test authority certificate with an unpinned identity fails the pin check.
- Insufficient, duplicate and tampered consensus signatures still fail.
- Live public-only Tor probe rejects an intentionally wrong bridge identity at Arti's handshake identity check. A separately forged CERTS/TLS-certificate-binding fixture was **not** built; do not claim that additional negative case is independently tested.

## Verification and delivery

- Reviewed-source production and test-feature release builds pass using the existing Rust nightly/clang/wasm-bindgen tools. No installations or background servers.
- **33 Node18/ws fixture checks passed** after the final source build, including exact Turbo/SMUX/KCP output under repeated `Pending`/short writes.
- The final bounded live Node/ws probe passed: wrong bridge identity rejected; authenticated directory and Tor circuit; a pending raw read while a second TLS1.3 stream exchanges public HTTP with example.com; raw HTTP response; client-close cancellation of a further pending stream; underlying WebSocket close observed.
- No real credentials or OAuth endpoints. No actual browser/WebView validation.
- Log: `workspace/build/webtor-rs/hardening-smoke-live-test.log`.
- Updated complete patch: `browser-streams-security.patch`. The prior first-recovery patch is preserved as `recovery-before-hardening.patch`; it is historical, not an additional patch to apply.
- Production artifacts and hashes: `vendor/webtor/BUILD.txt`. **New generated `snippets/` directory is required by the JS glue**; integration must copy the whole production directory, not just `.js`/`.wasm`.
- Neither loader/snapshot integration nor application security gates were edited here. Re-copy/rebuild deployment from these artifacts only after main-agent review; retain all gates false.

## 5. Second review follow-up (main agent, 2026-10-13)

An independent re-review confirmed sections 1, 2 and 4 and the cancellation/close/socket/stream/circuit rows of section 3. It found that the "bridge directory response" row overstated the microdescriptor path. Fixed in the patch (hash in `vendor/webtor/BUILD.txt`):

- `directory.rs` microdescriptor chunk reads are now bounded with `take()` to 32 MiB / 3 per response (MAX_PARALLEL_CHUNKS = 3 are buffered at once), reject oversized and header-less responses, and keep the 32 MiB aggregate check. This path is only reachable through `TorClient::bootstrap()` / `refresh_consensus()`, which no wasm binding calls today.
- `snowflake_broker.rs` `array_buffer()` remains unbounded and is now marked in code; it is dead while TorClient refuses WebRTC on wasm. Bound it before re-enabling WebRTC.
- Legacy `http.rs` request path now fails with an error above 1 MiB instead of silently truncating.
- Test-hook exclusion is now an exact allowlist: `third-party/webtor-rs/production-exports.js.txt` and `.wasm.txt` are compared by `scripts/build-webtor-wasm.sh` (JS glue and wasm export table) and by the smoke harness (module keys). Any new export fails the build until reviewed.
- JS side: `apps/browser/browser-http-stream.js` writes request head and body in 64 KiB pieces (the Tor stream accepts at most 256 KiB per write); regression test with a 3 MiB body.

Verified after rebuild: production + smoke builds, 33 Node18/ws fixture checks, 27 network tests. A real headless Chromium 131 run (tests/browser-tor-real.*) passed bootstrap, IsTor, example.com and GitHub git discovery on the previous build. Remaining inherent limits are unchanged (no family/subnet/exit-policy path rules, no persistent guards, browser-internal WebSocket allocation, no-op memory quota, KCP/SMUX flood behaviour not audited).

## 6. Circuit/stream reliability investigation (tor-reliability subagent, 2026-10-13)

Scope: the intermittent failures seen in real headless Chromium runs with many
requests on **one** `TorClient` (`Failed to extend to middle/exit: Circuit
closed`, `Circuit creation failed: Circuit build capacity reached`,
`begin_stream timed out`, `TLS handshake eof`, `END cell CONNRESET`,
RESOLVEFAILED, and runs where the client stayed unusable for 100 s+ while
`getCircuitStatusString()` still said `Ready`). Release gate unchanged, no
credentials, no security property weakened; all limits below are unchanged or
tightened. Verified the tracked diff equalled `browser-streams-security.patch`
before starting.

### Root causes found (line numbers are the patched tree after this change)

1. **No periodic KCP timer — the real cause of the "wedged but Ready" runs.**
   `webtor/src/kcp_stream.rs` only called `Kcp::update()` when the application
   wrote or when the transport happened to deliver bytes. KCP is a timer
   protocol: `update()` is what retransmits unacknowledged segments. With the
   peer idle (only ~2.5 s SMUX keepalives arriving), a single lost Snowflake
   segment was retransmitted at keepalive rate with KCP's RTO doubling each
   time, so outbound cells stopped being delivered while inbound traffic kept
   flowing. `tor_proto` saw an open channel, every circuit stayed "Ready", and
   every new RELAY_BEGIN *and* every new CREATE_FAST timed out.
   Reproduced deterministically in the live probe: 20 sequential TLS streams
   succeeded, then 3 concurrent ones all timed out at 45 s, the trace showing
   the three BEGIN cells sent and the same KCP segments retransmitted without
   ACK (`reliability-stall-trace.log`, `reliability-live-before-kcp-timer.log`).
   Fix: `drive_kcp_timer()` + self-wake (`arm_timer_wake`) in
   `kcp_stream.rs:35,379,412`, driven from `poll_read`/`poll_write`; at most one
   wake in flight, 10-100 ms, no busy loop, stream stays `Send`.
2. **Dead circuits stayed `Ready`, were selected for new streams and were
   reported healthy.** Nothing ever marked a circuit failed when its reactor
   died, and `cleanup_circuits()` was never called by anything. `is_ready()`
   was the only selection/reporting predicate (`circuit.rs` selection paths and
   `get_circuit_status`). Fix: `Circuit::tunnel_is_dead`/`is_usable`/
   `mark_failed` (`circuit.rs:112,121,128`), `sweep_dead_circuits()`
   (`circuit.rs:769`) called from every selection path, from
   `get_circuit_status` and before the capacity check.
3. **Circuit-capacity accounting counted dead circuits.** The 16-circuit check
   used the raw list length, so failed circuits (which were never removed)
   permanently produced `Circuit capacity reached` (`circuit.rs:300-307` now
   sweeps first).
4. **Builder slots failed fast instead of waiting.** `try_acquire()` on the
   2-permit semaphore turned a busy moment into a hard
   `Circuit build capacity reached` error. The permit itself was correctly
   scoped (no leak found), but the policy was wrong: now a bounded 30 s wait
   (`circuit.rs:227,297`), re-checking the closed flag after acquisition.
5. **No retry on another path when a hop refuses.** A single DESTROY
   (`CONNECTFAILED`) from one unreachable middle relay failed the whole client
   (observed at `TorClient::new`). Fix: up to 3 build attempts with a fresh
   middle/exit each, 20 s per attempt, retry only for path-level failures
   (`circuit.rs:229-245,319`). Extension/tunnel errors are now
   `CircuitExtension`/`CircuitCreation` instead of `Internal`, so
   `is_retryable()` and the JS error surface classify them correctly.
6. **Half-built tunnels leaked on failure paths.** Relay selection happened
   after the tunnel was created and the relay-manager lock was held across
   extension awaits; errors returned without terminating the tunnel. Both hops
   are now selected before any IO, and every extension failure calls
   `tunnel.terminate()` (`circuit.rs:398-565`).
7. **Bridge-channel death/stall was not detected.** The stored channel was used
   forever; nothing checked `Channel::is_closing()` and nothing rebuilt it.
   Fix: `invalidate_channel` (`circuit.rs:797`), `ensure_channel`/
   `channel_is_live` before every connect attempt (`client.rs:441,466`), and
   `note_channel_failure` (`client.rs:408`) which replaces the channel after 2
   suspicion points (an unanswered stream scores 1, an unanswered circuit build
   scores 2) and drops all circuits riding on it. Replacement is serialized and
   pointer-checked so concurrent streams share one reconnect.
8. **Timeouts too long.** `connect_stream` used `timeout/2` per attempt (45 s of
   a 90 s budget) and 2 attempts. Now: 10 s per `begin_stream`, 14 s per circuit
   acquisition, 3 attempts, overall still bounded by the caller's budget
   (`client.rs:57,59,289`). TLS handshakes get 25 s per attempt with one retry
   on a new circuit (`webtor-wasm/src/lib.rs:228-230,500-545`) — safe because no
   application data exists at handshake time.
9. **Stream-slot accounting only released on `close()`.** A stream that *errored*
   (END/CONNRESET, oversized frame, TLS failure) kept one of the 16 per-client
   slots until JS explicitly closed or freed it. Terminal read/write errors now
   mark the stream closed and cancel the other half
   (`webtor-wasm/src/lib.rs:1284,1336`), and `connect`/`connectTls` re-prune the
   list before registering a new stream.
10. **Exit selection ignored the signed exit policy.** Exits that reject the
    target port were chosen freely, producing END (EXITPOLICY/CONNREFUSED) and
    RESOLVEFAILED. The microdescriptor `p` summary is now retained per relay
    (`directory.rs:626,649` using Arti's own `PortRange` parser),
    `RelayCriteria::with_port` filters candidates (`relay.rs:79,172,222,273`),
    circuit creation prefers a policy-covering exit (`circuit.rs:439`, falling
    back to the unconstrained pool only if no exit advertises the port, with a
    warning), and circuit reuse requires the exit to cover the port
    (`circuit.rs:135,644`). `allows_port()` is false for unknown policy, so a
    legacy relay list cannot satisfy a port-constrained draw. This is a
    *preference*, not a trust decision: weights, quorum, lifetime and coverage
    checks are untouched.
11. `webtor/src/http.rs` (legacy `fetch`/`post`) now also uses the port-aware
    circuit and retries RELAY_BEGIN once on a fresh circuit before any request
    bytes are written.

### Tests

`tests/browser-tor-wasm.smoke.mjs` now runs **37** fixture checks (the previous
33 all still pass, unchanged). New, all test-feature hooks only:

- *signed exit policy summary is parsed per relay and constrains exit draws* —
  cross-checks every relay's parsed ranges against the fixture `p` lines
  (digest-matched), asserts 48 seeded exit draws for ports 443/80 all accept the
  port, and that a port no fixture exit accepts fails selection.
- *circuit builder slots are released on every failure path* — 6 sequential plus
  4 concurrent builds on one manager; all must fail with `Channel not
  established` and never with a capacity error.
- *stream slot is released when a stream errors instead of being closed* — new
  `smokeStreamSlots` hook; an oversized-frame read error must return the slot.
- *dead Ready circuit is neither reported ready nor reused, and connect fails
  fast* — new `smokeInsertDeadCircuit`/`smokeCircuitIds` hooks: status is `None`
  (not `Ready`), the dead circuit is retired, and `connect` with a 2 s budget
  returns in well under 6 s without a capacity error.

New test hooks are gated behind `recovery-smoke` (now also a feature of the
`webtor` crate, enabled by `webtor-wasm/recovery-smoke`). **Production exports
are unchanged**: `scripts/build-webtor-wasm.sh` compared the production JS glue
and wasm export table against `third-party/webtor-rs/production-exports.*.txt`
and the harness compared the module keys — no allowlist edit was needed.

### Live probe

`node tests/browser-tor-wasm.smoke.mjs --tor` now ends with a load probe on
**one** client: `WEBTOR_PROBE_SEQUENTIAL` (default 20) sequential plus
`WEBTOR_PROBE_CONCURRENT` (default 3) concurrent TLS 1.3 streams to
example.com:443, each doing a public HTTP GET, printing per-stream outcome,
success rate, min/median/p95/max and the circuit status afterwards. It fails the
run only if sequential success drops below 80 % or all concurrent streams fail.

Results with the published artifacts (public traffic only, logs in
`workspace/build/webtor-rs/reliability-live-*.log`):

| Run | Sequential | Concurrent | Status after |
|---|---|---|---|
| before the KCP timer fix | 20/20 (median 863 ms) | **0/3**, all `connect_stream timed out after 45 s` | `None` |
| run 1 | 20/20 (median 1721 ms) | 3/3 (5.9-6.6 s) | `Ready` |
| run 2 | 20/20 (median 877 ms) | 3/3 (2.9-3.1 s) | `Ready` |
| run 3 (40+5) | 40/40 (median 2072 ms) | 5/5 (4.3-5.0 s) | `Ready` |
| final (published build) | 20/20 (median 950 ms) | 3/3 (4.8-6.7 s) | `Ready` |

The pre-existing live checks (wrong bridge identity rejected, authenticated
directory, simultaneous raw + TLS streams, client-close cancellation) still
pass. Snapshot refreshed with `scripts/fetch-tor-directory.sh`
(`validUntil 2026-10-13T16:00:00Z`) — refresh again before re-running `--tor`.

### What remains flaky / not covered

- The concurrent-stream latency is still 3-7 s versus ~1 s sequential, and the
  first stream after a burst is sometimes slow. The KCP timer fixed the stall,
  it did not tune congestion/retransmission; KCP/SMUX flood and fairness
  behaviour is still unaudited.
- The channel-stall *recovery* path (suspicion counter → channel replacement) is
  logic-reviewed and reachable, but no automated test forces a wedged-yet-open
  transport; the live evidence only shows that the stall no longer occurs. If a
  stall does happen, recovery needs roughly 25-40 s, which fits a 90 s caller
  budget but not a 45 s one.
- Exit-policy handling uses only the microdescriptor summary (IPv4, "most
  addresses"), so exit rejections are reduced, not eliminated. No family/subnet
  separation, no persistent guards, no full Arti path selection.
- `MAX_CIRCUITS_PER_ISOLATION_KEY` is still 1, so all streams of one first-party
  share a circuit (Tor-Browser-like). A bad exit now retires the circuit on the
  first failure instead of being reused, but in-flight streams on that circuit
  are not migrated.
- `cleanup_circuits()` (age/idle rotation) is still not wired to any caller; only
  dead/failed circuits are swept. No `MaxCircuitDirtiness`-style rotation.
- Native `cargo test` was not run (wasm32 check/build only); the new
  `relay::tests::test_exit_port_policy_filter` unit test is therefore compiled
  but unexecuted. No browser/WebView run was performed here — the Chromium
  scenario that produced the original symptoms still has to be repeated by the
  main agent.
- Artifacts: patch regenerated (`git diff --binary HEAD`), production and smoke
  builds rebuilt from it, `vendor/webtor` copied whole to
  `apps/browser/vendor/webtor` (identical trees). No other app file touched.

## 7. Upload truncation and idle-stream teardown (tor-reliability subagent, 2026-10-13)

Scope: two regressions reported from real use on the production page with
`Network = Always Tor`. (a) **Uploads were broken**: a POST to
`https://api.openai.com/v1/responses` with a dummy bearer answered 401 in under
a second for a ~100 B body, but failed with `END cell CONNRESET` after 26-41 s
for 10 KB / 60 KB / 150 KB and with `write failed: Circuit closed` after ~42 s
for 400 KB / 1 MB, while an 11 MB **download** was fine. (b) A streaming SSE
response died mid-answer during a quiet period with
`Stream protocol violation: stream channel disappeared without END cell?`.
Verified the tracked diff equalled `browser-streams-security.patch`
(`a00292938ab4…`) before starting. Release gate unchanged; no credentials (the
bearer is the literal string `dummy-not-a-credential`); no security property
weakened.

### Root cause (a): KCP datagram boundaries were destroyed — `webtor/src/kcp_stream.rs`

`Kcp` calls `Write::write` **once per datagram** (each at most one MTU, with
whole segments already packed into it). The old `OutputBuffer` appended every
datagram into a single `Vec<u8>` and `poll_output` handed that whole buffer to
one `transport.poll_write`, which became **one Turbo frame / one WebSocket
message**. The Snowflake bridge's `turbotunnel` packet conn treats each message
as one packet and drops anything larger than ~1500 bytes, so every upload
bigger than one MTU was silently discarded by the bridge and retransmitted
forever. Downloads were unaffected because the bridge sends one datagram per
message.

Trace evidence (`workspace/build/webtor-rs/reliability-upload-trace-before-fix.log`),
10 KB body: `ws send n=11019` once, then the same payload again at +0.6 s,
`n=9619` at +1.6 s, `n=8219` at +3.6 s, `n=6818` at +7.6 s (progress only when a
flush happened to emit a single segment), no ACK for the rest, server RST at
16 s → `END CONNRESET`. The same mechanism explains the 2026-10-13 §6
"3 concurrent streams stall" case: three RELAY_BEGIN cells were concatenated
into one 1644-byte packet.

Fixes:

- `kcp_stream.rs:124-180` — the collector keeps **one `Vec` per datagram**
  (`VecDeque<Vec<u8>>`), with the previous 1 MiB cap preserved.
- `kcp_stream.rs:556` `poll_output` — writes **one datagram per `poll_write`**,
  so each becomes one Turbo frame / one WebSocket message; unaccepted packets
  are retained in order, and a (never-observed) partial accept keeps the tail as
  its own packet instead of merging or dropping it. The async `flush_output`
  path (`:285`) does the same.
- `kcp_stream.rs:42,544,602` — a full KCP send queue (`wait_snd >= 512`) now
  returns `Poll::Pending` with a stored waker, woken from the ACK/input/timer
  path, instead of returning an error. The error aborted the channel write,
  which killed the shared bridge channel and with it every circuit — that is
  the `write failed: Circuit closed` at 400 KB+.
- `kcp_stream.rs:624-636` — if the transport could not take everything,
  `poll_write` now wakes the **read-side** waker (the channel reactor's), so the
  timer path drains the remaining datagrams. Previously accepted bytes could sit
  unsent until the next application write, which truncated requests whose last
  pieces never left the client.
- `smux.rs:222` — `can_send` uses `wrapping_sub` to match the `wrapping_add` on
  `self_write` (`saturating_sub` reported "nothing in flight" after a 2^32 wrap).
- `smux.rs:696` `poll_write` — an exhausted peer window is now
  `Poll::Pending` + stored waker, woken when a UPD frame advances the peer's
  consumed counter (both UPD handlers, `smux.rs:470` and `:620`). The previous
  hard error ("SMUX peer window exhausted") tore down the channel as soon as an
  upload filled the peer's receive buffer.

### Root cause (b): retirement and channel replacement killed live streams

Measured first: with no streams open, the bridge channel survives **150 s** of
total silence and the next request works (`reliability-idle-channel-150s.log`),
and `example.com` closes an idle TLS session after ~15 s *server-side* (a clean
EOF, not a Tor failure). So nothing tears down an idle channel by itself; the
teardown came from §6's failure handling:

- `circuit.rs` `sweep_dead_circuits` terminated the tunnel of any circuit marked
  `Failed`. Since `connect_stream`/`connect_tls`/`http.rs` retire a circuit
  whenever one `begin_stream` or TLS handshake fails, an unrelated slow request
  killed every stream already running on that circuit — with
  `MAX_CIRCUITS_PER_ISOLATION_KEY = 1` that is exactly the open SSE response for
  the same host, which then fails with "stream channel disappeared without END
  cell".
- `client.rs` `note_channel_failure` replaced the whole bridge channel after two
  suspicion points, and a single unanswered circuit build scored two. Connect
  timeouts alone therefore terminated the channel and all its circuits.

Fixes:

- `circuit.rs:59-120` — per-circuit open-stream count plus `StreamGuard` /
  `GuardedStream`: a stream holds a guard that counts it and keeps an `Arc` of
  the tunnel, so the reactor lives until the last stream is gone (tor-proto
  closes a tunnel by itself once nothing uses it).
- `circuit.rs:218,246` and `client.rs:368-378` — the slot is taken *before*
  RELAY_BEGIN and the circuit lock is still released before the await.
- `circuit.rs:879` — a retired/failed circuit with open streams is removed from
  selection but **not terminated**; only stream-free circuits are torn down.
  `fail_all_circuits`, `get_circuit_status` and the connect retry paths all go
  through this sweep.
- `client.rs:58,421-460` — channel replacement now requires real evidence: the
  channel is actually closing, or KCP reports outbound data unacknowledged for
  ≥20 s. `KcpHealth` (`kcp_stream.rs:52-120`, exposed by
  `snowflake_ws.rs:111`) tracks unacked segments and when progress last
  happened, so suspicion is based on **unacknowledged outbound data**, never on
  idle reads or slow connects. The health handle is cleared whenever the channel
  is dropped.
- No read deadline exists on an established stream: the 10 s `begin_stream` and
  25 s TLS-handshake budgets only wrap the connect path
  (`client.rs:296`, `webtor-wasm/src/lib.rs:228`); `TorStream.read`/`write`
  have no timeout.

### Tests

`tests/browser-tor-wasm.smoke.mjs` now runs **42** fixture checks (the previous
37 unchanged). New, test-feature hooks only:

- *1 MiB upload survives the full Turbo/KCP/SMUX stack: one datagram per packet,
  window backpressure* — new `smokeStackUpload` hook drives the real
  `SmuxStream<KcpStream<TurboStream<..>>>` against a mock bridge that runs a
  real `kcp` peer, applies WebSocket-like `Pending` backpressure, grants SMUX
  window only after consuming, and **rejects any Turbo frame larger than 1500
  bytes** like the bridge does. Asserts every one of 1 048 576 bytes arrives in
  order, >700 datagrams were written and `maxDatagram <= 1500`. Verified that
  this check fails (upload stalls, test deadline) when the old concatenating
  output is restored.
- *1 MiB raw upload in 64 KiB pieces arrives byte-complete* and *1 MiB TLS1.3
  upload in 64 KiB pieces arrives byte-complete* — counting local sink servers
  (the TLS one behind the generated test CA), written in the same 64 KiB pieces
  as `apps/browser/browser-http-stream.js`; the server echoes the byte total, so
  a lost or unflushed tail fails instead of truncating silently.
- *a retired circuit keeps carrying its open streams; only idle ones are torn
  down* — new `smokeTrackDeadCircuit` probe holds a stream slot and reports
  whether the manager terminated the circuit.
- *idle client streams survive silence and failing connects* — two streams stay
  silent for 3 s while a third does traffic and three connects fail; the idle
  streams keep their slots and still exchange data.

Production exports are unchanged: `scripts/build-webtor-wasm.sh` compared the
production JS glue and the wasm export table against
`third-party/webtor-rs/production-exports.*.txt`, and the harness compared the
module keys. No allowlist edit was needed; `vendor/webtor/webtor_wasm.js`
contains no `smoke*` symbol.

### Live probes

`node tests/browser-tor-wasm.smoke.mjs --tor` now also runs, before the §6 load
probe (log `workspace/build/webtor-rs/reliability-live-uploads-idle.log`):

- **Upload probe** — POST bodies of 10 KiB / 150 KiB / 1 MiB to
  `api.openai.com/v1/responses` (dummy bearer, expects 401) and 10 KiB / 150 KiB
  to `postman-echo.com/post` (expects 200), written in 64 KiB pieces:
  `401 in 1862 ms`, `401 in 4629 ms (32 KiB/s)`, `401 in 12102 ms (85 KiB/s)`,
  `200 in 1804 ms`, `200 in 4447 ms`; a second run on the published artifacts
  (`reliability-live-final-uploads-idle.log`) gave `401 in 1400 ms`,
  `401 in 2326 ms (64 KiB/s)`, `401 in 4871 ms (210 KiB/s)`, `200 in 1818 ms`,
  `200 in 1777 ms`. A separate scratch run also completed a 4 MiB body in
  16.4 s. Before the fix the same probe failed at 10 KiB with `END CONNRESET`
  (`reliability-upload-before-fix.log`).
- **Idle probe** — two `connectTls` streams to `www.wikipedia.org:443` are left
  idle for `WEBTOR_PROBE_IDLE` (default 90) seconds while a third stream does a
  full request; neither idle read settles early, the circuit status stays
  `Ready`, and both idle streams then complete their GET. (`example.com` is not
  usable for this: it closes idle TLS sessions after ~15 s.)
- The §6 load probe in the same runs: 20/20 sequential (median 1481 ms / 1030 ms)
  and 3/3 concurrent (median 1595 ms / 880 ms), status `Ready` afterwards.

### What remains flaky / not covered

- Upload throughput varies a lot with the chosen path: 32-64 KiB/s at 150 KiB and
  85-210 KiB/s at 1 MiB across runs, and small bodies are dominated by circuit
  setup (~1.4-1.9 s for 10 KiB). KCP is still configured with
  `snd_wnd = 128` and `interval = 100`; congestion control and window sizing
  were not tuned, only correctness restored.
- The channel-replacement path (outbound-stall evidence → new bridge session) is
  logic-reviewed and reachable but has no automated test: nothing in the harness
  can produce a wedged-yet-open transport. The idle/teardown tests cover the
  *absence* of teardown, not the recovery.
- Inbound KCP datagrams are still read with a 4 KiB buffer per `poll_read`; this
  works because the bridge's MTU is 1400, but it is not an enforced invariant.
- Unchanged inherent limits from §1-§6: no family/subnet separation, no
  persistent guards, exit policy only from the microdescriptor summary,
  `MAX_CIRCUITS_PER_ISOLATION_KEY = 1` (all streams of a first-party share a
  circuit; a retired circuit's in-flight streams are kept alive but not
  migrated), `cleanup_circuits()` age/idle rotation still unwired, no-op memory
  quota, KCP/SMUX flood behaviour unaudited.
- Native `cargo test` was not run (wasm32 check/build only). No browser/WebView
  run was performed here: the Chromium POST/SSE scenarios that produced these
  reports must be repeated by the main agent on this build.
- Artifacts: patch regenerated (`git diff --binary HEAD`, sha256
  `0ca0b69311c31a40f4dca5b39453afca3555d17a4d35c9e7fb674d396490b1ef`),
  production and smoke builds rebuilt from it, `vendor/webtor` copied whole to
  `apps/browser/vendor/webtor` (identical trees). No `apps/browser/*.js` edited.

## 7. Upload and idle-stream fixes (2026-10-13, verified by main agent)

Real use from Android Chrome exposed two transport bugs that earlier tests missed (they only sent small requests or downloaded):

- **Uploads ≥ ~10 KB never fully arrived** (server CONNRESET after 25–40 s; ≥ 400 KB gave "Circuit closed"). Normal backpressure was turned into hard errors by the hardening: SMUX peer window exhausted and the KCP send-queue limit returned errors (killing the shared Snowflake channel and every circuit) instead of Pending with a wake-up, and accepted KCP output could sit unsent. Fixed by the tor-reliability subagent (patch sha256 0ca0b693…); new fixture checks push 1 MiB through the full Turbo/KCP/SMUX stack, raw and TLS 1.3, byte-complete.
- **Idle established streams** (model replies that stay silent while thinking) were torn down ("stream channel disappeared without END cell"). Live check: two TLS streams idle 90 s with traffic on a third still complete.

Verified by main: 42/42 Node/ws fixture checks (three consecutive runs, after making the harness's Node `ws` WebSocket ignore close-while-CONNECTING errors as browsers do); headless Chromium 131 on the production page through Tor to api.openai.com: 10 KB, 60 KB, 150 KB, 400 KB and 1 MB POST bodies all answered (401 for the dummy key); a real Claude chat from Android Chrome (user) completed.

## 8. Bridge directory bootstrap: compression, raised limits, retry (tor-bridge-directory subagent, 2026-10-13)

Continuation of the bridge-directory work after the previous subagent delivered the API (`TorClientOptions.withDirectorySeed`/`withConsensusBaseUrl`, `TorClient.exportDirectory()`/`directoryValidAfter()`, source order seed → base URL → bridge-over-Tor) but before compression/limits/retry were finished. Release gate unchanged; no credentials (public Tor directory + example.com/check.torproject.org only); no security property weakened. Verified the tracked diff equalled the patch before and after. Patch regenerated, sha256 `17202f2398965b66d0d80e972b4680d2d67eb123f7e472319cf459574e915411`.

### API / sources order (unchanged, as delivered)

Seed (`withDirectorySeed(consensus, microdescriptors, certificates)`) → static snapshot (`withConsensusBaseUrl`, no built-in default) → download from the bridge over Tor (one-hop BEGIN_DIR streams). Every source runs the identical full authentication (pinned authorities, 5-of-9 quorum, lifetime, complete descriptor coverage, no rollback). `exportDirectory()` returns the installed documents for the embedder to cache and feed back as a seed. Main's `apps/browser` JS uses these feature-detected; no `apps/browser/*.js` was edited here.

### Compression — pure-Rust decode; what the bridge actually serves

- **Replaced the JS `DecompressionStream` inflate with pure-Rust `flate2` (miniz_oxide)** for the bridge path (`directory.rs:682` `decode_directory_response`, `:736` `decompress_directory`). The old `boundedInflate` crashed Node intermittently (`node_zlib.cc:330 Buffer::IsWithinBounds … assertion`, seen in `bridge-dir-live1.log` during microdescriptor decode) — a WASM-heap-growth race against the async stream's input view. flate2 is synchronous, works identically on wasm and native, and the production glue now contains **no `DecompressionStream`**. deflate (zlib RFC1950, detected by header so an output-limit rejection is never masked by a raw-deflate fallback) and gzip are decoded; output is bounded by the per-document cap (decompression-bomb safe). `directory_request()` offers `Accept-Encoding: deflate, gzip, identity` on every target.
- **The bridge already compresses (it did in the 20:26 build too); the bottleneck is that deflate is weak on microdescriptors.** Measured live per request (`directory.rs:721` logging, `bridge-dir-probe-final.log`): consensus `794024` wire → `3268699` decoded = **4.1× (deflate)**; microdescriptor batches only **~2.0× (deflate)** (e.g. `115645 → 196853`). Offline on the real ~32.6 MB microdescriptor corpus: **brotli 15.2×, deflate-9 2.09× (whole-file), deflate per-chunk 2.06×** — so the 2× is inherent to deflate's 32 KiB window, not level or chunking: microdescriptors are highly repetitive across relays (shared families, key/port boilerplate) but the repeats are far apart, so only a large-window codec exploits them.
- **A single-digit-MB bridge transfer is not reachable with the available codecs.** The Tor directory protocol offers identity/gzip/deflate/x-zstd/x-tor-lzma — **not brotli** (so the snapshot's 15× brotli cannot be requested over the bridge). zstd/lzma would match brotli, but **no pure-Rust zstd/lzma decoder is in the dependency tree or the offline cargo cache**, so it cannot be added in this offline build. Net bridge wire stays ~22 MB, dominated by ~16 MB of deflated microdescriptors. The snapshot path (brotli, ~2.1 MB → ~7–8 s to IsTor) and the seed path remain the fast primary; the bridge is the last-resort fallback. **Recommended follow-up (needs online vendoring + review): add a pure-Rust zstd decoder (e.g. `ruzstd`) and offer `x-zstd` to cut the bridge microdescriptor transfer ~7×.**

### Limits — raised and consistent

`directory.rs:30-31`: consensus `16 → 24 MiB`, microdescriptor aggregate `32 → 96 MiB` (live decoded set is ~32.6 MB — was right at the old 32 MiB cap; now ample headroom), certificate 1 MiB unchanged. The old single `MAX_DECOMPRESSED_BYTES` (32 MiB, shared) is removed; each decompression is now bounded by **its own document cap** — snapshot brotli (`decompress_brotli(bytes, cap)`, consensus→24 MiB / microdesc→96 MiB) and bridge deflate/gzip (`decode_directory_response(resp, max_body)` passes `max_body` as the output cap). Snapshot compressed-transfer caps are explicit (`:34` 8 MiB consensus, `:37` 16 MiB microdesc). The bridge request cap, aggregate microdescriptor cap, seed-size check and `authenticate_consensus`/`relays_from_consensus` re-checks all use the raised constants. No limit is unbounded.

### Reliability — idempotent retry with a fresh channel

- `retry.rs:288` `retry_with_fresh(attempts, backoff, acquire, op)`: only an `op` (download) failure that is `is_retryable()` retries; it reacquires the resource with `force = true` and backs off `backoff·n`. An `acquire` (channel-connect) failure returns immediately (connect has its own timeout; a hard-down transport fails fast — this keeps the offline fixtures that intentionally fail the bridge fast).
- `directory.rs:242` bridge branch uses it: **3 attempts, 2 s·n backoff, per-attempt 180 s**, the whole retry bounded by one **240 s** budget + the caller's cancellation token (`BRIDGE_BOOTSTRAP_TIMEOUT` raised 120 → 240 s per main's request; page allows 300 s). On a retry the channel closure forces `client.rs:248 invalidate_bridge_channel()` (drop the channel, fail its circuits) so the retried, idempotent download rides a fresh one — this directly targets the observed "stream channel disappeared without END cell" / stream-channel death mid-download (relates to §6/§7 channel suspicion; the download itself is restarted rather than relying only on channel replacement). Per-microdescriptor-batch resume was not added (a retry restarts the whole download); it remains a possible optimisation.

### Tests — 49 → 53 (all pass; production exports unchanged)

New fixture checks (test-feature hooks only, `lib.rs:2064/2072/2083`): **#41** deflate/gzip/identity response decode round-trips under the output cap; **#42** decompression-bomb rejection (tiny deflate → 2 MiB exceeds a 256 KiB cap) + non-200 status + header-less response; **#43** the raised caps are exactly 24/96/1 MiB; **#44** the bounded retry succeeds on the 3rd attempt (3 ops, `force=[false,true,true]`) and gives up at the attempt bound. The previous 49 are unchanged. `scripts/build-webtor-wasm.sh` compared the production JS glue and wasm export table against `third-party/webtor-rs/production-exports.*.txt` and passed with **no allowlist edit** — the new API was already in the allowlist (methods under `TorClient`/`TorClientOptions`), and this change adds no new production export (the `smoke*` hooks are gated behind `recovery-smoke`; the production glue contains no `smoke` symbol and no `DecompressionStream`).

### Live probes (public directory traffic only)

- **3 consecutive bridge-only bootstraps** (no seed, no base URL), rebuilt production: 91.9 s / 21.9 MB, 110.2 s / 22.0 MB, 100.5 s / 22.3 MB — all succeeded, directory exported, circuit `Ready` (`bridge-dir-probe-final.log`; the harness's own bridge run was 65 s / 22.3 MB). Consensus 3.27 MB, microdescriptors 32.6 MB, certs 20 KB each time. No crash (the flate2 switch).
- **Seeded bootstrap** (from the exported documents): **4.2 s**, ~6–8 KB wire (`bridge-dir-live-run2.log`).
- The pre-existing live checks still pass (wrong bridge identity rejected; authenticated directory; simultaneous raw + TLS1.3 streams; client-close cancellation; 10 KiB/150 KiB/1 MiB uploads; 90 s idle streams; 20/20 sequential + 3/3 concurrent load probe, status `Ready`).

### What remains / not covered

- **Bridge transfer is ~22 MB and cannot be meaningfully reduced with deflate.** Only a large-window codec (zstd/lzma, needing a decoder not available here, or brotli which the protocol doesn't offer) would help. The snapshot/seed fast paths are the mitigation; the raised 240 s bound keeps the fallback within the page's 300 s budget.
- The retry's forced-fresh-channel recovery is logic-reviewed and reachable but has no automated test that wedges a live download mid-stream (the 3 live runs did not need a retry). `smokeRetryFresh` tests the retry loop's attempt/backoff/force semantics deterministically, not a real stream death.
- Per-batch resume not implemented; a retry re-downloads everything.
- Native `cargo test` not run (wasm32 build/check only). No browser/WebView run here — main should repeat the Chromium bridge-fallback scenario on this build.
- Artifacts: patch regenerated (`git diff --binary HEAD`, sha256 `17202f2398965b66d0d80e972b4680d2d67eb123f7e472319cf459574e915411`), production + smoke rebuilt from it, `vendor/webtor` copied whole to `apps/browser/vendor/webtor` (verified identical trees). No `apps/browser/*.js` edited.

## 9. Snowflake transport throughput: flow-control windows (tor-bridge-directory subagent, 2026-10-13)

Throughput through Snowflake was capped at ~230–334 KB/s — exactly one 64 KiB SMUX window per RTT. Release gate unchanged; public traffic only; no security property weakened. Patch regenerated, sha256 `cd8d69458339c18991c2c99364702a2797ba9c44db914d60e398303c2e4c3fc9`.

### Official Snowflake Go client settings (cited from source)

`git clone` of `gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/snowflake`, `client/lib/snowflake.go`:
- `WindowSize = 65535` (line 64), `StreamSize = 1048576` (1 MiB, line 66).
- KCP (lines 382-393): `SetStreamMode(true)`, `SetWindowSize(65535, 65535)` (snd=rcv=**65535 packets**), `SetNoDelay(0, 0, 0, 1)` — nodelay=0, interval=0, resend=0, **nc=1 (congestion window off)**. The xtaci/kcp-go (and our kcp-0.6.0) clamp interval `0 → 10 ms`, so this is a 10 ms flush/ACK cadence. MTU is the kcp default `IKCP_MTU_DEF = 1400`.
- SMUX (lines 395-398): `Version = 2`, `KeepAliveTimeout = 10m`, `MaxStreamBuffer = StreamSize = 1 MiB` (the per-stream receive window), otherwise `DefaultConfig()`. The server (`server/lib/snowflake.go:222-225`) is identical (MaxStreamBuffer = 1 MiB). Snowflake explicitly set the large KCP window to remove the KCP bottleneck (issue 40026), relying on the 1 MiB smux buffer to bound memory — and accepts the extra retransmission bytes that come with `nc=1` + a huge window.

### Our changes (matched, but bounded)

- **SMUX per-stream receive window 64 KiB → 1 MiB** (`smux.rs:27` `DEFAULT_WINDOW`), matching Snowflake `MaxStreamBuffer`. `should_send_update` still fires at half window, i.e. a window update every ~512 KiB consumed (cumulative `self_read` + full window in each UPD — verified correct smux v2); the peer always keeps ≥512 KiB of headroom.
- **KCP send/receive window 128 → 1024 packets** and **interval 100 ms → 10 ms** (`kcp_stream.rs` `KcpConfig::default`), with the existing `nodelay=0, resend=0, nc=1`. 1024 packets ≈ 1.4 MiB each way — enough that KCP no longer bottlenecks the 1 MiB SMUX window at ~250 ms RTT, while bounded (Go's 65535 ≈ 90 MiB is left to the smux buffer; we bound KCP itself). 10 ms removes a flush of ACK latency per RTT.
- **Memory caps raised consistently so a bigger window can't be refused/overrun, still explicitly bounded ≤ 8 MiB/channel:** KCP `KCP_MAX_WAIT_SND` 512 → **1536** (> snd_wnd so a writer can fill the window; ~2 MiB send buffer), `KCP_MAX_OUTPUT_BYTES` 1 → **2 MiB** (holds one full-window flush), WebSocket inbound queue `MAX_RECEIVE` 1 → **4 MiB** / `MAX_FRAMES` 256 → **4096** (`websocket.rs:28-29`). Per-channel worst case ≈ 6.4 MiB inbound (WS 4 + KCP rcv 1.4 + SMUX 1) and ≈ 4 MiB outbound; steady-state ~3 MiB.

### Measured live in Node (public traffic; `windows-live-run1.log`, baseline from the §8 build)

| Metric | Before (64 KiB / 128) | After (1 MiB / 1024, interval 10 ms) |
|---|---|---|
| Bridge-only bootstrap | 47.7 s | **15–17 s** |
| …wire bytes in | 21.95 MB | **31–33 MB** (see trade-off) |
| HTTPS 10 MB download (codeload.github.com, git v2.43.0, ~11 MB) | **334 KB/s** | **1011 KB/s** (a 2nd run 578 KB/s — Snowflake proxy variance) |
| Seeded bootstrap | ~4 s | 4.1 s |
| Load probe sequential (20) | median 1189 ms | **median 484 ms**, 20/20 |
| Load probe concurrent (3) | median ~1600 ms | **median 520 ms**, 3/3 |

All previously-green live checks stay green: 10 KiB/150 KiB/1 MiB uploads, two 90 s idle TLS streams, wrong-identity rejection, simultaneous raw + TLS1.3, client-close cancellation. **55 fixture checks** (was 53): new **#45** pins the raised windows and their cap-consistency/≤8 MiB invariants (`smokeTransportWindows`), new **#46** pushes **2 MiB** (two SMUX windows) through the real Turbo/KCP/SMUX stack against the mock bridge's peer-window backpressure, byte-complete, datagrams ≤1500.

### Trade-off and what remains

- **The bridge bootstrap now moves ~50 % more wire bytes (22 → 33 MB) for ~3× the speed.** The extra bytes are KCP retransmissions: a 1024-packet (1.4 MiB) in-flight window with congestion control off (`nc=1`, as Snowflake) overshoots a ~1 MB/s volunteer-proxy path (BDP ≈ 0.3 MiB at ~300 ms), so some loss + retransmit is inherent. This is the same trade-off the official client makes far more aggressively (65535-packet window). The windows could be lowered (e.g. KCP 512) to cut retransmitted bytes at the cost of peak throughput on fast proxies if Snowflake-proxy bandwidth is a concern; left at 1024 to honour the throughput priority.
- zstd for directory downloads (task 4, optional) was **skipped**: no pure-Rust zstd/lzma decoder (`ruzstd`) is in the dependency tree or the offline cargo registry cache, and the build is `--offline --locked`, so it cannot be vendored here. Would still cut the bridge directory transfer ~7× (see §8) and is the recommended online follow-up.
- Native `cargo test` not run (wasm32 only). No browser/WebView run here — main should re-measure the Chromium download/throughput on this build.
- Artifacts: patch regenerated (`git diff --binary HEAD`, sha256 `cd8d69458339c18991c2c99364702a2797ba9c44db914d60e398303c2e4c3fc9`), production + smoke rebuilt from it, `vendor/webtor` copied whole to `apps/browser/vendor/webtor` (verified identical). Production exports unchanged (allowlist passed with no edit; the new accessors/hooks are `recovery-smoke`-gated — the production glue has no `smoke` symbol). No `apps/browser/*.js` edited.

### Update (2026-10-14): on-device verification — windows KEPT; proot Chromium is not a benchmark

The §9 window settings are **retained** (KCP 1024 / 10 ms / nc=1, SMUX 1 MiB, caps as above). Main verified the window build on a **real Android Chrome device**: a cold start downloaded the whole directory over Tor in **~36 s** — faster than the old 64 KiB build. The earlier "regression" (cold start ~200 s, connect timeouts) was measured in the **in-proot headless Chromium** used by `build/browser-validation`, which runs emulated ARM64 syscalls on a shared phone CPU and is far slower for timer-heavy single-thread KCP work; it is only a **functional** check, not a performance benchmark.

- Exploratory on-device-proot tuning (KCP 256/512 × interval 20/50, nc=0, SMUX 256/512 KiB) was run and initially looked "more robust" there, but that signal was an artifact of proot slowness, so it was **not adopted**. Node measurements and the user's real device are the authoritative signals.
- Functional check on this final build in proot Chromium (`build/browser-validation/wpFunc.log`): bridge-only bootstrap completed, circuit ready, 10 MB HTTPS download completed byte-complete, no crash (proot timings 184 s / 106 KB/s are not representative).
- Fixture count is now **56** (§9's 55 plus the §10 log-cap check). Fixture #45 pins KCP 1024 / SMUX 1 MiB.
- Product note: the hosted directory snapshot has been removed; the page now uses only the bridge download plus its own IndexedDB-saved copy. The `withConsensusBaseUrl` snapshot path remains in the client (harmless, no built-in default) but matters less now; the bridge download (§8) and its throughput (§9) are the primary cold-start path.

## 10. init() log cap — stop the TRACE console flood that crashed the renderer (2026-10-14)

`init()` installed `tracing_wasm::WASMLayer` with `WASMLayerConfig::default()` (max level TRACE, performance marks on), logging **every** TRACE/DEBUG event to the browser console. In the real app this flooded the console (~580 TRACE lines in the first seconds, e.g. `smux.rs` `poll_read`) and crashed the page renderer, while the app needs `init()` for the `setLogCallback` progress stream. Release gate unchanged; no security property affected.

- **WASMLayer is removed.** A single `JsLogLayer` (`webtor-wasm/src/lib.rs`) is now the whole subscriber. It caps logging at INFO unless `setDebugEnabled(true)`: its `register_callsite`/`enabled` return `never` for DEBUG/TRACE while debug is off, so those events are **not even constructed** (no formatting cost, no flood); `set_debug_enabled` calls `tracing::callsite::rebuild_interest_cache()` so the toggle re-evaluates every callsite. This is the EnvFilter-free `LevelFilter`-style cap requested. (A per-layer `Filter` and a `reload::Layer<LevelFilter>` were both tried first; mixed with a plain layer they did not re-enable DEBUG/TRACE on toggle — the single plain-layer gate does, verified.)
- **Console output is done by `JsLogLayer` itself, INFO and above only** (never DEBUG/TRACE, even in debug mode), with **no performance marks** — so the console is never flooded and the renderer is safe. DEBUG/TRACE, when enabled, go only to the `setLogCallback` progress stream. `forward_log` still gates the callback by the debug flag.
- **`getVersionInfo()` now contains the token `"log-capped"`** (`log_capped: true`, `logging: "log-capped"`) so the page can feature-detect that calling `init()` is safe. `tracing-wasm` is left as an (unused) dependency.
- Fixture **#47** (`init() caps logging at INFO…`): asserts the `log-capped` token; captures the console during a 200× TRACE/DEBUG burst with debug off and asserts zero DEBUG/TRACE console lines while the INFO marker still appears; then with debug on asserts TRACE/DEBUG reach the `setLogCallback` stream but still not the console. Verified in Node that debug-off emits no DEBUG/TRACE to the callback and debug-on emits both.
