/**
 * Everything that is not the MCP transport: the landing page, the consent
 * screen, the Wave OAuth dance, privacy, and connection deletion.
 *
 * The OAuth provider owns /authorize, /token, and /register. This handler is
 * what it delegates to for the human-facing half.
 */

import { Hono } from "hono";
import {
  DISCLAIMER,
  CONNECTOR_APPLE_TOUCH_ICON_PNG,
  CONNECTOR_APPLE_TOUCH_ICON_PNG_SHA256,
  CONNECTOR_FAVICON_16_PNG,
  CONNECTOR_FAVICON_16_PNG_SHA256,
  CONNECTOR_FAVICON_32_PNG,
  CONNECTOR_FAVICON_32_PNG_SHA256,
  CONNECTOR_FAVICON_48_PNG,
  CONNECTOR_FAVICON_48_PNG_SHA256,
  CONNECTOR_FAVICON_64_PNG,
  CONNECTOR_FAVICON_64_PNG_SHA256,
  CONNECTOR_FAVICON_96_PNG,
  CONNECTOR_FAVICON_96_PNG_SHA256,
  CONNECTOR_FAVICON_128_PNG,
  CONNECTOR_FAVICON_128_PNG_SHA256,
  CONNECTOR_FAVICON_256_PNG,
  CONNECTOR_FAVICON_256_PNG_SHA256,
  CONNECTOR_FAVICON_ICO,
  CONNECTOR_FAVICON_ICO_SHA256,
} from "./brand-assets.js";
import {
  buildWaveAuthorizeUrl,
  exchangeCodeForTokens,
  fetchWaveUser,
  isAllowedWaveUser,
  hmacSign,
  hmacVerify,
  randomToken,
  saveTokenRecord,
  scopesFor,
  toTokenRecord,
  deleteAllTokenRecords,
} from "./wave-oauth.js";
import { layout, landingPage, consentPage, privacyPage, deletePage, messagePage } from "./pages.js";

const app = new Hono();

function iconAsset(c, body, contentType, sha256) {
  const etag = `"sha256-${sha256}"`;
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    ETag: etag,
  };
  if (c.req.header("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}

function stateStub(env, id) {
  return env.OAUTH_STATE.get(env.OAUTH_STATE.idFromName(id));
}

async function putState(env, id, value) {
  await stateStub(env, id).fetch(`https://state/${id}`, {
    method: "PUT",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });
}

async function takeState(env, id) {
  const response = await stateStub(env, id).fetch(`https://state/${id}`, { method: "DELETE" });
  if (!response.ok) return null;
  return response.json();
}

app.get("/", (c) => c.html(layout("Wave MCP connector", landingPage(c.env.CONNECTOR_BASE_URL))));

const pngIcons = [
  ["/favicon-16x16.png", CONNECTOR_FAVICON_16_PNG, CONNECTOR_FAVICON_16_PNG_SHA256],
  ["/favicon-32x32.png", CONNECTOR_FAVICON_32_PNG, CONNECTOR_FAVICON_32_PNG_SHA256],
  ["/favicon-48x48.png", CONNECTOR_FAVICON_48_PNG, CONNECTOR_FAVICON_48_PNG_SHA256],
  ["/favicon-64x64.png", CONNECTOR_FAVICON_64_PNG, CONNECTOR_FAVICON_64_PNG_SHA256],
  ["/favicon-96x96.png", CONNECTOR_FAVICON_96_PNG, CONNECTOR_FAVICON_96_PNG_SHA256],
  ["/favicon-128x128.png", CONNECTOR_FAVICON_128_PNG, CONNECTOR_FAVICON_128_PNG_SHA256],
  ["/favicon-256x256.png", CONNECTOR_FAVICON_256_PNG, CONNECTOR_FAVICON_256_PNG_SHA256],
  ["/assets/wave-icon-v1.png", CONNECTOR_FAVICON_256_PNG, CONNECTOR_FAVICON_256_PNG_SHA256],
  ["/apple-touch-icon.png", CONNECTOR_APPLE_TOUCH_ICON_PNG, CONNECTOR_APPLE_TOUCH_ICON_PNG_SHA256],
];
for (const [path, body, sha256] of pngIcons) {
  app.get(path, (c) => iconAsset(c, body, "image/png", sha256));
}
app.get("/favicon.ico", (c) => iconAsset(c, CONNECTOR_FAVICON_ICO, "image/x-icon", CONNECTOR_FAVICON_ICO_SHA256));

app.get("/privacy", (c) => c.html(layout("Privacy", privacyPage())));

app.get("/health", (c) => c.json({ status: "ok" }));

/**
 * Consent screen.
 *
 * The OAuth provider hands us the parsed client request; we show the user what
 * is about to happen and let them choose whether the connection may write.
 */
app.get("/authorize", async (c) => {
  // parseAuthRequest throws on a malformed request -- a plain or missing PKCE
  // challenge, an unknown client -- and an uncaught throw surfaces as a bare
  // 500. The refusal is right either way; answer with a page and a 400.
  let oauthRequest;
  let client;
  try {
    oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    if (!oauthRequest.clientId) throw new Error("missing client id");
    client = await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  } catch {
    return c.html(
      layout(
        "Invalid request",
        messagePage(
          "Invalid request",
          "This authorization request is malformed or references an unknown client. Start again from your MCP client; note that PKCE with S256 is required."
        )
      ),
      400
    );
  }
  // Sign the request so the POST cannot be forged or tampered with between
  // the two steps.
  const payload = btoa(JSON.stringify(oauthRequest));
  const signature = await hmacSign(c.env.COOKIE_ENCRYPTION_KEY, payload);

  return c.html(
    layout(
      "Connect Wave",
      consentPage({
        clientName: client?.clientName || client?.clientId || "an MCP client",
        payload,
        signature,
      })
    )
  );
});

app.post("/authorize", async (c) => {
  const form = await c.req.formData();
  const payload = String(form.get("payload") ?? "");
  const signature = String(form.get("signature") ?? "");
  const allowWrites = form.get("allow_writes") === "1";

  if (!(await hmacVerify(c.env.COOKIE_ENCRYPTION_KEY, payload, signature))) {
    return c.html(layout("Invalid request", messagePage("Invalid request", "This consent form could not be verified. Start again from your MCP client.")), 400);
  }

  const oauthRequest = JSON.parse(atob(payload));
  const stateId = randomToken(24);
  await putState(c.env, stateId, { oauthRequest, writesEnabled: allowWrites });

  const redirectUri = `${c.env.CONNECTOR_BASE_URL}/callback`;
  return c.redirect(
    buildWaveAuthorizeUrl({
      clientId: c.env.WAVE_CLIENT_ID,
      redirectUri,
      state: stateId,
      scopes: scopesFor({ writesEnabled: allowWrites }),
    })
  );
});

/** Wave redirects here with an authorization code. */
app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const stateId = c.req.query("state");
  const error = c.req.query("error");

  if (error) {
    return c.html(layout("Connection cancelled", messagePage("Connection cancelled", `Wave reported: ${error}`)), 400);
  }
  if (!code || !stateId) {
    return c.html(layout("Invalid callback", messagePage("Invalid callback", "Wave did not return an authorization code.")), 400);
  }

  const stored = await takeState(c.env, stateId);
  if (!stored) {
    return c.html(
      layout("Expired", messagePage("This link expired", "Authorization links are single-use and expire after ten minutes. Start again from your MCP client.")),
      400
    );
  }

  let tokens;
  let user;
  try {
    tokens = await exchangeCodeForTokens(c.env, { code, redirectUri: `${c.env.CONNECTOR_BASE_URL}/callback` });
    user = await fetchWaveUser(tokens.access_token);
  } catch (failure) {
    return c.html(layout("Connection failed", messagePage("Connection failed", failure.message)), 502);
  }

  // Turn away any account other than the connector's owner before the tokens
  // are written, so an unauthorized grant never exists to be revoked later.
  if (!isAllowedWaveUser(c.env, user)) {
    return c.html(
      layout(
        "Not authorized",
        messagePage(
          "Not authorized",
          "This connector is private and serves a single Wave account. Nothing was stored, and the authorization Wave just granted can be revoked from your Wave account settings."
        )
      ),
      403
    );
  }

  // A fresh key per authorization keeps this connection's Wave tokens apart
  // from every other client the same user has connected: a read-only
  // authorization from one agent must not downgrade the token a write-enabled
  // agent is using.
  const tokenKey = randomToken(16);
  await saveTokenRecord(
    c.env.OAUTH_KV,
    user.id,
    tokenKey,
    toTokenRecord(tokens, { writesEnabled: stored.writesEnabled }),
    c.env.DATA_ENCRYPTION_KEY
  );

  // props travel with the connector token and reach the MCP agent; only the
  // Wave user id and the write flag are needed, never the Wave token itself.
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: stored.oauthRequest,
    userId: user.id,
    metadata: { label: user.defaultEmail ?? user.id },
    scope: stored.oauthRequest.scope,
    // The email rides along so the allowlist can be re-checked on every MCP
    // request: tightening ALLOWED_WAVE_USERS then cuts off existing grants
    // rather than only blocking new ones.
    props: { waveUserId: user.id, waveEmail: user.defaultEmail ?? null, writesEnabled: stored.writesEnabled, tokenKey },
  });

  return Response.redirect(redirectTo, 302);
});

/**
 * Connection deletion.
 *
 * A hosted connector that stores refresh tokens needs a way for a user to
 * revoke it without contacting anyone.
 */
app.get("/delete", async (c) => {
  const csrf = randomToken(24);
  await putState(c.env, `delete:${csrf}`, { issued: true });
  return c.html(layout("Delete connection", deletePage(csrf)));
});

app.post("/delete", async (c) => {
  const form = await c.req.formData();
  const csrf = String(form.get("csrf") ?? "");
  const waveUserId = String(form.get("wave_user_id") ?? "").trim();

  if (!(await takeState(c.env, `delete:${csrf}`))) {
    return c.html(layout("Invalid request", messagePage("Invalid request", "This form expired. Reload the page and try again.")), 400);
  }
  if (!waveUserId) {
    return c.html(layout("Delete connection", messagePage("Nothing to delete", "Enter the Wave user ID shown by the wave_auth_status tool.")), 400);
  }

  const deleted = await deleteAllTokenRecords(c.env.OAUTH_KV, waveUserId);
  return c.html(
    layout(
      "Deleted",
      messagePage(
        "Connection deleted",
        `Removed the stored Wave tokens for ${deleted} connection(s). Revoke the application in your Wave account settings as well if you want to be certain.`
      )
    )
  );
});

app.notFound((c) => c.html(layout("Not found", messagePage("Not found", DISCLAIMER)), 404));

export const WaveHandler = app;
