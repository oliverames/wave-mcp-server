// Durable Object-backed MCP agent: one instance per authenticated session.
//
// The whole tool and resource surface comes from the shared factory in the
// repo root, the same code the local stdio server runs. This file only
// supplies the per-user token getter and write flag.

import { McpAgent } from "agents/mcp";
import { createWaveServer } from "../../index.js";
import { REMOTE_SERVER_INFO } from "./brand-assets.js";
import { getFreshAccessToken, isAllowedWaveUser } from "./wave-oauth.js";

export class WaveMCP extends McpAgent {
  async init() {
    const { waveUserId, waveEmail, writesEnabled, tokenKey } = this.props;

    // Re-check the owner allowlist per session, not just at grant time, so a
    // token issued before the list was tightened stops working.
    if (!isAllowedWaveUser(this.env, { id: waveUserId, email: waveEmail })) {
      throw new Error("This Wave account is not authorized to use this connector.");
    }

    const { server } = createWaveServer({
      // Called per outbound Wave request, so an expiring token is refreshed
      // mid-session rather than failing the call.
      getAccessToken: () => getFreshAccessToken(this.env, waveUserId, tokenKey),
      hasCredentials: true,
      writesEnabled: !!writesEnabled,
      runtime: {
        tokenSource: "Wave OAuth (hosted connector)",
        detected_agent: "remote",
        config_fallback_disabled: true,
        sources_checked: [],
        values: {},
        lookup_errors: [],
      },
      serverInfo: REMOTE_SERVER_INFO,
    });
    this.server = server;
  }
}
