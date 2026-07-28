/**
 * Everything that is not the MCP transport: the landing page, the consent
 * screen, the Wave OAuth dance, privacy, and connection deletion.
 *
 * The OAuth provider owns /authorize, /token, and /register. This handler is
 * what it delegates to for the human-facing half.
 */

import { Hono } from "hono";
import { DISCLAIMER } from "./brand-assets.js";
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
  deleteTokenRecord,
} from "./wave-oauth.js";
import { layout, landingPage, consentPage, privacyPage, deletePage, messagePage } from "./pages.js";

const app = new Hono();

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

app.get("/privacy", (c) => c.html(layout("Privacy", privacyPage())));

app.get("/health", (c) => c.json({ status: "ok" }));

/**
 * Consent screen.
 *
 * The OAuth provider hands us the parsed client request; we show the user what
 * is about to happen and let them choose whether the connection may write.
 */
app.get("/authorize", async (c) => {
  const oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthRequest.clientId) {
    return c.html(layout("Invalid request", messagePage("Invalid request", "This authorization request is missing a client id.")), 400);
  }

  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
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

  await saveTokenRecord(
    c.env.OAUTH_KV,
    user.id,
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
    props: { waveUserId: user.id, waveEmail: user.defaultEmail ?? null, writesEnabled: stored.writesEnabled },
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

  await deleteTokenRecord(c.env.OAUTH_KV, waveUserId);
  return c.html(
    layout(
      "Deleted",
      messagePage(
        "Connection deleted",
        "The stored Wave tokens for that user were removed. Revoke the application in your Wave account settings as well if you want to be certain."
      )
    )
  );
});

app.notFound((c) => c.html(layout("Not found", messagePage("Not found", DISCLAIMER)), 404));

export const WaveHandler = app;
