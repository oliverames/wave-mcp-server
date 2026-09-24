# Hosted Wave MCP connector

A Cloudflare Worker serving the same tool surface as the local stdio server, at
a URL an MCP client can connect to without installing anything. Users authorize
it against their own Wave account over OAuth; each authenticated connection gets its own tokens.

The tool layer is imported from `../index.js`, so the hosted and local servers
cannot drift apart. This directory only adds the OAuth dance, token storage,
and the transport hardening a public endpoint needs.

## Architecture

```
Client → OAuthProvider ──┬─ /mcp modern → SDK v2 factory, per request
                         ├─ /mcp legacy, /sse → WaveMCP (temporary session lane)
                         │                    └→ shared createWaveServer()
                         └─ everything else → WaveHandler (Hono)
                                                 landing, consent, /callback,
                                                 privacy, deletion
```

| File | Role |
|------|------|
| `src/index.js` | OAuth provider wrapping the MCP endpoints |
| `src/wave-mcp.js` | Temporary legacy Durable Object transport and session state |
| `src/wave-stateless.js` | SDK v2 request factory and protocol-era routing |
| `src/wave-connection-state.js` | Default business per authenticated connection |
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

Those probes prove the Worker is up, not that the new code is in it. Two
things can mislead you here, both seen on 2026-09-02:

- `wrangler deploy` in a non-interactive shell with no `CLOUDFLARE_API_TOKEN`
  stops at login, and an earlier session's "redeploy" turned out to be a
  `--dry-run`. Look for `Uploaded wave-mcp-connector` and a version ID in the
  output; nothing short of that is a deploy. A non-interactive deploy works with the
  Cloudflare Global API Key: export `CLOUDFLARE_API_KEY`, `CLOUDFLARE_EMAIL`,
  and `CLOUDFLARE_ACCOUNT_ID` before `npm run deploy` (used for 1.0.8 on
  2026-09-22).
- The Worker's `modified_on` in the Cloudflare API and dashboard does not
  track deployments. It stayed at 2026-07-30 across real deploys.

To confirm the bundle changed, fetch the deployed script (the Cloudflare MCP
`workers_get_worker_code` tool, or `wrangler` with a token) and grep it for
the string your change introduced, for example the `REMOTE_SERVER_INFO`
version or a GraphQL fragment.

## Not affiliated with Wave

An independent connector. Wave Financial Inc. owns the Wave name and marks.
The hosted landing page and MCP initialization metadata advertise the canonical
connector artwork through explicit 8-bit PNG favicons at 16, 32, 48, 64, 96,
128, and 256 pixels, plus ICO and Apple touch variants. Regenerate them with
`npm run build:worker-icons` after changing `assets/icon.png`.

## MCP SDK v2 migration

Modern MCP 2026-07-28 requests use `createMcpHandler` and a fresh SDK v2 server
at the existing `/mcp` URL. OAuth, the exact browser Origin gate, token refresh,
write permissions and all tool/resource definitions are shared with the old
path. The current deployment configuration and stored grants remain unchanged.

The owner selected a saved default business per authenticated connection for
stateless clients. Its identity comes from verified OAuth `waveUserId` and
`tokenKey`, never a client-supplied session or header. Separate objects in the
existing `OAUTH_STATE` namespace hold these defaults. Pre-tokenKey grants use
one legacy user connection, matching their shared Wave token record. Deleting
a user's connection records also removes all of that user's new defaults.

Existing 2025-era `/mcp` sessions and `/sse` clients temporarily retain their
original `WaveMCP` transport and session defaults. Old session defaults are not
copied into the new connection scope because several sessions may disagree.
A migrating connection initially has no default and can choose one with
`wave_set_default_business`, or pass `business_id` explicitly.

### Verification and retirement gates

Run `npm test` here and `npm run test:integration`. The latter starts a local
Wrangler Worker with disposable KV/Durable Object storage. It replaces only
the human Wave login with dummy identities, issues real connector OAuth tokens,
and blocks all outbound requests except an in-memory Wave response. The
fixture entrypoint is never referenced by production `wrangler.jsonc`.

This is the tested compatibility stage, not completed production retirement.
Before removing the legacy lane:

1. Deploy and verify modern clients on the receiving host, including refresh,
   owner allowlist, write permissions, default business and deletion.
2. Confirm every configured client has moved off 2025-era sessions and `/sse`.
   Observe existing Worker request logs for a full maximum client session
   lifetime agreed by the owner. Do not infer absence from local tests.
3. Let existing legacy sessions finish. Then remove the legacy branch and
   `/sse` handler, `WaveMCP` export and binding in a separate reviewed release.
4. Retain the old migration history. Deleting the old Durable Object class and
   its persisted session data requires explicit owner approval in that release.
   No destructive migration is included here.

Primary guidance: [Cloudflare SDK v2 migration](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/)
and [handler APIs](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/).
