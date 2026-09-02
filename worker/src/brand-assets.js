// Identity the hosted connector presents to MCP clients and OAuth metadata.

import {
  CONNECTOR_FAVICON_256_PNG,
  CONNECTOR_FAVICON_256_PNG_SHA256,
  CONNECTOR_ICON_PNG,
  CONNECTOR_ICON_PNG_SHA256,
} from "./connector-icon-assets.js";

export * from "./connector-icon-assets.js";

export const CONNECTOR_NAME = "Wave Accounting";
export const CONNECTOR_ORIGIN = "https://wave.amesvt.com";
export const CONNECTOR_ICON_URL = `${CONNECTOR_ORIGIN}/assets/wave-icon-v1.png`;

export const REMOTE_SERVER_INFO = {
  name: "wave_mcp",
  version: "1.0.7",
  title: CONNECTOR_NAME,
  icons: [
    { src: CONNECTOR_ICON_URL, mimeType: "image/png", sizes: ["256x256"] },
  ],
};

export { CONNECTOR_FAVICON_256_PNG, CONNECTOR_FAVICON_256_PNG_SHA256 };
export { CONNECTOR_ICON_PNG, CONNECTOR_ICON_PNG_SHA256 };

export const CONNECTOR_RESOURCE_METADATA = {
  // Pinning grants and token audiences to this exact URL is what
  // workers-oauth-provider recommends now that it enforces RFC 8707 strictly;
  // clients that omit a resource indicator default to it rather than staying
  // unbound. resource_documentation rides along for resolvers that read it.
  resource: `${CONNECTOR_ORIGIN}/mcp`,
  resource_name: CONNECTOR_NAME,
  resource_documentation: "https://github.com/oliverames/wave-mcp-server#readme",
};

// Wave Financial Inc. owns the Wave name and marks; this is an independent
// connector, so the wordmark is never reproduced.
export const DISCLAIMER =
  "An independent connector for Wave Accounting. Not affiliated with, endorsed by, or sponsored by Wave Financial Inc., which owns the Wave name, logo, and marks.";
