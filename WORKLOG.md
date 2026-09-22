# Worklog

## Open items

- Delete the dangling `v1.0.4` tag on the remote or leave it; it published nothing and nothing depends on it (since 2026-08-27; still on the remote on 2026-09-22).
- `wave://health` probes Wave on every read with no rate limiting of its own; left alone pending evidence that any host polls resources aggressively (since 2026-08-26).
- Another agent may still hold the 1.0.3 observability branch and would reintroduce the response cache if it resumes from its own state (since 2026-08-26) (unverified).
- Upstream marks `McpAgent` feature-frozen in favor of a `createMcpHandler` factory; migrating is future work, not urgent (since 2026-08-26).
- No mutation has run against a live Wave account (since 2026-07-27) (unverified).
- `evaluation/evaluation.xml` still carries placeholder answers (since 2026-07-27; the file still says so on 2026-09-22).
- The Dockerfile is unbuilt; Docker is not installed on the authoring machine (since 2026-07-27) (unverified).
- Whether Claude resolves a custom connector's icon only at the registrable domain or holds a server-side icon cache; Oliver chose to wait and re-check rather than recolor the live apex favicon (since 2026-07-30) (unverified).

Notable changes, and the reasoning behind them. For the user-facing summary,
see the release notes.

## 2026-09-22 - Released 1.0.8: hosted default business survives restarts; bare UUIDs accepted

**What changed**: Handed off from a Cowork session with no GitHub access. On
the hosted connector, `wave_set_default_business` succeeded, but a later call
failed with "No business selected." Reproduced live: the default survived an
immediate call, then `wave_auth_status` reported `default_business_id: null` a
few idle minutes later in the same session. The cause is `McpAgent.onStart()`,
which calls `init()` on every Durable Object start, including after an idle
eviction. `init()` rebuilds the server, and the default lived only in the
factory's closure. `createWaveServer` now takes `onDefaultBusinessChange`, and
`WaveMCP` stores the default in Durable Object storage and passes it back on
`init()`. The server also wraps a bare business UUID into the base64 GraphQL
id, which Wave requires. Tracked in issue #4.

**Decisions made**: The handoff guessed that the connector was stateless per
call and suggested documenting "pass business_id every call." Reproduction
ruled that out, so this is a real fix rather than a documentation change. The
`business_id` description still recommends passing the id when calls are
minutes apart, because a new MCP session starts with an empty default. The
default is scoped to the session (one Durable Object per session), not to the
user.

**Verification**: 74 root and 44 Worker tests pass. `smoke:list-tools`,
`smoke:packed`, `smoke:schema` (64/64), `release:check`, and a Wrangler dry run
also pass. CI and the Release workflow passed, and the job logged
`+ @oliverames/mcp-server-for-wave@1.0.8`. The Worker was deployed from this
session with the Cloudflare Global API Key (`CLOUDFLARE_API_KEY` plus
`CLOUDFLARE_EMAIL`), which needs no interactive login, as version
`3b42943c-269e-4e51-9c90-1b4b3402d715`. The three documented probes returned
401, three headers, and 403. Live, `wave_set_default_business` accepted the
bare UUID and answered with the base64 id, which shows the new code is serving. After about
five idle minutes, the window that cleared the default before the fix,
`wave_auth_status` still reported it. That strongly suggests persistence
works, but the Durable Object's eviction is not directly observable, so it is
not proof that a restart happened in that window. npm served 1.0.8 as `latest`
a few minutes after the publish.

## 2026-09-02 - Released 1.0.7 for the AccountSubtype.archivable null; schema coverage audit

**What changed**: Every account read through the hosted connector failed with
"Cannot return null for non-nullable field AccountSubtype.archivable", once per
account. Wave began returning null for `archivable` on some subtypes while the
schema still declares it `Boolean!`, so GraphQL discarded the whole response.
The `AccountFields` fragment now selects `subtype { name value }` only; the
account tools never rendered the other two fields. `Q_ACCOUNT_SUBTYPES` keeps
both, and `wave_list_account_subtypes` still returned them without error today.
Handed off from a Cowork session that could not push.

Also audited the server against the live schema by unauthenticated
introspection. Operation coverage is complete: every Query root field, Business
sub-query, and mutation has a tool. See
`docs/reviews/2026-09-02-wave-schema-coverage-audit.md` for the small
field-level gaps.

**Decisions made**: Dropped the field rather than tolerating the null, because
nothing rendered it. Retitled the `npm version` commit to "Release 1.0.7" to
match 1.0.5 and 1.0.6 before pushing.

**Verification**: 71 root tests and 44 worker tests pass; `smoke:schema`
validates 64/64 documents; `release:check` passes at 1.0.7. The failure was
reproduced on the hosted connector before the fix. Verified live at 14:26 EDT
after Oliver deployed the Worker from an interactive shell: wave_list_accounts
filtered to ASSET returned all 14 accounts, including the Owner Payment
Clearing balance, where the same call had failed minutes earlier. The first two
deploy attempts never uploaded (wrangler needed an OAuth login), which the
Cloudflare bundle confirmed: it still carried the old fragment and version
1.0.0 until the third attempt.

**Left off at**: v1.0.7 is tagged and pushed, but the Release workflow failed
at `npm publish` with a 404 on PUT, which is npm's response to an invalid
token. The 1Password "npm Publish Token" also returns 401 to `npm whoami`, so
the `NPM_TOKEN` repository secret needs a fresh granular token, then
`gh run rerun 33648390679`. The Worker is deployed and verified.

**Open questions**: The dangling local v1.0.4 tag went to the remote with this
push and its Release run failed at the registry check, as expected. Delete
`v1.0.4` on the remote or leave it; nothing depends on it. NEW.

---

## 2026-08-27 - Released 1.0.5 and 1.0.6; fixed the version hook and a Node 18 crash

**What changed**: npm already carried 1.0.3 with no matching git tag, so the
repo, the tag, and the registry disagreed. Cutting 1.0.4 exposed the cause: the
npm `version` hook's `git add` list omitted `worker/src/brand-assets.js`, so
`sync:plugin` wrote the new hosted `REMOTE_SERVER_INFO` version into the working
tree while the release commit and tag went out without it. CI failed
release:check:registry after v1.0.4 was already pushed. Commit `5a5886c` adds
the file to the hook. 1.0.5 carried the content forward.

1.0.6 then fixed a real defect: `randomHex` called
`globalThis.crypto.getRandomValues` unguarded while `engines` declares
`node >=18`, where that global is not exposed. Every traced request threw
"Cannot read properties of undefined (reading 'getRandomValues')", and the CI
matrix had been red on its 18.x leg. It now falls back to `node:crypto`'s
WebCrypto instance. Line 1520 had already guarded correctly; line 100 had not.

**Decisions made**: Carried forward to 1.0.5 rather than moving the pushed
v1.0.4 tag. Remote tag deletion is destructive and the additive path cost only a
version number.

**Verification**: 71 tests pass. `release:check` reports consistency for each
version. The Node 18 fallback was verified by deleting `globalThis.crypto` and
confirming the module still imports. npm latest is 1.0.6 and both GitHub
releases exist.

**Left off at**: Released and clean at 1.0.6.

**Open questions**: v1.0.4 remains as a tag that published nothing. Harmless,
but worth deleting if the dangling tag is confusing. NEW.

---

## 2026-08-26 - Reviewed and repaired the 1.0.3 observability work; response cache removed

**Context**: A second agent had produced an uncommitted 1.0.3 branch adding a
response cache, pino logging, granular error types, a health resource, and
trace-context propagation. This session reviewed it, then fixed it on Oliver's
instruction to rip out the cache and repair the rest. Note the file was being
edited concurrently while the review ran, so the review is pinned to the
index.js snapshot at 16:39:12 (md5 0717db3c). A rescan after the other agent
finished found it had installed pino and written a CHANGELOG but changed no
code.

**What changed**: Seventeen findings, eight blocking. The full review, the
rescan, and a resolution table are in
`docs/reviews/2026-08-26-uncommitted-observability-cache-review.md`.

**The cache was removed, not repaired**. It keyed on the GraphQL document and
its variables with no tenant identity in the key, while `worker/src/wave-mcp.js`
calls `createWaveServer` once per Wave user against a module-level singleton.
Two users sharing an isolate could therefore read each other's accounting data,
and queries carrying no distinguishing variables (`wave_list_businesses`,
`Q_USER`) collided immediately. Nothing invalidated on writes either, so a
freshly created invoice would not appear in a subsequent list for the full 60s
TTL. Both cache tools went with it, restoring the 74-tool count.

**pino replaced with a dependency-free stderr logger**. pino defaults to
stdout, which is the MCP stdio JSON-RPC channel, and `waveFetch` logged on
every request, so each Wave call would have corrupted the protocol stream. pino
also cannot run under `nodejs_compat` in the worker and was constructed outside
the `IS_CLOUDFLARE_WORKERS` guard. It was additionally passed a numeric `level`
where it expects a level name. The replacement writes JSON lines to stderr and
now sits below the `SERVER_VERSION` declaration it reads, fixing an import-time
TDZ `ReferenceError` that had been failing the entire test suite.

**Trace IDs were always all-zeros**: `generateTraceId` allocated a Uint8Array
and never called `getRandomValues`, and the W3C spec rejects an all-zero
trace-id. Both trace-id and parent-id now come from the CSPRNG.

**One further defect found while fixing**: the same diff added the `Wave*Error`
classes to the module-level `__testables` export, but those classes are declared
inside `createWaveServer`. That is an unconditional `ReferenceError` at import,
visible only once the pino failure stopped masking it. They remain on the
`internals` object `createWaveServer` returns, where `WaveError` already was.

**Decisions made**: Caching is not categorically rejected, but it may only
return scoped to reference data (accounts, currencies, countries, account
types), keyed per identity, and held inside `createWaveServer` rather than at
module scope. Transactional reads should not be cached in an accounting server
at all. The `src/` TypeScript scaffolding and `tsconfig.json` were trashed
rather than fixed: nothing imported them, `src/types/index.ts` had a broken
relative path, there is no typescript dependency or tsc script, and the
tsconfig repeated nine options and included `noUnusedVariables`, which is not a
compiler option. A TypeScript migration should start deliberately.

**Documentation**: CHANGELOG.md was rewritten. The version the other agent
wrote claimed "Fixed: Cache invalidation on mutations" when `invalidate` had
zero call sites, described caching as scoped to reference data when no
allowlist existed, and advertised W3C trace propagation that emitted an invalid
header. The removed cache is now recorded under Notes with the reason. README
gained the two new env vars and had its resource count corrected from 7 to 8,
which `wave://health` had silently invalidated.

**Verification**: 71 root tests (four new: stderr-only logging, level filtering
with child bindings, traceparent validity, and that identical reads still both
reach the API), 44 worker tests, smoke:list-tools (8 resources, 30 read-only,
74 with writes), smoke:schema 64/64, smoke:packed responding over stdio at
1.0.3, and release:check clean after `npm run sync:plugin` resolved nine
version mismatches.

**Left off at**: Clean tree, `main` in sync with origin at 68df253. Nothing in
flight.

**Open questions**:

- NEW: another agent may still hold this branch checked out. If it resumes from
  its own state it will reintroduce the cache. Worth telling it the work landed.
- NEW: `wave://health` probes Wave on every read with no rate limiting of its
  own. Harmless for a human-paced client, but a host that polls resources
  aggressively would burn Wave's roughly two-concurrent-request budget. Left
  alone pending evidence that any host does this.

---

## 2026-08-26 - Deferred items cleared: worker stack upgraded, structured output, delete hardening

**Context**: The 2026-08-25 pass deferred three items. All three are now done
to the extent verifiable without production credentials.

**Worker dependencies upgraded**: `@cloudflare/workers-oauth-provider`
0.8.1 -> 0.10.3, `agents` 0.17.4 -> 0.21.0, and the MCP SDK pinned at 1.30.0
as a direct dependency (agents made it a peer). API compatibility was checked
against the installed type definitions first: every constructor option we use
survived, `McpAgent.serve/serveSSE` are unchanged, and `init()`/`props` work
as before. Note: upstream now marks McpAgent feature-frozen in favor of a
createMcpHandler factory; migrating is future work, not urgent.

**Strict resource pinning adopted**: the provider enforces RFC 8707 properly
now, so CONNECTOR_RESOURCE_METADATA gained `resource:
https://wave.amesvt.com/mcp`. Grants and token audiences pin to that URL,
clients that omit the parameter default to it instead of staying unbound, and
pre-upgrade grants inherit it rather than breaking. This follows the
maintainer recommendation and the MCP authorization spec's resource-indicator
requirement.

**Local end-to-end verification** (wrangler dev, miniflare -- the full Worker
including Durable Objects): 24 checks covering dynamic client registration,
the consent flow with signed payload, tamper rejection, single-use callback
state, S256-only PKCE enforcement, strict resource metadata advertising,
origin gating on both transports, and the unauthenticated /mcp challenge.
Plus 3 checks for the new delete limiter. The one thing local verification
cannot cover is the Wave login leg itself, which needs Oliver's credentials.

**Structured output started**: wave_auth_status now declares an outputSchema
and returns structuredContent alongside its JSON text block (spec 2025-06-18).
The SDK validates every successful response against the schema server-side.
It is deliberately the only tool with one: its shape is stable and
machine-consumed, while entity tools return markdown-or-Wave-JSON by design.
Writing schemas for ~100 dynamic shapes would be churn without a consumer.
The pass also fixed a latent gap the test caught: registerTool was silently
dropping any outputSchema it was given.

**Delete endpoint hardened**: POST /delete is rate limited to five attempts
per hour per client IP, counted in the OAuth state Durable Object (storage
input gates make the counter race-free) keyed by a hashed CF-Connecting-IP.
The public user-wide revoke UX is unchanged; scripted token-wipe sweeps get
expensive. The residual risk is unchanged in kind -- anyone can still revoke
the owner's tokens five times an hour -- but abuse now costs time. A
Cloudflare WAF rate-limit rule would add network-level defense if wanted.

**Smaller fixes**: consent payloads moved from btoa to base64url over UTF-8
bytes, so a non-Latin1 client id or redirect URI cannot crash /authorize;
wave_auth_status-style detail addition -- estimate detail views now include
"Last sent via"; base64urlDecode exported for the round trip.

**Verification**: 67 of 67 root tests (one new, driving a real MCP session
over InMemoryTransport), 44 of 44 worker tests (five new), smoke:list-tools
unchanged, release:check clean, and the two wrangler-dev E2E suites above.

**Blocked, needs Oliver**: production deploy. No Workers-deploy credential
exists on this machine (no cached wrangler OAuth token; no matching item in
1Password beyond Pages/R2/scoped tokens). To ship: `wrangler login`, or add a
Cloudflare API token item with Workers deploy permissions to 1Password and map
it in ~/.claude/.env. After deploy, re-run both probe suites against the live
host, then complete one real Wave authorization to close the loop. Rollback
is `npx wrangler rollback` in worker/.

---

## 2026-08-25 - Improvement pass: security bumps, API-doc accuracy, honest pagination

**Context**: Second pass over the codebase, this time against live sources:
Wave's published API reference, the MCP specification, and current dependency
advisories.

**Security**: `fast-uri` 3.0.0-3.1.4 (high, CVE-2026-18446: parser/host
desync vs WHATWG URL) and `hono` <=4.12.33 (moderate: four middleware
advisories) were present in both dependency trees as transitives of the MCP
SDK. The CI gate audits at `--audit-level=high`, so the next push would have
failed. Lockfiles updated within existing ranges; both trees now report zero
vulnerabilities (hono 4.13.4, fast-uri 3.1.6).

**Version drift fixed**: the hosted connector's MCP handshake reported
`REMOTE_SERVER_INFO.version` "1.0.0" forever while the package moved to 1.0.2.
`sync:plugin` now rewrites it alongside SERVER_VERSION, and `release:check`
fails when they disagree (negative-tested by hand). It now reports 1.0.2.

**API accuracy**, each sourced from Wave's live schema reference:

- Dropped `Money.raw` from MoneyFields: Wave deprecated it because it can
  overflow; `minorUnitValue` was already selected and nothing read `.raw`.
- Dropped `InvoiceItem.price` from InvoiceFields: deprecated in favor of
  `unitPrice`, which the detail views already use.
- Corrected `wave_list_invoices`'s `invoice_number` description: Wave applies
  a substring match ("12" matches 112 and 120), not an exact match.
- Noted on all three money-transaction tools that Wave marks them BETA and
  they require classic accounting to be disabled.
- Noted on `wave_create_deposit_transaction` that Wave has deprecated its
  underlying mutation ("not available for public use at this time") and that
  split-line money transactions are the preferred shape going forward.

**Honest pagination**: a fetch_all walk stopped by the 500-page safety
ceiling used to report `fetched_all: true`, rendering "Returned all N
record(s)" for a list that could be incomplete. walkPages now returns
`truncated: true`, `fetched_all` is only true for complete sweeps, and the
markdown footer warns and points at page-by-page retrieval instead.

**Worker robustness**: `fetchWaveUser` now turns a non-JSON identity response
(an HTML error page from an outage or proxy) into a clear message carrying
the HTTP status, instead of a bare SyntaxError mid-OAuth-flow.

**Verification**: 66 of 66 root tests pass (four new), 40 of 40 Worker tests
pass (one new), smoke:list-tools unchanged at 30 read-only / 74 write tools,
and all 64 GraphQL documents validate against the live Wave schema via
smoke:schema -- the direct proof that dropping the two deprecated fields is
safe today.

**Deferred deliberately**:

- `agents` 0.17.4 -> 0.21.0 and `workers-oauth-provider` 0.8.1 -> 0.10.3.
  The oauth-provider changelog between those versions changes live OAuth
  behavior (strict RFC 8707 resource policy, CIMD fetch errors, PKCE
  defaults aligned to MCP 2026-07-28) and needs a deploy plus a real
  end-to-end authorization flow to verify safely. Worth doing soon; not doable
  blind in a code-only pass.
- MCP structured tool output (`outputSchema`/`structuredContent`, spec
  2025-06-18): a poor fit while every tool offers a markdown/json dual
  format; revisiting would mean one schema per tool.
- The `/delete` page trusts anyone who can fetch their own CSRF token, so it
  remains an unauthenticated user-wide revoke by design. Documented trade-off;
  changing it means deciding what binds the form to the owner.

---

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

## Earlier history (before 2026-08-23)

- 2026-07-30 - Found why Claude showed the wrong connector icon: Claude resolves a custom connector's icon at the registrable domain, and `https://amesvt.com/favicon.ico` returned the Cloudflare Pages SPA fallback (200, `text/html`), so the resolver took amesvt.com's green favicon; the six-frame ICO was not why TinyFish worked (it is on an apex domain). Shrank `/favicon.ico` from 370,070 to 4,286 bytes (one 32x32 frame) and led with a new `/favicon.svg` wrapping the 96px PNG; a test fails if the ICO passes 10 KB. Gotcha: compare ETags (the SHA-256 of the body), not `curl` byte counts. A retest after full sign-out and reconnect was still negative; the analysis is in ynab-mcp-server's WORKLOG. Deployed `ddd6563e-cecb-441c-92b4-63ae1404682b`.
- 2026-07-29 - Added hosted connector icon discovery: reproducible Worker icons from `assets/icon.png` (PNGs 16 to 256 px, Apple touch icon, multi-size ICO), served with cache and cross-origin headers and included in MCP server metadata (commit `7f695e0`, deployment `7c640c52-43ff-4ab7-9f72-7701a69bbae3`). Then expanded the ICO to six entries to mimic TinyFish, an experiment reversed on 2026-07-30 (deployment `ebcf5228-2b5b-4c71-8fd4-6b8be2654921`).
- 2026-07-27 - Released 1.0.2 after the consistency gate refused v1.0.1: the `version` script's `git add` list omitted `index.js`, leaving `SERVER_VERSION` at 1.0.0, and `index.js` now leads the list. Decision: v1.0.1 stays a dead tag, because re-pointing a pushed tag is worse than skipping a patch number. Verified by a cold `npx` handshake (serverInfo 1.0.2, dist-tag latest=1.0.2).
- 2026-07-27 - Corrected write scopes and stored tokens per connection. Wave's write scopes are `resource:write` plus `invoice:send` and `estimate:send`, not `resource:create`. Gotcha: Wave's authorize endpoint validates scopes only on an authenticated session, so logged-out curl probes accept any scope string. Tokens now live at `wave:token:<userId>:<tokenKey>`, so a read-only connection no longer downgrades a write-enabled one; /delete removes all of a user's records by prefix.
- 2026-07-27 - Finished the hosted OAuth setup: the `invalid_request` / "Invalid client_id parameter value" error came from unset `WAVE_CLIENT_ID` and `WAVE_CLIENT_SECRET` (`client_id=undefined`). Credentials live in 1Password (`op://Development/Wave MCP Connector`) and were piped into `wrangler secret put`. The ten read scopes were accepted live. `ALLOWED_WAVE_USERS` (Wave user id or email) is checked at `/callback` and on every `WaveMCP.init()`, and is a Worker secret because the repo is public; empty means unrestricted.
- 2026-07-27 - Published 1.0.0 to npm, deployed the Worker at `wave.amesvt.com`, and made the repo public. Caught before publish: npm installs the bin as a relative symlink, so the autostart guard never matched `import.meta.url`; fixed with `realpathSync` on both sides, and `scripts/smoke-packed-install.mjs` now exercises the packed artifact in CI and the release gate. Decisions: KV namespace `WAVE_OAUTH_KV`, because the YNAB connector owns `OAUTH_KV`; Wave's official app icon under nominative use, brand colors `#328ff8` and `#76c3fc`; CI on `checkout@v7`, `setup-node@v6`, `gitleaks-action@v3`.
- 2026-07-27 - 1.0.0 origin and design: forked from [vinnividivicci/wave_mcp](https://github.com/vinnividivicci/wave_mcp) (Python, 9 tools) and rewritten in Node ESM. Coverage comes from unauthenticated introspection of `https://gql.waveapps.com/graphql/public` (224 types, 42 mutations, 11 root queries, 17 business sub-resources). Wave validates a document before checking auth, so `scripts/smoke-validate-graphql.mjs` schema-checks all 64 documents with no token. Write tools register only with `WAVE_ALLOW_WRITES=1`; requests carry a 50-second total budget because Codex CLI kills a tool call at 60 seconds; money is sent as strings except `moneyDepositTransactionCreate` (`Float`); the matcher refuses below 55% confidence and drops the original's hardcoded apartment 142-146 rule.
