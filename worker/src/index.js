// Entry point: an OAuth 2.1 provider wrapping the MCP endpoints.
//
// /mcp (streamable HTTP, the current standard) and /sse (legacy) require a
// valid connector token; everything else falls through to the Hono handler
// for the landing page, consent, the Wave OAuth dance, privacy, and deletion.

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { CONNECTOR_RESOURCE_METADATA } from "./brand-assets.js";
import { rejectUntrustedMcpOrigin } from "./mcp-origin.js";
import { applyTransportSecurityHeaders } from "./response-security.js";
import { WaveMCP } from "./wave-mcp.js";
import { OAuthTransientState } from "./oauth-transient-state.js";
import { WaveHandler } from "./wave-handler.js";

export { WaveMCP, OAuthTransientState };

const oauthProvider = new OAuthProvider({
  apiHandlers: {
    "/mcp": WaveMCP.serve("/mcp"),
    "/sse": WaveMCP.serveSSE("/sse"),
  },
  defaultHandler: WaveHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["read", "write"],
  resourceMetadata: CONNECTOR_RESOURCE_METADATA,
  // Every OAuth 2.1 client used by Claude, ChatGPT, and Le Chat supports S256.
  // Do not advertise or accept unprotected plain PKCE challenges.
  allowPlainPKCE: false,
});

export default {
  async fetch(request, env, ctx) {
    const rejection = rejectUntrustedMcpOrigin(request, env);
    const response = rejection ?? (await oauthProvider.fetch(request, env, ctx));
    return applyTransportSecurityHeaders(request, response);
  },
};
