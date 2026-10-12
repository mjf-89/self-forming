// apps/on-device/auth-host.js
import { createNativeFetch } from "./native-host.js";
function createAuthHost(bridge) {
  if (bridge) return { call: (method, params) => bridge.call(method, params), fetch: createNativeFetch(bridge) };
  if (location.protocol !== "http:" || location.hostname !== "127.0.0.1") throw new Error("Sign-in needs the Android host or the local development app.");
  async function post(path, data, signal) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-self-forming": "1" },
      body: JSON.stringify(data),
      signal,
      credentials: "omit",
      redirect: "error"
    });
  }
  const host = {
    async call(method, params = {}) {
      const response = await post("/__pi/auth", { method, params });
      if (!response.ok) throw new Error(response.status === 404 ? "Start the development app with pnpm dev to enable connections." : "The local connection service could not complete this operation.");
      const reply = await response.json();
      if (!reply.ok) throw new Error(reply.error?.message ?? "The connection failed.");
      return reply.result;
    }
  };
  return { ...host, fetch: createNativeFetch(host) };
}
export {
  createAuthHost
};
