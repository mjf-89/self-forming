/** Maximum size of one UTF-8 JSON bridge message, including its envelope. */
export const MAX_BRIDGE_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_WORKSPACE_TEXT_BYTES = 1024 * 1024;

export type WireValue = null | number | string | { $bytes: string } | { $bigint: string };
export interface WireError { code: string; message: string; path?: string; spillPath?: string }
export type NativeEvent =
  | { event: "host.lifecycle"; id: string; foreground: boolean }
  | { event: "env.output"; id: string; stream: "stdout" | "stderr"; data: string }
  | { event: "env.watch"; id: string; change: { paths: string[] } | { overflow: true } | { error: WireError } }
  | { event: "agent.stopped"; id: "agent" }
;

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(parts.join(""));
}

export function base64ToBytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError("Invalid base64 payload from native host");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWireError(value: unknown): value is WireError {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string"
    && (value.path === undefined || typeof value.path === "string")
    && (value.spillPath === undefined || typeof value.spillPath === "string");
}

export function isNativeEvent(value: Record<string, unknown>): value is Record<string, unknown> & NativeEvent {
  if (typeof value.id !== 'string') return false;
  if (value.event === 'host.lifecycle') return value.id === 'host' && typeof value.foreground === 'boolean';
  if (value.event === 'agent.stopped') return value.id === 'agent';
  if (value.event === 'env.output') return typeof value.data === 'string' && (value.stream === 'stdout' || value.stream === 'stderr');

  if (value.event === 'env.watch' && isRecord(value.change)) {
    const change = value.change;
    return Array.isArray(change.paths) && change.paths.every(path => typeof path === 'string')
      || change.overflow === true || isWireError(change.error);
  }
  return false;
}
