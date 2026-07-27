# Worklog

Notable changes, and the reasoning behind them. For the user-facing summary,
see the release notes.

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
