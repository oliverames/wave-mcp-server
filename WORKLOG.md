# Worklog

Notable changes, and the reasoning behind them. For the user-facing summary,
see the release notes.

## 2026-08-25 - Comprehensive bug-fixing pass: five defects, four in the shared server

**Context**: A full read-through of `index.js` (5,845 lines) and every module
under `worker/src/`, with each suspected defect reproduced against the live
code before fixing.

**Fixed**:

1. `deleteAllTokenRecords` swept sibling user ids. The KV list used the prefix
   `wave:token:<userId>` with no trailing colon, so deleting user-1's records
   also deleted user-10's. Reproduced with a mock KV before fixing; the list
   key now goes through `tokenRecordKey(userId, "")`, which carries the colon.
2. Auto-generated `externalId` values collided within one millisecond. Wave
   dedupes on externalId, so two rapid creates shared an id and the second
   was silently dropped as a duplicate. Measured: 199,843 collisions across
   200,000 tight-loop generations. A random tail now follows the timestamp;
   caller-supplied ids are still preserved untouched.
3. A stalled response body hung a tool call indefinitely. The abort timer was
   cleared once headers arrived, but `response.text()` ran afterwards, so a
   server that sent headers and never delivered bytes would hang past both
   the per-attempt timeout and the total budget. The body is now read inside
   the abort window, and a body-level abort flows into the existing retry and
   error paths.
4. `scoreAccount`'s startsWith branch was unreachable: includes was checked
   first at a higher score, so "Office Supplies" scored identically whether
   the category opened the name or appeared mid-name. Specificity now ranks:
   exact 1.0, startsWith 0.95, mid-name 0.9. Both remain above the 0.55
   confidence floor, so only ranking between candidate accounts changes.
5. Malformed JSON from Wave surfaced as a bare SyntaxError. It is now a
   sanitized `WaveError` carrying the HTTP status and a 200-character body
   snippet, consistent with every other transport failure.

**Verification**: 62 of 62 root tests pass (four new), 39 of 39 Worker tests
pass (one new), `smoke:list-tools` reports all 104 tools registered,
`release:check` is clean, and `node --check` passes. The stalled-body test
stubs `fetch` with a signal-wired stream matching undici's behavior, verified
against a real stalling HTTP server first. Note for future transport tests:
the server floors `WAVE_TIMEOUT_MS` at 1,000 ms via `envNumber`.

---

## 2026-07-30 - Found why Claude showed the wrong connector icon

**Context**: Reverses the 2026-07-29 six-frame ICO experiment, which was a guess
at TinyFish's shape rather than a diagnosis.

**Root cause, measured**: The green icon Claude showed for this connector was
never Wave's logo. It was `amesvt.com`'s own favicon, a green rounded square
with a white ring, served from `assets.amesvt.com`. Every `*.amesvt.com`
connector rendered that same mark. Claude resolves a connector icon at the
registrable domain, and `https://amesvt.com/favicon.ico` returned the Cloudflare
Pages SPA fallback with `HTTP 200` and `content-type: text/html`. A 200 ends the
fallback chain, so the resolver parsed the landing page and took the
cross-origin favicon declared there. The correct Wave artwork was being served
at `/assets/wave-icon-v1.png` the whole time and was never fetched.

**Also settled**: the six-frame ICO was not what made TinyFish work. TinyFish is
on `tinyfish.io`, an apex domain, so it has no registrable-domain fallback to
lose to. Matching its frame count only produced a 370 KB file.

**What changed**: `/favicon.ico` dropped from six uncompressed frames
(370,070 bytes) to a single 32x32 frame (4,286 bytes), matching sosumi.ai, whose
connector icon does render in Claude. Added `/favicon.svg` and made it the
leading `rel="icon"` with the ICO as `alternate icon`. The head now advertises
four icon links instead of nine.

**Decisions made**: Wave's icon is raster-only, so `/favicon.svg` wraps the 96px
PNG in an SVG `<image>` rather than being true vector art. That keeps the
correct logo available to resolvers that ask for SVG first, at 6,210 bytes.
Flagged in the generator so nobody mistakes it for a real vector later. Kept the
larger PNG routes served and only removed them from the head.

**Verification**: 38 of 38 Worker tests pass, including a new bound that fails
if `favicon.ico` grows past 10 KB. Deployed as version
`ddd6563e-cecb-441c-92b4-63ae1404682b`. The live `/favicon.ico` ETag is
`sha256-131b1e2c6dc522dbdcbe5ffa409229ace04a26aec7dc456f06f1d019ec68c8b2`,
matching the generated asset byte for byte. Compare ETags rather than `curl`
byte counts when checking what is live; the ETag is the SHA-256 of the body.

**Retested, negative**: with the apex fixed and `workspace.amesvt.com` serving
a correct same-origin mark, Claude still renders the green amesvt icon after a
full sign-out, disconnect and reconnect. A correct subdomain icon does not win.

**Open questions**: Either Claude resolves a custom connector's icon only at
the registrable domain, or it holds a server-side icon cache a client
reconnect does not clear. The full analysis, the supporting evidence, and the
decisive test that was deliberately not run live in ynab-mcp-server's WORKLOG
under the same date. Oliver chose to wait and re-check rather than recolor the
live apex favicon to settle it now.

---

## 2026-07-29 - Match TinyFish favicon structure for Claude testing

**What changed**: Expanded the hosted favicon from four to six ICO entries at 16, 32, 48, 64, 128, and 256 pixels. The favicon response now uses revalidation caching while retaining its ETag.

**Decisions made**: Reproduced only the observable TinyFish differences. This is an experiment, not evidence that Claude supports custom connector favicon branding.

**Verification**: Parsed all six generated and deployed ICO entries. All 37 Worker tests and 58 root tests pass, release consistency and the Wrangler dry run pass, GitHub Actions passes, and Cloudflare deployment ebcf5228-2b5b-4c71-8fd4-6b8be2654921 is live.

**Left off at**: Disconnect and add Wave Financial again in Claude to test whether it refreshes the connector card.

**Open questions**: Whether Claude reads the origin favicon for custom connectors remains undocumented.

---

## 2026-07-29 - Add hosted connector icon discovery

**What changed**: Added reproducible Worker icon generation from the canonical `assets/icon.png`, including 8-bit PNGs at 16, 32, 48, 64, 96, 128, and 256 pixels, an Apple touch icon, and a multi-size ICO. The Worker now serves those assets with cache and cross-origin headers, advertises them from its public pages, and includes the versioned 256-pixel icon in MCP server metadata.

**Verification**: All 37 Worker tests and all 58 root tests pass, the release consistency check and Wrangler dry run pass, and the live Cloudflare deployment serves the branded PNG routes while `/mcp` remains authentication-protected. Deployment version: `7c640c52-43ff-4ab7-9f72-7701a69bbae3`.

**Left off at**: Commit `7f695e0` is on `main`; this worklog entry records the completed deployment.

---

## 2026-07-27 - 1.0.2 released; the version script was silently dropping index.js

**What changed**: `@oliverames/mcp-server-for-wave@1.0.2` is on npm via the
tag-triggered release workflow, and the Worker was redeployed so the hosted
`serverInfo` reports the same version.

**The v1.0.1 release failed by design.** The workflow's consistency gate
refused to publish: `SERVER_VERSION` in `index.js` still read 1.0.0.
`sync-plugin-metadata.mjs` rewrites that constant, but the package.json
`version` script's `git add` list never included `index.js`, so every bump
committed the manifests and left the constant behind. The gate rerunning all
checks on the tag -- built on the day-one lesson that a tag can be pushed
without a passing CI run -- is the only reason an inconsistent package never
reached npm. `index.js` now leads the staged list.

**Tag hygiene**: v1.0.1 stays where it is, a dead tag on the failed commit.
Nothing was published under it, and re-pointing a pushed tag is worse than
skipping a patch number. 1.0.2 went out clean: all release gates green,
verified post-publish with a real `npx` handshake from an empty directory
(serverInfo 1.0.2, registry dist-tag latest=1.0.2).

**Left off at**: hosted connector fully working end to end. Read and write
authorization paths both verified live. Remaining known gaps: no mutation has
run against live Wave data, and `evaluation/evaluation.xml` still carries
placeholder answers.

---

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
