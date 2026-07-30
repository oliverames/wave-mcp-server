/**
 * Worker unit tests.
 *
 * These cover the parts that are pure functions over Web Crypto and the
 * request: origin gating, token encryption, HTML escaping, and scope
 * selection. Anything needing Durable Objects or KV belongs in an integration
 * run against `wrangler dev`, not here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { rejectUntrustedMcpOrigin, allowedMcpOrigins } from "../src/mcp-origin.js";
import { applyTransportSecurityHeaders } from "../src/response-security.js";
import {
  encryptStoredJson,
  decryptStoredJson,
  hmacSign,
  hmacVerify,
  scopesFor,
  toTokenRecord,
  READ_SCOPES,
  WRITE_SCOPES,
  buildWaveAuthorizeUrl,
  base64url,
  isAllowedWaveUser,
} from "../src/wave-oauth.js";
import { layout, messagePage, consentPage } from "../src/pages.js";
import { WaveHandler } from "../src/wave-handler.js";
import {
  CONNECTOR_FAVICON_16_PNG_SHA256,
  CONNECTOR_FAVICON_32_PNG_SHA256,
  CONNECTOR_FAVICON_48_PNG_SHA256,
  CONNECTOR_FAVICON_64_PNG_SHA256,
  CONNECTOR_FAVICON_96_PNG_SHA256,
  CONNECTOR_FAVICON_128_PNG_SHA256,
  CONNECTOR_FAVICON_256_PNG_SHA256,
  CONNECTOR_FAVICON_ICO,
  CONNECTOR_FAVICON_ICO_SHA256,
  CONNECTOR_FAVICON_SVG_SHA256,
  REMOTE_SERVER_INFO,
} from "../src/brand-assets.js";

const env = {
  CONNECTOR_BASE_URL: "https://wave.amesvt.com",
  MCP_ALLOWED_ORIGINS: "https://chatgpt.com,https://claude.ai",
  COOKIE_ENCRYPTION_KEY: "test-cookie-key-at-least-32-bytes-long",
  DATA_ENCRYPTION_KEY: "test-data-key-at-least-32-bytes-long!!",
};

function request(url, headers = {}) {
  return new Request(url, { headers });
}

test("hosted connector advertises and serves explicit favicon sizes", async () => {
  assert.deepEqual(REMOTE_SERVER_INFO.icons, [{
    src: "https://wave.amesvt.com/assets/wave-icon-v1.png",
    mimeType: "image/png",
    sizes: ["256x256"],
  }]);
  const assets = [
    ["/favicon-16x16.png", "image/png", CONNECTOR_FAVICON_16_PNG_SHA256],
    ["/favicon-32x32.png", "image/png", CONNECTOR_FAVICON_32_PNG_SHA256],
    ["/favicon-48x48.png", "image/png", CONNECTOR_FAVICON_48_PNG_SHA256],
    ["/favicon-64x64.png", "image/png", CONNECTOR_FAVICON_64_PNG_SHA256],
    ["/favicon-96x96.png", "image/png", CONNECTOR_FAVICON_96_PNG_SHA256],
    ["/favicon-128x128.png", "image/png", CONNECTOR_FAVICON_128_PNG_SHA256],
    ["/assets/wave-icon-v1.png", "image/png", CONNECTOR_FAVICON_256_PNG_SHA256],
    ["/favicon.ico", "image/x-icon", CONNECTOR_FAVICON_ICO_SHA256],
    ["/favicon.svg", "image/svg\\+xml", CONNECTOR_FAVICON_SVG_SHA256],
  ];
  for (const [path, contentType, expectedSha256] of assets) {
    const response = await WaveHandler.request(`https://wave.amesvt.com${path}`, {}, env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", new RegExp(`^${contentType}`));
    assert.equal(
      response.headers.get("cache-control"),
      path === "/favicon.ico" || path === "/favicon.svg"
        ? "public, max-age=0, must-revalidate"
        : "public, max-age=31536000, immutable"
    );
    const body = Buffer.from(await response.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", body);
    assert.equal(Buffer.from(digest).toString("hex"), expectedSha256);
  }
  const landing = await WaveHandler.request("https://wave.amesvt.com/", {}, env);
  const html = await landing.text();
  // The SVG leads and a small ICO follows. Icon resolvers take the first usable
  // declaration, so the head advertises only the small variants; the larger PNG
  // routes above stay served for other consumers. See WORKLOG 2026-07-30.
  assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(html, /<link rel="alternate icon" href="\/favicon\.ico" sizes="32x32">/);
  for (const size of [16, 32]) {
    assert.match(html, new RegExp(`sizes="${size}x${size}" href="/favicon-${size}x${size}\\.png"`));
  }
});

test("favicon.ico stays small enough for icon resolvers", () => {
  // A six-frame uncompressed ICO reached 370 KB, which resolvers skipped. The
  // reference that does render in Claude, sosumi.ai, serves one 32x32 frame at
  // 4,286 bytes. See WORKLOG 2026-07-30.
  assert.ok(
    CONNECTOR_FAVICON_ICO.length < 10_000,
    `favicon.ico is ${CONNECTOR_FAVICON_ICO.length} bytes; keep it to a single 32x32 frame`,
  );
});

// --- Origin gating ----------------------------------------------------------

test("allowed origins include the connector itself and the configured clients", () => {
  const origins = allowedMcpOrigins(env);
  assert.ok(origins.has("https://wave.amesvt.com"));
  assert.ok(origins.has("https://chatgpt.com"));
  assert.ok(origins.has("https://claude.ai"));
});

test("a request with no Origin is allowed: native and server clients omit it", () => {
  assert.equal(rejectUntrustedMcpOrigin(request("https://wave.amesvt.com/mcp"), env), null);
});

test("a trusted browser Origin is allowed", () => {
  assert.equal(
    rejectUntrustedMcpOrigin(request("https://wave.amesvt.com/mcp", { Origin: "https://claude.ai" }), env),
    null
  );
});

test("a hostile Origin is rejected with 403", async () => {
  const response = rejectUntrustedMcpOrigin(
    request("https://wave.amesvt.com/mcp", { Origin: "https://evil.example.com" }),
    env
  );
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, "invalid_origin");
});

test("an Origin carrying a path is rejected, not normalized into a match", () => {
  const response = rejectUntrustedMcpOrigin(
    request("https://wave.amesvt.com/mcp", { Origin: "https://claude.ai/evil" }),
    env
  );
  assert.equal(response.status, 403);
});

test("origin gating applies to the legacy SSE endpoint too", () => {
  const response = rejectUntrustedMcpOrigin(
    request("https://wave.amesvt.com/sse", { Origin: "https://evil.example.com" }),
    env
  );
  assert.equal(response.status, 403);
});

test("non-MCP paths are not origin-gated", () => {
  assert.equal(
    rejectUntrustedMcpOrigin(request("https://wave.amesvt.com/privacy", { Origin: "https://evil.example.com" }), env),
    null
  );
});

// --- Transport security -----------------------------------------------------

test("HTTPS responses carry HSTS and sniffing protections", () => {
  const response = applyTransportSecurityHeaders(request("https://wave.amesvt.com/"), new Response("ok"));
  assert.equal(response.headers.get("Strict-Transport-Security"), "max-age=31536000");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
});

test("HSTS is not scoped to subdomains this connector does not control", () => {
  const response = applyTransportSecurityHeaders(request("https://wave.amesvt.com/"), new Response("ok"));
  assert.ok(!response.headers.get("Strict-Transport-Security").includes("includeSubDomains"));
});

test("plain HTTP responses are left alone", () => {
  const response = applyTransportSecurityHeaders(request("http://localhost:8787/"), new Response("ok"));
  assert.equal(response.headers.get("Strict-Transport-Security"), null);
});

// --- Token storage ----------------------------------------------------------

test("a stored token record round-trips through encryption", async () => {
  const record = { access_token: "wave-abc", refresh_token: "wave-refresh", expires_at: 123 };
  const sealed = await encryptStoredJson(env.DATA_ENCRYPTION_KEY, "wave:token:u1", record);
  assert.ok(!sealed.includes("wave-abc"), "the ciphertext leaked the token");
  const opened = await decryptStoredJson(env.DATA_ENCRYPTION_KEY, "wave:token:u1", sealed);
  assert.deepEqual(opened, record);
});

test("a record cannot be decrypted under a different storage key", async () => {
  const sealed = await encryptStoredJson(env.DATA_ENCRYPTION_KEY, "wave:token:u1", { access_token: "x" });
  await assert.rejects(() => decryptStoredJson(env.DATA_ENCRYPTION_KEY, "wave:token:u2", sealed));
});

test("a record cannot be decrypted with the wrong secret", async () => {
  const sealed = await encryptStoredJson(env.DATA_ENCRYPTION_KEY, "wave:token:u1", { access_token: "x" });
  await assert.rejects(() => decryptStoredJson("a-completely-different-secret-value", "wave:token:u1", sealed));
});

test("a malformed stored record is rejected rather than parsed loosely", async () => {
  await assert.rejects(() => decryptStoredJson(env.DATA_ENCRYPTION_KEY, "k", JSON.stringify({ v: 99 })));
});

test("expires_in is converted to an absolute instant", () => {
  const before = Date.now();
  const record = toTokenRecord({ access_token: "a", refresh_token: "r", expires_in: 3600 }, { writesEnabled: false });
  assert.ok(record.expires_at >= before + 3600 * 1000);
  assert.equal(record.writes_enabled, false);
});

// --- Signing ----------------------------------------------------------------

test("a signature verifies only for its own payload", async () => {
  const signature = await hmacSign(env.COOKIE_ENCRYPTION_KEY, "payload-a");
  assert.equal(await hmacVerify(env.COOKIE_ENCRYPTION_KEY, "payload-a", signature), true);
  assert.equal(await hmacVerify(env.COOKIE_ENCRYPTION_KEY, "payload-b", signature), false);
});

test("verification fails on a malformed signature instead of throwing", async () => {
  assert.equal(await hmacVerify(env.COOKIE_ENCRYPTION_KEY, "payload", "!!!not-base64!!!"), false);
});

// --- Scopes -----------------------------------------------------------------

test("a read-only connection requests no write scopes", () => {
  const scopes = scopesFor({ writesEnabled: false });
  assert.deepEqual(scopes, READ_SCOPES);
  for (const write of WRITE_SCOPES) assert.ok(!scopes.includes(write), `${write} leaked into read-only scopes`);
});

test("a write connection requests both sets", () => {
  const scopes = scopesFor({ writesEnabled: true });
  for (const scope of [...READ_SCOPES, ...WRITE_SCOPES]) assert.ok(scopes.includes(scope), scope);
});

test("the authorize URL carries the client, redirect, state, and scopes", () => {
  const url = new URL(
    buildWaveAuthorizeUrl({
      clientId: "client-1",
      redirectUri: "https://wave.amesvt.com/callback",
      state: "state-1",
      scopes: ["user:read", "business:read"],
    })
  );
  assert.equal(url.origin + url.pathname, "https://api.waveapps.com/oauth2/authorize/");
  assert.equal(url.searchParams.get("client_id"), "client-1");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("scope"), "user:read business:read");
});

test("base64url output is URL-safe and unpadded", () => {
  const encoded = base64url(new Uint8Array([251, 255, 190, 0]));
  assert.ok(!/[+/=]/.test(encoded), encoded);
});

// --- Owner allowlist --------------------------------------------------------

const ownerEnv = { ...env, ALLOWED_WAVE_USERS: "owner@example.com" };

test("the owner is allowed by account email, case-insensitively", () => {
  assert.equal(isAllowedWaveUser(ownerEnv, { id: "u:1", defaultEmail: "Owner@Example.COM" }), true);
});

test("the owner is allowed by the email carried in connector token props", () => {
  assert.equal(isAllowedWaveUser(ownerEnv, { id: "u:1", email: "owner@example.com" }), true);
});

test("a Wave user id can be allowlisted directly", () => {
  assert.equal(isAllowedWaveUser({ ...env, ALLOWED_WAVE_USERS: "u:abc" }, { id: "u:abc" }), true);
});

test("any other Wave account is refused", () => {
  assert.equal(isAllowedWaveUser(ownerEnv, { id: "u:2", defaultEmail: "stranger@example.com" }), false);
});

test("a user with no email is refused when the list holds only emails", () => {
  assert.equal(isAllowedWaveUser(ownerEnv, { id: "u:3", defaultEmail: null }), false);
});

test("multiple entries are accepted comma or whitespace separated", () => {
  const multi = { ...env, ALLOWED_WAVE_USERS: "a@example.com, b@example.com\nu:9" };
  assert.equal(isAllowedWaveUser(multi, { id: "u:9" }), true);
  assert.equal(isAllowedWaveUser(multi, { id: "x", defaultEmail: "b@example.com" }), true);
  assert.equal(isAllowedWaveUser(multi, { id: "x", defaultEmail: "c@example.com" }), false);
});

test("an unset or empty list leaves a self-hosted copy unrestricted", () => {
  assert.equal(isAllowedWaveUser(env, { id: "anyone", defaultEmail: "anyone@example.com" }), true);
  assert.equal(isAllowedWaveUser({ ...env, ALLOWED_WAVE_USERS: "  , " }, { id: "anyone" }), true);
});

// --- HTML escaping ----------------------------------------------------------

test("page content is escaped, so a client name cannot inject markup", () => {
  const html = consentPage({
    clientName: '<img src=x onerror="alert(1)">',
    payload: "p",
    signature: "s",
  });
  assert.ok(!html.includes("<img src=x"), "unescaped markup reached the page");
  assert.ok(html.includes("&lt;img"));
});

test("message pages escape both title and body", () => {
  const html = messagePage("<b>t</b>", "<script>x</script>");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("the layout marks pages noindex", () => {
  assert.match(layout("t", "<p>b</p>"), /name="robots" content="noindex"/);
});

// --- Authorize error shape --------------------------------------------------

test("a malformed authorize request gets a 400 page, not a bare 500", async () => {
  const badProviderEnv = {
    ...env,
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => {
        throw new Error("The code_challenge_method must be S256");
      },
      lookupClient: async () => null,
    },
  };
  const response = await WaveHandler.fetch(
    new Request("https://wave.amesvt.com/authorize?client_id=x&code_challenge_method=plain"),
    badProviderEnv
  );
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.match(body, /Invalid request/);
  assert.ok(!body.includes("Internal Server Error"));
});

test("an authorize request with no client id gets the same 400 page", async () => {
  const providerEnv = {
    ...env,
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => ({}),
      lookupClient: async () => null,
    },
  };
  const response = await WaveHandler.fetch(new Request("https://wave.amesvt.com/authorize"), providerEnv);
  assert.equal(response.status, 400);
});

// --- Scope names and per-connection token records ----------------------------

import { tokenRecordKey, deleteAllTokenRecords } from "../src/wave-oauth.js";

test("write scopes use Wave's :write naming, never the rejected :create", () => {
  for (const scope of WRITE_SCOPES) {
    assert.ok(!scope.endsWith(":create"), `${scope} uses :create, which Wave rejects as invalid_scope`);
  }
  const expected = new Set([
    "account:write",
    "customer:write",
    "product:write",
    "sales_tax:write",
    "invoice:write",
    "invoice:send",
    "estimate:write",
    "estimate:send",
    "transaction:write",
  ]);
  assert.deepEqual(new Set(WRITE_SCOPES), expected);
});

test("token records are keyed per connection, not per user", () => {
  const a = tokenRecordKey("user-1", "key-a");
  const b = tokenRecordKey("user-1", "key-b");
  assert.notEqual(a, b);
  assert.ok(a.startsWith("wave:token:user-1:"));
});

test("deleteAllTokenRecords removes every connection for one user only", async () => {
  const store = new Map([
    ["wave:token:user-1:key-a", "x"],
    ["wave:token:user-1:key-b", "x"],
    ["wave:token:user-2:key-c", "x"],
  ]);
  const kv = {
    async list({ prefix }) {
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
    async delete(name) {
      store.delete(name);
    },
  };
  const deleted = await deleteAllTokenRecords(kv, "user-1");
  assert.equal(deleted, 2);
  assert.ok(store.has("wave:token:user-2:key-c"), "another user's record was deleted");
});
