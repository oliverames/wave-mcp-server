// Durable Object-backed MCP agent: one instance per authenticated session.
//
// The whole tool and resource surface comes from the shared factory in the
// repo root, the same code the local stdio server runs. This file only
// supplies the per-user token getter and write flag.

import { McpAgent } from "agents/mcp";
import { createWaveServer } from "../../index.js";
import { REMOTE_SERVER_INFO } from "./brand-assets.js";
import { getFreshAccessToken } from "./wave-oauth.js";

export class WaveMCP extends McpAgent {
  async init() {
    const { waveUserId, writesEnabled } = this.props;
    const { server } = createWaveServer({
      // Called per outbound Wave request, so an expiring token is refreshed
      // mid-session rather than failing the call.
      getAccessToken: () => getFreshAccessToken(this.env, waveUserId),
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
