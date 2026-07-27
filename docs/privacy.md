# Privacy

## The local server

`@oliverames/mcp-server-for-wave` runs on your own machine as a subprocess of
your MCP client. It has no backend and sends nothing anywhere except to Wave's
own API at `https://gql.waveapps.com/graphql/public`.

**Stored:** nothing. The server keeps no database, cache, or log file. Your
access token is read from the environment, a file you point it at, or 1Password,
and lives only in process memory.

**Transmitted:** your requests to Wave, and nothing else. There is no analytics,
telemetry, or error reporting.

**Logged:** diagnostics go to stderr, which your MCP client may capture. Access
tokens are redacted from error text before it is emitted.

Your accounting data flows from Wave, through this process, to your MCP client.
What that client then does with it, including whether it sends the content to a
model provider, is governed by that client's own privacy policy, not this one.

## The hosted connector

The Cloudflare Worker in `worker/` is a different matter, because it stores
credentials on your behalf.

**Stored:** your Wave user ID, your Wave OAuth access and refresh tokens
(encrypted at the application layer before they reach storage, with a key
separate from the OAuth provider's), and whether you granted write access.

**Not stored:** your Wave password, which the connector never sees; and your
accounting data, which is fetched for a request and returned to your client
without being retained.

**Deleting your data:** use the connector's `/delete` page to remove the stored
tokens, then revoke the application in your Wave account settings.

## Third parties

Wave Financial Inc. operates the API this software calls. Their handling of
your data is governed by [Wave's privacy policy](https://www.waveapps.com/legal/privacy-policy).

This project is not affiliated with Wave Financial Inc.

## Questions

Open an issue at
<https://github.com/oliverames/wave-mcp-server/issues>, or email
oliverames@gmail.com.
