const HSTS_VALUE = "max-age=31536000";

// HSTS is deliberately scoped to this hostname. Do not add includeSubDomains:
// this connector does not control every amesvt.com subdomain.
export function applyTransportSecurityHeaders(request, response) {
  if (new URL(request.url).protocol !== "https:") return response;

  const headers = new Headers(response.headers);
  headers.set("Strict-Transport-Security", HSTS_VALUE);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
