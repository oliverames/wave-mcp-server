# Review: uncommitted observability + cache work

Reviewed 2026-08-26 ~16:40 local, against the working tree (uncommitted).
Baseline commit: 61c8b3d. Scope: `index.js` (+394/-13), `package.json`,
plus untracked `tsconfig.json`, `src/types/index.ts`, `src/errors/WaveErrorTypes.ts`.

**Caveat:** `index.js` changed underneath this review (mtime 16:39:12, while the
first read was at ~16:38). Another session or process was editing concurrently.
The first read showed a hand-rolled `Logger` class; the final read showed pino.
Findings below describe the 16:39:12 snapshot.

## Verdict

Not shippable. The branch does not import, the test suite does not run, and the
central feature (response caching) is unsafe for this server's hosted
multi-tenant deployment.

## Blocking defects

### 1. Module does not load: TDZ on `SERVER_VERSION`

`index.js:37` reads `SERVER_VERSION` inside the pino `base` option, but
`SERVER_VERSION` is declared at `index.js:74`. Top-level `const` is in the
temporal dead zone, so import throws
`ReferenceError: Cannot access 'SERVER_VERSION' before initialization`.

Verified with an isolated repro of the same ordering.

### 2. Dependency not installed; whole test suite fails

`node --test test/unit.test.mjs` -> 1 test, 1 fail,
`Cannot find package 'pino'`. `pino` was added to `package.json` dependencies
but not installed. Every test fails at import, so nothing in the suite is
currently exercised.

### 3. pino writes to stdout, which is the MCP stdio JSON-RPC channel

`pino({...})` with no destination defaults to `process.stdout`. This server's
primary transport is `StdioServerTransport`, which uses the same fd for
JSON-RPC framing. `waveFetch` calls `logger.info(...)` on every request at the
default level, so every Wave API call injects a non-JSON-RPC line into the
protocol stream and corrupts the session.

The pre-existing code was careful about this. Log output has to go to stderr
(`pino(pino.destination(2))`) or be suppressed on the stdio path.

### 4. pino is not Cloudflare Workers compatible

`index.js` is imported by `worker/src/wave-mcp.js`, and the file's own header
comment states it serves "both the local stdio process and the hosted
Cloudflare Worker". pino depends on `sonic-boom` / `thread-stream` and Node
stream internals that `nodejs_compat` does not fully provide. The existing
`IS_CLOUDFLARE_WORKERS` guard is not applied to the logger, which is
constructed unconditionally at module scope.

### 5. `level` is passed as a number, not a level name

`LOG_LEVELS` maps to numbers and `LOG_LEVEL` is passed as `level: 30`. pino
expects a level *name* string. `silent: Infinity` is not a valid pino level at
all. An unrecognised `WAVE_LOG_LEVEL` also silently falls back rather than
warning.

### 6. Response cache is not keyed by identity, in a multi-tenant server

`const responseCache = new ResponseCache()` sits at `index.js:260`, module
scope. `createWaveServer` starts at `index.js:909`, and the hosted worker calls
it per user with a per-user token:

```js
// worker/src/wave-mcp.js:22
const { server } = createWaveServer({
  getAccessToken: () => getFreshAccessToken(this.env, waveUserId, tokenKey),
```

The cache key is `JSON.stringify({ query, variables })`. It ignores the access
token, the Wave user, and the business. Any two server instances sharing a
module scope therefore share cached accounting data. Queries that carry no
distinguishing variables (`wave_list_businesses`, `Q_USER`) collide
immediately.

Whether two Durable Object instances actually colocate in one isolate is a
Cloudflare implementation detail. The cache should not depend on that detail
being favourable. At minimum the key must include a token or user identity, and
the cache should be per-`createWaveServer` rather than module-level.

### 7. No cache invalidation on writes

Nothing calls `responseCache.invalidate()`. `ResponseCache.invalidate` is dead
code. Create an invoice and immediately list invoices, and the list is stale for
up to `WAVE_CACHE_TTL_MS` (default 60s).

This is an accounting server. Reporting a balance or invoice list that omits a
write the same agent just made is a correctness failure, not a performance
tradeoff. A 60s blanket TTL on every read is too aggressive for transactional
data even with invalidation in place. Reference data (accounts, currencies,
countries, account types) is the defensible thing to cache.

### 8. Health check reads its own cache

`wave://health` calls `waveFetch(Q_USER)` to probe API connectivity, but
`Q_USER` is a read and is now cached. After the first probe the health check
reports `healthy` from memory for the TTL window without touching Wave. It can
report healthy while the API is down.

## Correctness problems, non-blocking

### 9. Trace IDs are always all-zeros

`generateTraceId` allocates `new Uint8Array(16)` on the `crypto.getRandomValues`
branch but never calls `getRandomValues` on it. Verified: the produced trace-id
is `00000000000000000000000000000000`. The logic is also inverted, since the
fallback branch (`Math.random`) is the only one that yields entropy.

W3C Trace Context additionally forbids an all-zero trace-id, so the
`traceparent` header sent to Wave is invalid. The span-id uses `Math.random`
against `Number.MAX_SAFE_INTEGER`, giving 53 bits padded to look like 64.

### 10. Read/write detection is string-prefix based

`!query.trim().toUpperCase().startsWith('MUTATION')` decides what to cache.
This works for the current 42 `M_*` documents, but it is fragile: a leading
comment, a `#` line, or a document beginning with a fragment definition would be
misclassified as a cacheable read. Passing an explicit flag from the call site
is safer than sniffing the document text.

### 11. `wave_cache_clear` is write-gated and its `pattern` arg is fake

Registered via `registerWriteTool`, so clearing a local in-memory cache requires
`WAVE_ALLOW_WRITES`. Read-only deployments are the ones most exposed to stale
reads, and they cannot clear it. The tool also advertises a `pattern` parameter,
then ignores it and clears everything, returning
`"pattern filtering not yet implemented"`. Either implement it or drop it from
the schema.

## Loose ends

### 12. Version drift across nine files

`SERVER_VERSION` and `package.json` moved to 1.0.3, nothing else did.
`npm run release:check` fails with nine mismatches, covering all four plugin
manifests, all four marketplace manifests, and
`worker/src/brand-assets.js`. Fix with `npm run sync:plugin`.

### 13. The TypeScript files are dead and would not compile

- `src/errors/WaveErrorTypes.ts` duplicates four error classes that also exist
  in `index.js`. Two definitions of `WaveError` will drift.
- `src/types/index.ts` re-exports from `"./errors/WaveErrorTypes"`, which from
  `src/types/` resolves to `src/types/errors/...`. The path needs `../`.
- Nothing imports either file, there is no `typescript` devDependency, and no
  script runs `tsc`.

### 14. `tsconfig.json` is malformed

Nine options are repeated, `noImplicitAny` seven times and `noUnusedLocals`
five. `noUnusedVariables` appears four times and is not a real compiler option.
The config targets a `src/` tree that holds 130 bytes of unused code, in a
project whose actual source is a 6,300-line `index.js`.

### 15. Dead and unused declarations

`extractTraceContext` is defined and never called. `__logger` is assigned and
never referenced.

### 16. No tests for any of it

`grep -c` for `responseCache|ResponseCache|logger|pino` returns 0 in both
`test/unit.test.mjs` and `worker/test/worker.test.mjs`. The cache TTL, eviction,
hit accounting, and read/write classification are all untested.

## Suggested order of work

1. Decide whether the cache belongs in this server at all (see #6, #7).
2. If yes, move it inside `createWaveServer`, key it on identity, invalidate on
   mutation, and restrict it to reference-data queries.
3. Replace pino with stderr-only logging that respects `IS_CLOUDFLARE_WORKERS`,
   or drop the logger.
4. Fix or remove the trace-context code.
5. Delete `src/` and `tsconfig.json` unless a TypeScript migration is actually
   planned.
6. Run `npm run sync:plugin`, then `npm test` and `npm run release:check`.

---

# Rescan, 2026-08-26 16:43 local

Requested after a second agent finished. `index.js` is byte-identical to the
reviewed snapshot (mtime still 16:39:12, md5 `0717db3c...`). The other agent
changed no code.

What it did change:

- ran `npm install pino` (`package-lock.json` +133 lines, pino 9.14.0 present)
- added `CHANGELOG.md`

**All 16 findings stand, re-verified individually.** Finding 2 (pino not
installed) is resolved as stated, but it was only masking finding 1: the module
still fails to import with
`ReferenceError: Cannot access 'SERVER_VERSION' before initialization`, and
`node --test test/unit.test.mjs` is still 0 pass / 1 fail.

Ordering confirmed for findings 1 and 4: `loggerInstance` is constructed at
line 36, `IS_CLOUDFLARE_WORKERS` is declared at line 72, and `SERVER_VERSION` at
line 74. The logger therefore sits ahead of both the guard it needs and the
constant it reads.

## 17. `CHANGELOG.md` documents work that was not done

The new changelog is not accurate against the code it describes. This repo has
a commit history that values exactly this ("improve: security bumps, API-doc
accuracy, honest pagination"), so the drift is worth naming.

| Changelog claim | Reality |
|---|---|
| Under **Fixed**: "Cache invalidation on mutations (writes bypass cache and don't pollute it)" | `responseCache.invalidate` has 0 call sites. Writes bypassing the cache is not invalidation, and stale reads persist for the full TTL. Also listed under "Fixed" though no cache existed in 1.0.2. |
| "Response Caching ... for read-only operations (accounts, customers, products, sales taxes, etc.)" | No allowlist exists. Every non-mutation document is cached, invoices, payments and balances included. |
| "OpenTelemetry-Compatible Tracing: W3C Trace Context (`traceparent`) header propagation" | The emitted header is `00-00000000000000000000000000000000-<span>-01`. An all-zero trace-id is invalid per the W3C spec, so nothing downstream will accept it. |

The version history section is accurate, and `wave_cache_stats` is correctly
described as read-only.

## Status

Unchanged from the original verdict: not shippable. The blocking list is still
items 1 and 3 through 8, plus 17.

---

# Resolution, 2026-08-26

All 17 findings closed. The cache was removed rather than repaired, on the
owner's call.

| # | Finding | Resolution |
|---|---|---|
| 1 | TDZ on `SERVER_VERSION` | Logger moved below the `SERVER_VERSION` declaration. Module imports. |
| 2 | Tests fail at import | 71 pass, 0 fail. |
| 3 | pino wrote to stdout | Replaced with a dependency-free logger writing JSON lines to stderr. Asserted in test. |
| 4 | pino not Workers-compatible | Dependency dropped. `console.error` works in both runtimes. |
| 5 | Numeric `level` passed to pino | Gone with pino. Levels are compared internally as numbers, never handed to a library. |
| 6 | Cache not keyed by identity | Cache removed entirely. |
| 7 | No invalidation on writes | Cache removed entirely. |
| 8 | Health check read its own cache | Probes Wave live on every read, and now reports the sanitized error on failure. |
| 9 | All-zero trace IDs | `randomHex` seeds both trace-id and parent-id from `crypto.getRandomValues`. Asserted in test. |
| 10 | `startsWith('MUTATION')` sniffing | Gone with the cache. |
| 11 | `wave_cache_clear` write-gated, fake `pattern` | Both cache tools removed. Tool count back to 74. |
| 12 | Nine version mismatches | `npm run sync:plugin`. `release:check` passes at 1.0.3. |
| 13 | Dead TypeScript files | `src/` trashed. |
| 14 | Malformed `tsconfig.json` | Trashed. |
| 15 | Dead declarations | `extractTraceContext`, `__logger`, `TRACE_STATE_HEADER` all removed. |
| 16 | No tests | Four tests added: stderr-only logging, level filtering and child bindings, traceparent validity, and no-cache/no-cache-tools. |
| 17 | Inaccurate changelog | Rewritten. The cache is described under Notes as prototyped and removed, with the reason. |

## One further defect found while fixing

The same diff added the `Wave*Error` classes to the module-level `__testables`
export, but those classes are declared inside `createWaveServer` (line 848+).
That is an unconditional `ReferenceError` at import, which only stayed hidden
because the pino failure in finding 1 threw first. They remain exported on the
`internals` object that `createWaveServer` returns, which is where the
pre-existing `WaveError` export already lived.

## Verification

```
node --test test/unit.test.mjs        71 pass, 0 fail
node --test worker/test/worker.test.mjs   44 pass, 0 fail
npm run smoke:list-tools              8 resources, 30 read-only, 74 with writes
npm run smoke:schema                  64/64 documents valid
npm run smoke:packed                  packed install responds over stdio, v1.0.3
npm run release:check                 OK at 1.0.3
```
