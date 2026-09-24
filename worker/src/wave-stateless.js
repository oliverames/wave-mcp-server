import { McpServer, isLegacyRequest, isJsonContentType } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createWaveServer } from "../../index.js";
import { REMOTE_SERVER_INFO } from "./brand-assets.js";
import { connectionDefaults } from "./wave-connection-state.js";
import { getFreshAccessToken, isAllowedWaveUser } from "./wave-oauth.js";
import { WaveMCP } from "./wave-mcp.js";

const legacy = WaveMCP.serve("/mcp");

export async function createStatelessWaveServer(env, props) {
  const { waveUserId, waveEmail, writesEnabled, tokenKey } = props ?? {};
  if (typeof waveUserId !== "string" || !waveUserId ||
      !isAllowedWaveUser(env, { id: waveUserId, email: waveEmail })) {
    throw new Error("This Wave account is not authorized to use this connector.");
  }
  const defaults = await connectionDefaults(env, waveUserId, tokenKey);
  return createWaveServer({
    serverConstructor: McpServer,
    getAccessToken: () => getFreshAccessToken(env, waveUserId, tokenKey),
    hasCredentials: true,
    defaultBusinessId: await defaults.get(),
    onDefaultBusinessChange: (businessId) => defaults.set(businessId),
    writesEnabled: !!writesEnabled,
    runtime: {
      tokenSource: "Wave OAuth (hosted connector)", detected_agent: "remote",
      config_fallback_disabled: true, sources_checked: [], values: {}, lookup_errors: [],
    },
    serverInfo: REMOTE_SERVER_INFO,
  }).server;
}

export const WaveMcpHandler = {
  async fetch(request, env, ctx) {
    if (request.method === "POST" && !isJsonContentType(request.headers.get("Content-Type"))) {
      return new Response("Content-Type must be application/json", { status: 415 });
    }
    // OAuthProvider has already verified the bearer token and set ctx.props.
    // Existing sessions/SSE remain on their original storage until drained.
    if (await isLegacyRequest(request)) return legacy.fetch(request, env, ctx);
    return createMcpHandler(() => createStatelessWaveServer(env, ctx.props), {
      route: "/mcp",
      legacy: "reject",
      // Exact Origin validation remains in the outer Worker, before OAuth.
      allowedOriginHostnames: "*",
    })(request, env, ctx);
  },
};
