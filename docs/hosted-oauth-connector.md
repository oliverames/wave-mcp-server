# Hosted OAuth connector

Most MCP clients can connect to a remote server over HTTP instead of launching
a local process. That path suits Wave well: rather than each user minting an
access token in the developer portal and pasting it into a config file, they
authorize the connector against their own Wave account and it handles refresh.

The implementation lives in [`worker/`](../worker/README.md); this document
covers what it is for and how to reason about it.

## When to use which

| | Local stdio | Hosted connector |
|---|---|---|
| Setup | Paste a token into your client config | Click through an OAuth screen |
| Token refresh | You regenerate it when it expires | Automatic |
| Where credentials live | Your machine | Encrypted in Cloudflare KV |
| Works offline against Wave | No, Wave is remote either way | No |
| Multi-user | One token per install | One authorization per user |
| Best for | A single developer on one machine | Sharing with a team, or a client that only speaks HTTP |

If you are the only user and you are comfortable managing a token, the local
server is simpler and has a smaller surface. The hosted connector earns its
complexity when more than one person needs access, or when your client cannot
launch a subprocess.

## Access levels

Write access is chosen during authorization, not afterwards. A read-only
connection requests only Wave's read scopes, so it is not merely that the
server declines to offer write tools: Wave never granted the permission, and no
later prompt injection can escalate it.

Choose write access only for a client you trust to act on your behalf. Sending
an invoice emails a real customer.

## Endpoints

| Path | Purpose |
|------|---------|
| `/mcp` | Streamable HTTP transport, the current standard |
| `/sse` | Legacy SSE transport |
| `/authorize`, `/token`, `/register` | OAuth 2.1, S256 PKCE only |
| `/callback` | Where Wave returns after authorization |
| `/` | Landing page |
| `/privacy` | Privacy statement |
| `/delete` | Remove stored tokens for one user |

## Operating it

Setup, secrets, deployment, and the post-deploy verification probes are in
[`worker/README.md`](../worker/README.md). The short version: `wrangler deploy`
reporting success proves nothing, so the deployment is not considered live
until the three unauthenticated probes pass.
