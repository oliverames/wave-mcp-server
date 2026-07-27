# Security Policy

## Reporting a vulnerability

Email **oliverames@gmail.com**, or open a
[private security advisory](https://github.com/oliverames/wave-mcp-server/security/advisories/new).
Please do not open a public issue for a vulnerability.

Expect an acknowledgement within a few days. This is a personal project, not a
staffed product, so please size your expectations accordingly.

## What this server touches

It holds a Wave OAuth2 access token and calls one endpoint,
`https://gql.waveapps.com/graphql/public`, on your behalf. That token can read
and, when writes are enabled, modify your accounting data and email your
customers.

## Design decisions

**Writes are off by default.** Tools that create, change, delete, or send
anything are not registered unless `WAVE_ALLOW_WRITES=1`. They are not merely
refused at call time; they are never advertised, so a model cannot invoke one
by guessing its name.

**The API host is pinned.** Requests carrying credentials are checked against
`https://gql.waveapps.com` before they are sent. A redirect to another host is
refused rather than followed.

**Tokens are redacted from errors.** Error text is scrubbed of the current
token and of any `Bearer` or `Authorization` value before it reaches the model
or the logs.

**Nothing is logged to stdout.** A stdio MCP server speaks JSON-RPC there;
diagnostics go to stderr.

**Secrets are never committed.** The token comes from the environment, a file,
or 1Password at runtime. `gitleaks` runs on every push.

**1Password lookups avoid a shell.** The `op` CLI is invoked with `execFileSync`
and an argument array, so a reference containing shell metacharacters cannot
become command injection.

**Responses are capped.** A response over `WAVE_MAX_RESPONSE_BYTES` (8 MB
default) is rejected rather than parsed.

For the hosted connector's model, see [worker/README.md](worker/README.md).

## What this cannot protect against

An MCP server executes what a model asks of it. With writes enabled, a model
persuaded by a prompt injection can send an invoice or delete a record within
the permissions you granted. Keep writes off unless you need them, and prefer
the hosted connector's read-only authorization for anything exploratory.

## Supported versions

The latest published version receives fixes. Older versions do not.
