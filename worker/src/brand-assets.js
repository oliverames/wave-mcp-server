// Identity the hosted connector presents to MCP clients and OAuth metadata.

export const CONNECTOR_NAME = "Wave Accounting";

export const REMOTE_SERVER_INFO = {
  name: "wave_mcp",
  version: "1.0.0",
};

export const CONNECTOR_RESOURCE_METADATA = {
  resource_name: CONNECTOR_NAME,
  resource_documentation: "https://github.com/oliverames/wave-mcp-server#readme",
};

// Wave Financial Inc. owns the Wave name and marks; this is an independent
// connector, so the wordmark is never reproduced.
export const DISCLAIMER =
  "An independent connector for Wave Accounting. Not affiliated with, endorsed by, or sponsored by Wave Financial Inc., which owns the Wave name, logo, and marks.";
