# Hosted Wave MCP connector

A Cloudflare Worker serving the same tool surface as the local stdio server, at
a URL an MCP client can connect to without installing anything. Users authorize
it against their own Wave account over OAuth; each session gets its own tokens.

The tool layer is imported from `../index.js`, so the hosted and local servers
cannot drift apart. This directory only adds the OAuth dance, token storage,
and the transport hardening a public endpoint needs.

## Architecture

```
Client → OAuthProvider ──┬─ /mcp, /sse   → WaveMCP (Durable Object per session)
                         │                    └→ createWaveServer() from ../index.js
                         └─ everything else → WaveHandler (Hono)
                                                 landing, consent, /callback,
                                                 privacy, deletion
```

| File | Role |
|------|------|
| `src/index.js` | OAuth provider wrapping the MCP endpoints |
| `src/wave-mcp.js` | Durable Object agent; injects the per-user token getter |
| `src/wave-oauth.js` | Wave OAuth2, encrypted token records, refresh |
| `src/wave-handler.js` | Landing, consent, callback, privacy, deletion |
| `src/mcp-origin.js` | Browser Origin gate on the MCP transport |
| `src/response-security.js` | HSTS and sniffing protections |
| `src/oauth-transient-state.js` | Single-use OAuth state, in a Durable Object |
| `src/pages.js` | Server-rendered HTML, all values escaped |

## Status

Deployed at **https://wave.amesvt.com** and fully configured.

| Piece | State |
|-------|-------|
| Worker deployed, custom domain, DNS | done |
| KV namespace (`WAVE_OAUTH_KV`) | done |
| `COOKIE_ENCRYPTION_KEY`, `DATA_ENCRYPTION_KEY` | done |
| `WAVE_CLIENT_ID`, `WAVE_CLIENT_SECRET` | done |
| `ALLOWED_WAVE_USERS` | done |

This deployment is private: the `ALLOWED_WAVE_USERS` secret restricts it to a
single Wave account. It is set out of band rather than committed because this
repository is public and the value is an owner's address. A self-hosted copy
should set it to its own account, or leave it unset to accept any account.

## Setup

1. **Create a Wave OAuth application** at
   <https://developer.waveapps.com/>. Set the redirect URI to
   `https://wave.amesvt.com/callback` for production, and
   `http://localhost:8787/callback` for local development.

2. **Create the KV namespace** and put its id in `wrangler.jsonc`. Already
   done for this deployment (`WAVE_OAUTH_KV`,
   `0a32afc8956846c49e7bacdef075dd15`); the title is prefixed because the YNAB
   connector already owns the plain `OAUTH_KV` title on this account, and
   sharing one namespace would mix the two connectors' grants:

   ```bash
   npx wrangler kv namespace create WAVE_OAUTH_KV
   ```

3. **Set the secrets.** Never put these in `wrangler.jsonc`. All five are set
   on this deployment; the two Wave ones come from the application in step 1:

   ```bash
   npx wrangler secret put WAVE_CLIENT_ID
   npx wrangler secret put WAVE_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY
   npx wrangler secret put DATA_ENCRYPTION_KEY
   npx wrangler secret put ALLOWED_WAVE_USERS   # optional owner allowlist
   ```

   The two keys must be independent random values of 32 bytes or more:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

   They are separate on purpose. `COOKIE_ENCRYPTION_KEY` signs consent and
   state; `DATA_ENCRYPTION_KEY` encrypts Wave tokens. Compromising one should
   not yield the other.

4. **Deploy:**

   ```bash
   npm run deploy
   ```

## Local development

```bash
cp .dev.vars.example .dev.vars   # then fill it in
npm run dev
npm test
```

## Security model

- **Connections are restricted to an owner allowlist.** `ALLOWED_WAVE_USERS`
  names the Wave accounts that may connect. A stranger who authorizes at Wave
  is refused at `/callback` before any token is written, and the check runs
  again on every MCP session, so tightening the list cuts off grants that
  already exist.
- **Tokens are encrypted at the application layer** before they reach KV, with
  the storage key bound in as additional authenticated data. A record copied to
  another user's key will not decrypt.
- **Write access is chosen at authorization time**, and a read-only connection
  requests read scopes only. A later prompt injection cannot escalate it,
  because Wave itself never granted the write scopes.
- **Browser Origins are gated** on `/mcp` and `/sse`. Requests with no Origin
  are native or server-to-server clients and are allowed, per the MCP transport
  specification; a browser Origin must be on the allow-list.
- **PKCE is S256-only.** Plain challenges are neither advertised nor accepted.
- **OAuth state is single-use** and lives in a Durable Object rather than KV,
  because KV's eventual consistency would allow a replay window.
- **Redirects from Wave's token endpoint are refused**, so credentials cannot
  be posted to a host that is not Wave.
- **Every rendered value is escaped.** A hostile client name cannot inject
  markup into the consent screen.

## Verifying a deployment

`wrangler deploy` reporting success is not verification. These probes need no
credentials and each must pass:

```bash
# 1. The OAuth boundary holds: 401, never tool or catalog data.
curl -s -o /dev/null -w "%{http_code}\n" https://wave.amesvt.com/mcp

# 2. Security headers are present.
curl -s -D - -o /dev/null https://wave.amesvt.com/ \
  | grep -i "strict-transport\|referrer-policy\|x-content-type"

# 3. The Origin gate rejects a hostile browser origin.
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Origin: https://evil.example.com" https://wave.amesvt.com/mcp
```

Expect `401`, three headers, and `403`.

## Not affiliated with Wave

An independent connector. Wave Financial Inc. owns the Wave name and marks.
