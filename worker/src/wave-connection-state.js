import { sha256base64url } from "./wave-oauth.js";

// Reuse the existing application-state namespace. No new binding, migration,
// or protocol-session data deletion is needed for the staged rollout.
async function defaultsStub(env, waveUserId) {
  const name = `mcp-defaults:${await sha256base64url(waveUserId)}`;
  return env.OAUTH_STATE.get(env.OAUTH_STATE.idFromName(name));
}

export async function connectionDefaults(env, waveUserId, tokenKey) {
  const stub = await defaultsStub(env, waveUserId);
  // Before per-connection Wave tokens existed, grants shared one user record.
  const path = `https://state/defaults/${encodeURIComponent(tokenKey ?? "legacy")}`;
  return {
    async get() {
      const response = await stub.fetch(path);
      if (!response.ok) throw new Error("Could not load the connection's default business.");
      return (await response.json()) ?? undefined;
    },
    async set(id) {
      const response = await stub.fetch(path, { method: "PUT", body: JSON.stringify(id) });
      if (!response.ok) throw new Error("Could not save the connection's default business.");
    },
  };
}

export async function deleteConnectionDefaults(env, waveUserId) {
  const stub = await defaultsStub(env, waveUserId);
  const response = await stub.fetch("https://state/defaults/all", { method: "DELETE" });
  if (!response.ok) throw new Error("Could not remove stored connection defaults.");
}
