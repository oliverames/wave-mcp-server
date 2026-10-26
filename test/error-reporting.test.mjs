// Sentry reporting must never carry financial data. These tests run the real
// @sentry/node client against a loopback DSN and inspect the raw envelopes.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.WAVE_MCP_NO_AUTOSTART = "1";
process.env.WAVE_DISABLE_AGENT_CONFIG_FALLBACK = "1";
process.env.WAVE_TIMEOUT_MS = "1000";
process.env.WAVE_TOTAL_BUDGET_MS = "5000";
process.env.WAVE_HTTP_RETRIES = "0";
delete process.env.SENTRY_DSN;
delete process.env.WAVE_ACCESS_TOKEN;
delete process.env.WAVE_OP_PATH;

const reporting = await import("../lib/error-reporting.mjs");
const { createWaveServer } = await import("../index.js");

// @sentry/node 11 supports Node 20.19+; older runtimes simply run without reporting.
const [major, minor] = process.versions.node.split(".").map(Number);
const sentrySupported = major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19);
const skip = sentrySupported ? false : "@sentry/node 11 needs Node 20.19 or newer";

// Synthetic financial strings that must never appear in an envelope.
const CUSTOMER = "Synthetic Customer Sentinel";
const AMOUNT = "9876.54";
const MEMO = "synthetic invoice memo 4417";

const envelopes = [];
const sink = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    let body = Buffer.concat(chunks);
    if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body);
    envelopes.push(body.toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});
await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
test.after(() => new Promise((resolve) => sink.close(resolve)));

const enabled = sentrySupported && await reporting.initErrorReporting({
  env: { SENTRY_DSN: `http://publickey@127.0.0.1:${sink.address().port}/1` },
  release: "mcp-server-for-wave@0.0.0-test",
});

function eventsFrom(raw) {
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((item) => item.exception);
}

async function callTool(fetchImpl, name, args) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const wave = createWaveServer({
    getAccessToken: async () => "fake-token-a",
    hasCredentials: true,
    defaultBusinessId: "QnVzaW5lc3M6ZmFrZS1idXNpbmVzcw==",
    onToolError: reporting.captureToolError,
  });
  const client = new Client({ name: "sentry-scrub-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([wave.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    globalThis.fetch = originalFetch;
  }
}

test("scrubEvent drops request, user, extra, breadcrumbs, and unsafe tags and contexts", () => {
  const event = reporting.scrubEvent({
    message: `Invoice for ${CUSTOMER}`,
    request: { data: { memo: MEMO } },
    user: { ip_address: "203.0.113.9", email: "someone@example.com" },
    extra: { args: { amount: AMOUNT } },
    breadcrumbs: [{ message: MEMO }],
    server_name: "someones-laptop",
    tags: { tool: "wave_get_customer", customer: CUSTOMER, source: `x ${MEMO}` },
    contexts: { runtime: { name: "node" }, app: { memo: MEMO } },
    exception: { values: [{ type: "TypeError", value: `bad ${CUSTOMER} ${AMOUNT}`, mechanism: { type: "generic", data: { memo: MEMO } }, stacktrace: { frames: [{ filename: "/Users/someone/project/index.js", vars: { memo: MEMO }, context_line: MEMO }] } }] },
  });
  const text = JSON.stringify(event);
  for (const secret of [CUSTOMER, MEMO, AMOUNT, "203.0.113.9", "someone@example.com", "someones-laptop"]) {
    assert.equal(text.includes(secret), false, `event still contains ${secret}`);
  }
  assert.deepEqual(event.tags, { tool: "wave_get_customer" });
  assert.deepEqual(Object.keys(event.contexts), ["runtime"]);
  assert.equal(event.exception.values[0].value, reporting.SCRUBBED_MESSAGE);
});

test("frame-shaped lines inside an error message never become stack frames", () => {
  const original = new Error(`lookup failed\n    at /Users/x/secret.js:1:1\n    at ${CUSTOMER} (${MEMO}:2:3)`);
  const safe = reporting.sanitizeError(original);
  for (const secret of ["/Users/x/secret.js", "secret.js", CUSTOMER, MEMO]) {
    assert.equal(safe.stack.includes(secret), false, `stack still contains ${secret}`);
  }
  assert.match(safe.stack, /\n\s+at /);

  const event = reporting.scrubEvent({ exception: { values: [{ type: "Error", value: "x", stacktrace: { frames: [
    { filename: "/Users/x/secret.js", function: "?", lineno: 1 },
    { filename: "app:///index.js", function: `${CUSTOMER} memo`, lineno: 2 },
    { filename: "node:internal/process/task_queues", function: "process.processTicksAndRejections", lineno: 3 },
    { filename: "app:///index.js", function: "waveFetch", lineno: 4 },
  ] } }] } });
  assert.deepEqual(event.exception.values[0].stacktrace.frames.map((frame) => frame.function), ["process.processTicksAndRejections", "waveFetch"]);
});

test("frame paths are package-relative or reduced to a basename on every platform", () => {
  assert.equal(reporting.relativeFramePath("C:\\Users\\someone\\AppData\\npm-cache\\_npx\\abc\\node_modules\\zod\\index.js"), "app:///node_modules/zod/index.js");
  assert.equal(reporting.relativeFramePath("C:\\Users\\someone\\Documents\\2026 taxes.js"), "2026 taxes.js");
  assert.equal(reporting.relativeFramePath("\\\\fileserver\\share\\someone\\tool.js"), "tool.js");
  assert.equal(reporting.relativeFramePath("file:///C:/Users/someone/elsewhere/x.mjs"), "x.mjs");
  assert.equal(reporting.relativeFramePath("/home/someone/other-project/y.js"), "y.js");
  assert.equal(reporting.relativeFramePath(new URL("../index.js", import.meta.url).pathname), "app:///index.js");
});

test("a network failure reaches Sentry with its tool name and no financial data", { skip }, async () => {
  assert.equal(enabled, true, "initErrorReporting did not enable Sentry");
  envelopes.length = 0;
  const result = await callTool(async () => { throw new TypeError(`fetch failed: ${CUSTOMER} owes ${AMOUNT} (${MEMO})`); }, "wave_get_customer", { customer_id: `${CUSTOMER} ${AMOUNT}` });
  assert.equal(result.isError, true);
  assert.equal(await reporting.flushErrorReporting(5000), true);

  const raw = envelopes.join("\n");
  const events = eventsFrom(raw);
  assert.equal(events.length, 1, raw);
  const [event] = events;
  for (const secret of [CUSTOMER, "Sentinel", AMOUNT, MEMO, "fake-token-a", "QnVzaW5lc3M6", "gql.waveapps.com", homedir()]) {
    assert.equal(raw.includes(secret), false, `envelope contains ${secret}`);
  }
  assert.equal(event.tags.tool, "wave_get_customer");
  assert.equal(event.tags.source, "tool_handler");
  assert.equal(event.exception.values[0].type, "WaveNetworkError");
  assert.equal(event.exception.values[0].value, reporting.SCRUBBED_MESSAGE);
  const frames = event.exception.values[0].stacktrace?.frames ?? [];
  assert.ok(frames.length > 0, "event kept no stack frames");
  assert.ok(frames.every((frame) => /^(app:\/\/\/|node:)/.test(frame.filename)), JSON.stringify(frames));
  assert.equal(event.user, undefined);
  assert.equal(event.request, undefined);
  assert.equal(event.server_name, undefined);
  assert.equal(event.release, "mcp-server-for-wave@0.0.0-test");
});

test("Wave's own answers are not reported; 5xx and invalid queries are", { skip }, async () => {
  envelopes.length = 0;
  const json = (body, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const args = { customer_id: CUSTOMER };
  for (const fetchImpl of [
    json({ errors: [{ message: `Not found ${CUSTOMER}`, extensions: { code: "NOT_FOUND" } }] }),
    json({ errors: [{ message: "bad token", extensions: { code: "UNAUTHENTICATED" } }] }),
    json({ error: `Bad request ${AMOUNT}` }, 400),
    json({ error: "nope" }, 401),
    json({ error: `Down ${MEMO}` }, 503),
    json({ errors: [{ message: `Cannot query field ${CUSTOMER}`, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }),
  ]) {
    assert.equal((await callTool(fetchImpl, "wave_get_customer", args)).isError, true);
  }
  assert.equal(await reporting.flushErrorReporting(5000), true);

  const raw = envelopes.join("\n");
  const events = eventsFrom(raw);
  assert.deepEqual(events.map((event) => [event.exception.values[0].type, event.tags.http_status ?? null]).sort(), [["WaveInternalError", null], ["WaveServerError", "503"]]);
  for (const secret of [CUSTOMER, AMOUNT, MEMO]) assert.equal(raw.includes(secret), false, `envelope contains ${secret}`);
});
