# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.4] - 2026-08-27

### Fixed

- Corrected the resource count stated in the README.

### Changed

- Tagged release restoring agreement between the git tag, `package.json`, and
  the published npm version. 1.0.3 reached npm without a matching tag, so no
  GitHub release existed for it.

## [1.0.3] - 2026-08-26

### Added

- **Structured logging**: JSON lines on stderr, with levels and child loggers.
  Set `WAVE_LOG_LEVEL` to `debug`, `info`, `warn`, `error`, or `silent`
  (default `info`). stderr is deliberate: stdout carries the MCP stdio JSON-RPC
  stream and must stay clean. No new dependency, so this runs unchanged under
  Cloudflare Workers.
- **Granular error types**, so callers can branch on failure mode rather than
  parse message text: `WaveValidationError`, `WaveRateLimitError` (carries
  retry-after), `WaveNotFoundError`, `WaveTimeoutError`, `WaveServerError`
  (carries status), and `WaveNetworkError` (carries cause). Exposed on the
  `internals` object returned by `createWaveServer`.
- **Health check resource** `wave://health`: version, live Wave API
  connectivity, uptime, write gating, credential presence, and default
  business. The API probe is a real request on every read, so a degraded API
  shows up immediately.
- **W3C Trace Context propagation**, off by default, enabled with
  `WAVE_TRACING_ENABLED`. Each Wave request carries a `traceparent` header
  whose trace-id and parent-id come from the CSPRNG, and the same trace ID
  appears in the logs for that request.

### Changed

- `waveFetch` emits structured logs and attaches trace context.
- Rate limits, 5xx responses, transport failures, budget exhaustion, and
  GraphQL `NOT_FOUND` now raise the specific error types listed above rather
  than a bare `WaveError`. All of them still extend `WaveError`, so existing
  `catch` blocks keep working.

### Notes

An in-memory response cache was prototyped during this cycle and removed before
release. It was keyed only on the GraphQL document and its variables, with no
tenant identity in the key, while the hosted connector calls `createWaveServer`
once per Wave user against a module-level cache. It also had no invalidation on
writes, so a freshly created invoice would not appear in a subsequent list.
Neither is acceptable for accounting data, and caching may return later scoped
to reference data only.

## [1.0.2] - 2026-07-27

### Added

- Initial release with complete Wave API coverage
- 74 tools (30 read, 44 write-gated)
- 42 mutations, 11 queries, 7 resources
- 1Password token lookup support
- Hosted OAuth connector (Cloudflare Worker)

## [1.0.1] - 2026-07-20

### Added

- Fork from vinnividivicci/wave_mcp
- Complete rewrite in single-file architecture
- Write gating via `WAVE_ALLOW_WRITES`
