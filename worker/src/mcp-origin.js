// MCP streamable HTTP endpoints must reject untrusted browser Origins before
// they reach the OAuth provider: without this, any page a user visits could
// drive their connector from their own browser session. Requests without an
// Origin header are native or server-to-server clients and remain valid under
// the MCP transport specification.

const MCP_ENDPOINTS = new Set(["/mcp", "/sse"]);

function configuredOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

// Only accept an Origin header that is exactly an origin, never one carrying a
// path or query that a lenient parser might normalize into a match.
function browserOrigin(value) {
  return configuredOrigin(value) === value ? value : null;
}

export function allowedMcpOrigins(env) {
  const configured = [
    env.CONNECTOR_BASE_URL,
    ...(env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()),
  ];
  return new Set(configured.map(configuredOrigin).filter(Boolean));
}

export function rejectUntrustedMcpOrigin(request, env) {
  const url = new URL(request.url);
  if (!MCP_ENDPOINTS.has(url.pathname)) return null;

  const originHeader = request.headers.get("Origin");
  if (!originHeader) return null;

  const origin = browserOrigin(originHeader);
  if (origin && allowedMcpOrigins(env).has(origin)) return null;

  return Response.json(
    {
      error: "invalid_origin",
      error_description: "Browser Origin is not permitted for this MCP endpoint.",
    },
    { status: 403, headers: { "Cache-Control": "no-store", Vary: "Origin" } }
  );
}
