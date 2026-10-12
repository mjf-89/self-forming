import { isRecord, isWireError, isNativeEvent, MAX_BRIDGE_MESSAGE_BYTES, type NativeEvent, type WireError } from "./wire.ts";

/** The small surface provided by WebViewCompat.addWebMessageListener. */
export interface NativeBridgeTransport {
  postMessage(message: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export class NativeBridgeError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly spillPath?: string;
  constructor(code: string, message: string, options?: ErrorOptions & { path?: string; spillPath?: string }) {
    super(message, options);
    this.name = "NativeBridgeError";
    this.code = code;
    this.path = options?.path;
    this.spillPath = options?.spillPath;
  }
}

export interface NativeBridge {
  readonly closed: boolean;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  subscribe(listener: (event: NativeEvent) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  close(reason?: Error): void;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };
let bridgeSequence = 0;
const attachedTransports = new WeakSet<NativeBridgeTransport>();

/** No Android globals are accessed until this factory is called. */
export function createNativeBridge(transport?: NativeBridgeTransport): NativeBridge {
  const port = transport ?? (globalThis as typeof globalThis & { PiNative?: NativeBridgeTransport }).PiNative;
  if (!port || typeof port.postMessage !== "function") {
    throw new NativeBridgeError("host_unavailable", "This page has no PiNative host bridge");
  }
  if (attachedTransports.has(port)) {
    throw new NativeBridgeError("bridge_in_use", "This native transport already has a bridge");
  }
  attachedTransports.add(port);
  const previousListener = port.onmessage;
  const prefix = `b${++bridgeSequence}:`;
  let nextId = 0;
  let closedReason: Error | undefined;
  const pending = new Map<string, Pending>();
  const listeners = new Set<(event: NativeEvent) => void>();
  const closeListeners = new Set<(error: Error) => void>();
  const encoder = new TextEncoder();

  const close = (reason: Error = new NativeBridgeError("bridge_closed", "Native bridge is closed")): void => {
    if (closedReason) return;
    closedReason = reason;
    if (port.onmessage === receive) port.onmessage = previousListener;
    attachedTransports.delete(port);
    const waiting = [...pending.values()];
    pending.clear();
    listeners.clear();
    for (const entry of waiting) entry.reject(reason);
    for (const listener of closeListeners) {
      try { listener(reason); } catch { /* One observer must not prevent other handles from invalidating. */ }
    }
    closeListeners.clear();
  };

  const receive = (event: { data: unknown }): void => {
    if (closedReason) return;
    try {
      if (typeof event.data !== "string" || encoder.encode(event.data).byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
        throw new TypeError("Native response is not a bounded JSON string");
      }
      const message: unknown = JSON.parse(event.data);
      if (!isRecord(message) || typeof message.id !== "string") throw new TypeError("Invalid native envelope");
      if ("event" in message) {
        if (!isNativeEvent(message)) throw new TypeError("Invalid native stream event");
        for (const listener of listeners) {
          try { listener(message as NativeEvent); } catch { /* Stream observers are independent. */ }
        }
        return;
      }
      if (message.ok !== true && message.ok !== false) throw new TypeError("Invalid native response status");
      if (message.ok === false && !isWireError(message.error)) throw new TypeError("Invalid native error");
      const entry = pending.get(message.id);
      if (!entry) return; // A late or duplicated response must not settle another request.
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.result);
      else {
        const failure = message.error as WireError;
        entry.reject(new NativeBridgeError(failure.code, failure.message, failure));
      }
    } catch (cause) {
      close(new NativeBridgeError("protocol_error", "Invalid response from native host", { cause }));
    }
  };
  port.onmessage = receive;

  return {
    get closed() { return closedReason !== undefined; },
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (closedReason) throw closedReason;
      if (!method || !isRecord(params)) throw new TypeError("A method and parameter object are required");
      const id = `${prefix}${++nextId}`;
      const message = JSON.stringify({ id, method, params });
      if (encoder.encode(message).byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
        throw new NativeBridgeError("message_too_large", "Native request exceeds the 4 MiB message limit");
      }
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as T), reject });
        try { port.postMessage(message); }
        catch (cause) { close(new NativeBridgeError("bridge_lost", "Native transport failed", { cause })); }
      });
    },
    subscribe(listener) {
      if (closedReason) throw closedReason;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    onClose(listener) {
      if (closedReason) { listener(closedReason); return () => {}; }
      closeListeners.add(listener);
      return () => { closeListeners.delete(listener); };
    },
    close,
  };
}
