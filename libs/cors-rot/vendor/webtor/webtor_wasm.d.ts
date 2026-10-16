/* tslint:disable */
/* eslint-disable */

export class JsCircuitStatus {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly is_healthy: boolean;
  readonly ready_circuits: number;
  readonly total_circuits: number;
  readonly failed_circuits: number;
  readonly creating_circuits: number;
  readonly has_ready_circuits: boolean;
}

export class JsHttpResponse {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  json(): any;
  text(): string;
  readonly url: string;
  readonly body: Uint8Array;
  readonly status: number;
  readonly headers: any;
}

export class TorClient {
  free(): void;
  [Symbol.dispose](): void;
  close_rust(): Promise<void>;
  fetch_rust(url: string): Promise<JsHttpResponse>;
  static fetch_one_time_rust(snowflake_url: string, url: string, connection_timeout?: bigint | null, circuit_timeout?: bigint | null): Promise<JsHttpResponse>;
  update_circuit_rust(deadline_ms: bigint): Promise<void>;
  wait_for_circuit_rust(): Promise<void>;
  get_circuit_status_string_rust(): Promise<string>;
  static create(options: TorClientOptions): Promise<TorClient>;
  post_rust(url: string, body: Uint8Array): Promise<JsHttpResponse>;
  /**
   * Check if the client has been aborted.
   */
  isAborted(): boolean;
  /**
   * Like `connect`, then TLS 1.3 with SNI = `host` and full certificate
   * validation (rustls/webpki, Mozilla roots). Rejects on any TLS failure;
   * there is no fallback to older TLS versions.
   */
  connectTls(host: string, port: number, timeout_ms?: number | null): Promise<TorStream>;
  /**
   * Make a one-time fetch request (static method)
   */
  static fetchOneTime(snowflake_url: string, url: string, connection_timeout?: number | null, circuit_timeout?: number | null): Promise<any>;
  /**
   * Update the circuit
   */
  updateCircuit(deadline_ms: number): Promise<any>;
  /**
   * The exact authenticated directory documents currently installed, as
   * received (decompressed), with ISO-8601 lifetime timestamps. `undefined`
   * when no directory is installed. Suitable for caching and passing back
   * through `TorClientOptions.withDirectorySeed`.
   */
  exportDirectory(): { consensus: string, microdescriptors: string, certificates: string, validAfter: string, freshUntil: string, validUntil: string } | undefined;
  /**
   * Wait for circuit to be ready
   */
  waitForCircuit(): Promise<any>;
  /**
   * Get circuit relay information
   */
  getCircuitRelays(): Promise<any>;
  /**
   * Get circuit status
   */
  getCircuitStatus(): Promise<any>;
  /**
   * ISO-8601 `valid-after` of the installed directory, or `undefined`.
   * Cheap: no document copies, so callers can poll it and only call
   * `exportDirectory()` when it changes.
   */
  directoryValidAfter(): string | undefined;
  /**
   * Get circuit status string
   */
  getCircuitStatusString(): Promise<any>;
  constructor(options: TorClientOptions);
  /**
   * Make a POST request through Tor
   */
  post(url: string, body: Uint8Array): Promise<any>;
  /**
   * Abort all in-flight operations.
   *
   * This cancels long-running operations like circuit creation and HTTP requests.
   * Operations will reject with a "CANCELLED" error code.
   * Unlike `close()`, this does not clean up resources - the client can still be used.
   */
  abort(): void;
  /**
   * Close the Tor client
   */
  close(): Promise<any>;
  /**
   * Make a fetch (GET) request through Tor
   */
  fetch(url: string): Promise<any>;
  /**
   * Open a raw TCP stream to `host:port` through a Tor exit.
   * `timeout_ms` defaults to the circuit timeout.
   */
  connect(host: string, port: number, timeout_ms?: number | null): Promise<TorStream>;
  /**
   * Make a generic HTTP request with full control over method, headers, body, and timeout
   */
  request(method: string, url: string, headers: any, body?: Uint8Array | null, timeout_ms?: number | null): Promise<any>;
  /**
   * Make a POST request with JSON body and Content-Type header (convenience for JSON-RPC)
   */
  postJson(url: string, json_body: string): Promise<any>;
}

export class TorClientOptions {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Create options for Snowflake bridge via WebRTC (more censorship resistant)
   */
  static snowflakeWebRtc(): TorClientOptions;
  /**
   * Directory documents cached by the page (for example in IndexedDB from a
   * previous `exportDirectory()`), tried before any download.
   *
   * The seed is untrusted input: it must pass the same pinned-authority
   * 5-of-9 quorum, certificate, lifetime and descriptor-coverage checks as
   * a download, and must be currently valid. Otherwise it is logged and
   * ignored, and the next source is used.
   */
  withDirectorySeed(consensus: string, microdescriptors: string, certificates: string): TorClientOptions;
  withCircuitTimeout(timeout: number): TorClientOptions;
  withBridgeFingerprint(fingerprint: string): TorClientOptions;
  withConnectionTimeout(timeout: number): TorClientOptions;
  /**
   * Base URL serving consensus.txt.br and microdescriptors.txt.br.
   * Relative URLs are resolved by fetch() against the page URL.
   * When this is not set and no seed is supplied, the client downloads its
   * directory from the bridge over Tor instead.
   */
  withConsensusBaseUrl(url: string): TorClientOptions;
  withCreateCircuitEarly(create_early: boolean): TorClientOptions;
  withCircuitUpdateAdvance(advance: number): TorClientOptions;
  withCircuitUpdateInterval(interval?: number | null): TorClientOptions;
  /**
   * Create options for Snowflake bridge (default)
   */
  constructor(snowflake_url: string);
  /**
   * Create options for WebTunnel bridge
   */
  static webtunnel(url: string, fingerprint: string): TorClientOptions;
}

export class TorStream {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Next available chunk (at most 64 KiB), or `undefined` at EOF / after close.
   */
  read(): Promise<Uint8Array | undefined>;
  /**
   * Close the stream (idempotent). A pending `read()` resolves `undefined`.
   */
  close(): Promise<void>;
  /**
   * Write all of `data` and flush it to the circuit.
   */
  write(data: Uint8Array): Promise<void>;
}

/**
 * Get version information for display in UI
 */
export function getVersionInfo(): any;

/**
 * Initialize the WASM module
 */
export function init(): void;

/**
 * Enable or disable debug-level logging
 */
export function setDebugEnabled(enabled: boolean): void;

/**
 * Set the log callback function for receiving tracing logs in JavaScript
 */
export function setLogCallback(callback: Function): void;

/**
 * Test function for WASM
 */
export function test_wasm(): string;

/**
 * Authenticate a directory consensus with the same pin/quorum/time checks
 * used during bootstrap. Useful for snapshot diagnostics; never sets trust.
 */
export function validateDirectory(consensus: string, certificates: string): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_jscircuitstatus_free: (a: number, b: number) => void;
  readonly __wbg_jshttpresponse_free: (a: number, b: number) => void;
  readonly __wbg_torclient_free: (a: number, b: number) => void;
  readonly __wbg_torclientoptions_free: (a: number, b: number) => void;
  readonly __wbg_torstream_free: (a: number, b: number) => void;
  readonly getVersionInfo: () => any;
  readonly init: () => [number, number];
  readonly jscircuitstatus_creating_circuits: (a: number) => number;
  readonly jscircuitstatus_failed_circuits: (a: number) => number;
  readonly jscircuitstatus_has_ready_circuits: (a: number) => number;
  readonly jscircuitstatus_is_healthy: (a: number) => number;
  readonly jscircuitstatus_ready_circuits: (a: number) => number;
  readonly jscircuitstatus_total_circuits: (a: number) => number;
  readonly jshttpresponse_body: (a: number) => [number, number];
  readonly jshttpresponse_headers: (a: number) => any;
  readonly jshttpresponse_json: (a: number) => [number, number, number];
  readonly jshttpresponse_status: (a: number) => number;
  readonly jshttpresponse_text: (a: number) => [number, number, number, number];
  readonly jshttpresponse_url: (a: number) => [number, number];
  readonly setDebugEnabled: (a: number) => void;
  readonly setLogCallback: (a: any) => void;
  readonly test_wasm: () => [number, number];
  readonly torclient_abort: (a: number) => void;
  readonly torclient_close: (a: number) => any;
  readonly torclient_close_rust: (a: number) => any;
  readonly torclient_connect: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly torclient_connectTls: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly torclient_create: (a: number) => any;
  readonly torclient_directoryValidAfter: (a: number) => [number, number];
  readonly torclient_exportDirectory: (a: number) => any;
  readonly torclient_fetch: (a: number, b: number, c: number) => any;
  readonly torclient_fetchOneTime: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
  readonly torclient_fetch_one_time_rust: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: number, h: bigint) => any;
  readonly torclient_fetch_rust: (a: number, b: number, c: number) => any;
  readonly torclient_getCircuitRelays: (a: number) => any;
  readonly torclient_getCircuitStatus: (a: number) => any;
  readonly torclient_getCircuitStatusString: (a: number) => any;
  readonly torclient_get_circuit_status_string_rust: (a: number) => any;
  readonly torclient_isAborted: (a: number) => number;
  readonly torclient_new: (a: number) => any;
  readonly torclient_post: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly torclient_postJson: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly torclient_post_rust: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly torclient_request: (a: number, b: number, c: number, d: number, e: number, f: any, g: number, h: number, i: number) => any;
  readonly torclient_updateCircuit: (a: number, b: number) => any;
  readonly torclient_update_circuit_rust: (a: number, b: bigint) => any;
  readonly torclient_waitForCircuit: (a: number) => any;
  readonly torclient_wait_for_circuit_rust: (a: number) => any;
  readonly torclientoptions_new: (a: number, b: number) => number;
  readonly torclientoptions_snowflakeWebRtc: () => number;
  readonly torclientoptions_webtunnel: (a: number, b: number, c: number, d: number) => number;
  readonly torclientoptions_withBridgeFingerprint: (a: number, b: number, c: number) => number;
  readonly torclientoptions_withCircuitTimeout: (a: number, b: number) => number;
  readonly torclientoptions_withCircuitUpdateAdvance: (a: number, b: number) => number;
  readonly torclientoptions_withCircuitUpdateInterval: (a: number, b: number) => number;
  readonly torclientoptions_withConnectionTimeout: (a: number, b: number) => number;
  readonly torclientoptions_withConsensusBaseUrl: (a: number, b: number, c: number) => number;
  readonly torclientoptions_withCreateCircuitEarly: (a: number, b: number) => number;
  readonly torclientoptions_withDirectorySeed: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
  readonly torstream_close: (a: number) => any;
  readonly torstream_read: (a: number) => any;
  readonly torstream_write: (a: number, b: any) => any;
  readonly validateDirectory: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly wasm_bindgen_6d00a95a321d1690___convert__closures_____invoke______: (a: number, b: number) => void;
  readonly wasm_bindgen_6d00a95a321d1690___closure__destroy___dyn_core_e4e32f5ae772ed90___ops__function__FnMut_____Output_______: (a: number, b: number) => void;
  readonly wasm_bindgen_6d00a95a321d1690___convert__closures_____invoke___web_sys_f3f4ee95f47a19f8___features__gen_CloseEvent__CloseEvent_____: (a: number, b: number, c: any) => void;
  readonly wasm_bindgen_6d00a95a321d1690___closure__destroy___dyn_core_e4e32f5ae772ed90___ops__function__FnMut__web_sys_f3f4ee95f47a19f8___features__gen_CloseEvent__CloseEvent____Output_______: (a: number, b: number) => void;
  readonly wasm_bindgen_6d00a95a321d1690___convert__closures_____invoke___wasm_bindgen_6d00a95a321d1690___JsValue_____: (a: number, b: number, c: any) => void;
  readonly wasm_bindgen_6d00a95a321d1690___closure__destroy___dyn_core_e4e32f5ae772ed90___ops__function__FnMut__wasm_bindgen_6d00a95a321d1690___JsValue____Output_______: (a: number, b: number) => void;
  readonly wasm_bindgen_6d00a95a321d1690___convert__closures_____invoke___wasm_bindgen_6d00a95a321d1690___JsValue__wasm_bindgen_6d00a95a321d1690___JsValue_____: (a: number, b: number, c: any, d: any) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __externref_drop_slice: (a: number, b: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
