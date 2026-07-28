# Worklog

Notable changes, and the reasoning behind them. For the user-facing summary,
see the release notes.

## 2026-07-27 - Write scopes corrected, tokens stored per connection

**invalid_scope on a write-enabled connection.** The earlier entry below says
the scope guesses "were right" -- that was overclaimed. Only the read set had
been proven; the write set used `resource:create` names, and Wave rejects
those with `error=invalid_scope`. The trap: Wave's authorize endpoint
validates scopes only on an *authenticated* session. Logged-out probes 302 to
the login page having accepted any scope string, so every curl check passed
while the real flow failed. Bisected in a logged-in browser: Wave's write
scopes are `resource:write` (plus the real `invoice:send` and
`estimate:send`). Verified end to end with a write-enabled authorization:
Wave's consent screen renders the write set as "View and manage ...", and the
resulting session registers all 74 tools. No mutation was run.

**Wave tokens are now stored per connection, not per user.** The old key
`wave:token:<userId>` meant every authorization overwrote the last one's Wave
tokens: connect a read-only agent after a write-enabled one and the shared
token silently downgrades, breaking the write agent at Wave. Records now live
at `wave:token:<userId>:<tokenKey>`, with the random tokenKey carried in the
grant props, so any number of agents can hold simultaneous connections with
different access levels. The public /delete page removes all of a user's
records by prefix, since someone revoking should not need to know how many
clients they had connected.

## 2026-07-27 - Finished the hosted connector's OAuth setup and made it private

**What changed**: the Wave developer-portal application now exists, its two
secrets are set on the Worker, and the connector is restricted to a single Wave
account.

**The failure**: connecting produced `invalid_request` / "Invalid client_id
parameter value" from Wave's authorize endpoint. `WAVE_CLIENT_ID` and
`WAVE_CLIENT_SECRET` had never been set, so `buildWaveAuthorizeUrl` serialized
`client_id=undefined` and Wave rejected it before the consent screen. Nothing
in the Worker was wrong; the deployment was simply incomplete, which the
previous session's handoff had recorded as an open item. Credentials now live
in 1Password (`op://Development/Wave MCP Connector`) and were piped into
`wrangler secret put` from there, never through a file or a shell history line.

**Scopes were the other unknown.** The ten read scopes in `wave-oauth.js` were
a docs reading that had never been exercised. Wave accepted all ten on the live
authorize URL, so the guess was right.

**Owner allowlist**: a hosted connector answers to anyone who learns its URL,
and this one is meant for one person. `ALLOWED_WAVE_USERS` matches a Wave user
id or account email; anyone else is refused at `/callback` before a token is
written, so an unauthorized grant never exists to be cleaned up. The check runs
again in `WaveMCP.init()` on every session, which means removing an entry ends
a live connection rather than only blocking new ones. That is why the account
email rides along in the connector token props.

The value is set as a Worker secret rather than a `wrangler.jsonc` var. It is
not a secret cryptographically, but it is an owner's address and this
repository is public. An empty or unset list means no restriction, which is
what someone self-hosting their own copy wants.

**Still not done**: no mutation has run against a live Wave account, and
`evaluation/evaluation.xml` still carries placeholder answers.

## 2026-07-27 - Published 1.0.0 to npm and deployed the hosted connector

**What changed**: `@oliverames/mcp-server-for-wave@1.0.0` is on npm, and the
Cloudflare Worker is live at `wave.amesvt.com`. Repo made public. Header icon
swapped from a mark I drew to Wave's own app icon, with brand colors taken from
their logo SVG (`#328ff8`, `#76c3fc`). `NPM_TOKEN` set on the repo so
`.github/workflows/release.yml` can publish future tags. CI actions bumped to
`checkout@v7` / `setup-node@v6` / `gitleaks-action@v3` to match the sibling
repos and clear the Node 20 deprecation.

**Bug found while verifying the tarball, before publish**: the server never
started when launched through its npm bin. npm installs the bin as a *relative
symlink*, so `process.argv[1]` is `node_modules/.bin/mcp-server-for-wave` --
neither absolute nor the real file -- and the autostart guard comparing it to
`import.meta.url` never matched. Every `npx` launch, which is how the README
and all five plugin manifests tell people to run it, would have started a
process that sat silent. Fixed with `realpathSync` on both sides. Every
pre-existing check missed it because they all ran `node index.js` with a path
that already matched.

**Decisions made**:

- Added `scripts/smoke-packed-install.mjs`, which packs, installs, and completes
  a handshake through both declared bin names, and wired it into CI and the
  release gate. The lesson generalizes: exercise the artifact the way a user
  receives it, not the way a developer runs it.
- KV namespace titled `WAVE_OAUTH_KV`, not `OAUTH_KV`. The YNAB connector
  already owns the plain title on this Cloudflare account, and one shared
  namespace would mix the two connectors' OAuth grants.
- Used Wave's official app icon rather than an original mark, matching how
  `ynab-mcp-server` ships YNAB's. Trademark posture stated explicitly in the
  README and the connector's page footer: nominative use to identify the
  service, no implied endorsement.

**Verification**: 57 unit tests, 24 Worker tests, 64/64 GraphQL documents valid
against live Wave, gitleaks clean, all 7 CI jobs green. Published package
verified by `npx`-ing it cold from an empty directory: 1.9s to handshake, 30
read-only tools, 7 resources. Worker verified against the live endpoint rather
than the deploy output: `/mcp` 401 `invalid_token`; hostile `Origin` 403;
`claude.ai` `Origin` 401; HSTS, `referrer-policy`, and `nosniff` present;
`/.well-known/oauth-authorization-server` 200.

**Left off at**: npm and the Worker are both live. The connector cannot
complete a connection yet.

**Open questions**:

- NEW, blocking the connector: `WAVE_CLIENT_ID` and `WAVE_CLIENT_SECRET` are
  unset. They require an OAuth application created at `developer.waveapps.com`
  with redirect URI `https://wave.amesvt.com/callback`, which needs a Wave
  login. Until then `/authorize` fails at the redirect and no session can
  authenticate.
- NEW: the OAuth scope names in `worker/src/wave-oauth.js` are a reading of
  Wave's documentation and are unverified, since verifying them needs a
  registered app. An invalid-scope error at the authorize redirect points here
  first.
- Still open: no mutation has run against a live Wave account. Schema-valid and
  unit-tested is not the same as exercised.
- Still open: `evaluation/evaluation.xml` carries placeholder answers, for the
  same reason.
- Still open: the Dockerfile is unbuilt; Docker is not installed on the
  authoring machine.

---

## 1.0.0 (2026-07-27)

First release of the standalone repository.

**Origin.** Started as a fork of
[vinnividivicci/wave_mcp](https://github.com/vinnividivicci/wave_mcp), a
Python server with 9 tools built around one workflow. That fork was extended to
cover Wave's full API, then rewritten here in Node ESM to match the conventions
of the other MCP servers in this fleet.

**Coverage.** Wave publishes no complete API reference, and the docs site
returns 403 to automated fetches. The surface was instead derived by
introspecting `https://gql.waveapps.com/graphql/public`, which permits
unauthenticated introspection. That yielded 224 types and the authoritative
list: 42 mutations, 11 root queries, 17 business sub-resources. All are
covered.

**Verification without credentials.** Wave validates a GraphQL document and
coerces its variables before it checks authentication, so an unauthenticated
request distinguishes a valid query (`UNAUTHENTICATED`) from a broken one
(`GRAPHQL_VALIDATION_FAILED`). `scripts/smoke-validate-graphql.mjs` exploits
that to schema-check all 64 documents in CI with no token, which catches a
field Wave renames before a user does.

**Write gating.** Wave can email customers and permanently delete records.
Write tools are not registered at all unless `WAVE_ALLOW_WRITES=1`, so a
default install advertises 30 read-only tools and a model cannot invoke a
write tool by guessing its name.

**Retry budget.** Codex CLI kills a tool call at 60 seconds
(`tool_timeout_sec`). An earlier design could retry past that and surface a
client-side timeout instead of Wave's actual error. Requests now carry a total
budget, default 50 seconds, and abandon any retry that cannot finish inside it.

**Amount handling.** Money is sent as strings so binary-float rounding cannot
reach the ledger, and balance checks compare integer minor units. The one
exception is `moneyDepositTransactionCreate`, which Wave types as `Float`.

**Dropped from the original.** Its account matcher carried a hardcoded rule for
apartment numbers 142 through 146, specific to that author's rental properties,
which would silently mis-categorize anyone else's income. The generic scoring
is kept; the hardcoded rule is not, and the matcher now refuses to guess below
55% confidence rather than defaulting to the first account.

**Known gaps.** No tool has been exercised against a live Wave account: every
query is schema-valid and every code path unit-tested, but the mutations have
not run against real data. The evaluation set in `evaluation/` carries
placeholder answers for the same reason.
