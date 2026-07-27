/**
 * Wave OAuth2 and encrypted token storage.
 *
 * Wave issues short-lived access tokens with refresh tokens, so a hosted
 * connector has to store both and refresh before expiry. Stored records are
 * encrypted at the application layer with a key separate from the one the
 * OAuth provider uses, so a KV read alone does not yield usable Wave
 * credentials.
 */

const WAVE_AUTHORIZE_URL = "https://api.waveapps.com/oauth2/authorize/";
const WAVE_TOKEN_URL = "https://api.waveapps.com/oauth2/token/";
const WAVE_GRAPHQL_URL = "https://gql.waveapps.com/graphql/public";

// Refresh this far ahead of expiry, so a token cannot lapse mid-request.
const REFRESH_SAFETY_WINDOW_MS = 60000;

/**
 * Scopes requested at authorize time.
 *
 * Wave grants per-resource read and write scopes. The connector asks for the
 * read set always, and the write set only when the user opts into write tools,
 * so a read-only connection cannot be escalated by a later prompt injection.
 */
export const READ_SCOPES = [
  "user:read",
  "business:read",
  "account:read",
  "customer:read",
  "vendor:read",
  "product:read",
  "sales_tax:read",
  "invoice:read",
  "estimate:read",
  "transaction:read",
];

export const WRITE_SCOPES = [
  "account:create",
  "customer:create",
  "product:create",
  "sales_tax:create",
  "invoice:create",
  "invoice:send",
  "estimate:create",
  "estimate:send",
  "transaction:create",
];

export function scopesFor({ writesEnabled }) {
  return writesEnabled ? [...READ_SCOPES, ...WRITE_SCOPES] : READ_SCOPES;
}

export function tokenRecordKey(waveUserId) {
  return `wave:token:${waveUserId}`;
}

export function randomToken(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function sha256base64url(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return base64url(new Uint8Array(digest));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function hmacSign(secret, text) {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(text));
  return base64url(new Uint8Array(signature));
}

export async function hmacVerify(secret, text, signature) {
  try {
    return crypto.subtle.verify("HMAC", await hmacKey(secret), base64urlDecode(signature), new TextEncoder().encode(text));
  } catch {
    return false;
  }
}

async function dataEncryptionKey(secret) {
  // Derive a fixed-length AES key from an arbitrary-length secret.
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptStoredJson(secret, storageKey, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await dataEncryptionKey(secret);
  const ciphertext = await crypto.subtle.encrypt(
    // The storage key is bound in as additional authenticated data, so a
    // record cannot be moved to another user's key and still decrypt.
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(storageKey) },
    key,
    new TextEncoder().encode(JSON.stringify(value))
  );
  return JSON.stringify({ v: 1, iv: base64url(iv), ct: base64url(new Uint8Array(ciphertext)) });
}

export async function decryptStoredJson(secret, storageKey, raw) {
  const parsed = JSON.parse(raw);
  if (parsed?.v !== 1 || !parsed.iv || !parsed.ct) {
    throw new Error("Stored record is not in the expected encrypted format.");
  }
  const key = await dataEncryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64urlDecode(parsed.iv), additionalData: new TextEncoder().encode(storageKey) },
    key,
    base64urlDecode(parsed.ct)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export function buildWaveAuthorizeUrl({ clientId, redirectUri, state, scopes }) {
  const url = new URL(WAVE_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Reject a redirect from Wave's token endpoint.
 *
 * A redirect here would mean credentials were about to be posted somewhere
 * other than Wave, so it is treated as a hard failure rather than followed.
 */
function assertNoUpstreamRedirect(response, endpointName) {
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${endpointName} returned an unexpected redirect (HTTP ${response.status}).`);
  }
}

async function waveTokenRequest(env, params) {
  const body = new URLSearchParams({
    client_id: env.WAVE_CLIENT_ID,
    client_secret: env.WAVE_CLIENT_SECRET,
    ...params,
  });

  const response = await fetch(WAVE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    redirect: "manual",
  });
  assertNoUpstreamRedirect(response, "Wave token endpoint");

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Wave token endpoint returned a non-JSON response (HTTP ${response.status}).`);
  }
  if (!response.ok || payload.error) {
    // Never surface the raw body: it can echo the client secret back.
    throw new Error(`Wave rejected the token request: ${payload.error ?? `HTTP ${response.status}`}`);
  }
  return payload;
}

export function exchangeCodeForTokens(env, { code, redirectUri }) {
  return waveTokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

export function refreshTokens(env, refreshToken) {
  return waveTokenRequest(env, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** Identify the connecting user, so tokens are stored per Wave account. */
export async function fetchWaveUser(accessToken) {
  const response = await fetch(WAVE_GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "query { user { id defaultEmail firstName lastName } }" }),
  });
  const payload = await response.json();
  const user = payload?.data?.user;
  if (!user?.id) {
    throw new Error("Could not identify the Wave user for this token.");
  }
  return user;
}

export function toTokenRecord(tokens, { writesEnabled }) {
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    // expires_in is seconds from now; store an absolute instant instead so a
    // later read does not have to know when the token was issued.
    expires_at: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
    scope: tokens.scope ?? "",
    writes_enabled: !!writesEnabled,
  };
}

export async function saveTokenRecord(kv, waveUserId, record, encryptionSecret) {
  const key = tokenRecordKey(waveUserId);
  await kv.put(key, await encryptStoredJson(encryptionSecret, key, record));
}

export async function readTokenRecord(kv, waveUserId, encryptionSecret) {
  const key = tokenRecordKey(waveUserId);
  const raw = await kv.get(key);
  if (!raw) return null;
  return decryptStoredJson(encryptionSecret, key, raw);
}

export async function deleteTokenRecord(kv, waveUserId) {
  await kv.delete(tokenRecordKey(waveUserId));
}

/**
 * Return a usable access token, refreshing it when it is at or near expiry.
 *
 * Wave rotates the refresh token on each refresh, so the new one has to be
 * persisted or the next refresh fails.
 */
export async function getFreshAccessToken(env, waveUserId) {
  const record = await readTokenRecord(env.OAUTH_KV, waveUserId, env.DATA_ENCRYPTION_KEY);
  if (!record) {
    throw new Error("This Wave connection is no longer authorized. Reconnect the connector and try again.");
  }

  if (Date.now() < record.expires_at - REFRESH_SAFETY_WINDOW_MS) {
    return record.access_token;
  }

  if (!record.refresh_token) {
    throw new Error("The Wave access token expired and no refresh token is stored. Reconnect the connector.");
  }

  const refreshed = await refreshTokens(env, record.refresh_token);
  const updated = {
    ...toTokenRecord(refreshed, { writesEnabled: record.writes_enabled }),
    // Wave may omit a new refresh token; keep the existing one if so.
    refresh_token: refreshed.refresh_token ?? record.refresh_token,
  };
  await saveTokenRecord(env.OAUTH_KV, waveUserId, updated, env.DATA_ENCRYPTION_KEY);
  return updated.access_token;
}
