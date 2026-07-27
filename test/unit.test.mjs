/**
 * Unit tests for MCP Server for Wave.
 *
 * Wave's API is never called here. What stubbing cannot hide is covered
 * instead: input validation, pagination metadata, error mapping, credential
 * resolution, write gating, and every formatting path.
 *
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.WAVE_MCP_NO_AUTOSTART = "1";
process.env.WAVE_DISABLE_AGENT_CONFIG_FALLBACK = "1";
process.env.WAVE_ACCESS_TOKEN = process.env.WAVE_ACCESS_TOKEN || "unit-test-token";

const module = await import("../index.js");
const { createWaveServer, __testables } = module;

/** A server with writes on, so every tool is registered and inspectable. */
const rw = createWaveServer({
  getAccessToken: async () => "unit-test-token",
  hasCredentials: true,
  defaultBusinessId: "biz-1",
  writesEnabled: true,
});
const H = rw.__internals;

const ro = createWaveServer({
  getAccessToken: async () => "unit-test-token",
  hasCredentials: true,
  writesEnabled: false,
});

// --- Line items -------------------------------------------------------------

test("line items require a product", () => {
  assert.throws(() => H.normalizeLineItems([{ quantity: 1 }], "Invoice"), /missing productId/);
});

test("line items reject an empty list with an actionable message", () => {
  assert.throws(() => H.normalizeLineItems([], "Invoice"), /At least one invoice line item is required/);
});

test("line item numbers are coerced to strings for Wave's Decimal scalar", () => {
  const [item] = H.normalizeLineItems([{ productId: "p1", quantity: 2, unitPrice: 19.99 }], "Invoice");
  assert.deepEqual(item, { productId: "p1", quantity: "2", unitPrice: "19.99" });
});

test("taxes accept a bare id or an object", () => {
  const [item] = H.normalizeLineItems(
    [{ productId: "p1", taxes: ["tax-1", { salesTaxId: "tax-2", amount: 3 }] }],
    "Invoice"
  );
  assert.deepEqual(item.taxes, [{ salesTaxId: "tax-1" }, { salesTaxId: "tax-2", amount: "3" }]);
});

test("a tax entry without an id is rejected", () => {
  assert.throws(
    () => H.normalizeLineItems([{ productId: "p1", taxes: [{ amount: 1 }] }], "Invoice"),
    /without salesTaxId/
  );
});

test("estimate taxes drop the amount Wave's input type does not accept", () => {
  const items = H.normalizeLineItems([{ productId: "p1", taxes: [{ salesTaxId: "t1", amount: 5 }] }], "Estimate");
  assert.deepEqual(H.stripEstimateItemTaxes(items)[0].taxes, [{ salesTaxId: "t1" }]);
});

// --- Discounts --------------------------------------------------------------

test("discount type is inferred from which value is present", () => {
  assert.deepEqual(H.normalizeDiscounts([{ percentage: 10 }], "Invoice"), [
    { discountType: "PERCENTAGE", percentage: "10" },
  ]);
  assert.deepEqual(H.normalizeDiscounts([{ amount: 25 }], "Invoice"), [{ discountType: "FIXED", amount: "25" }]);
});

test("a FIXED discount without an amount is rejected", () => {
  assert.throws(() => H.normalizeDiscounts([{ discountType: "FIXED" }], "Invoice"), /FIXED but has no amount/);
});

test("an unknown discount type is rejected", () => {
  assert.throws(() => H.normalizeDiscounts([{ discountType: "SLIDING", amount: 1 }], "Invoice"), /expected FIXED or PERCENTAGE/);
});

// --- Recipients -------------------------------------------------------------

test("recipients accept a single address or a list", () => {
  assert.deepEqual(H.normalizeRecipients("a@b.com", "t"), ["a@b.com"]);
  assert.deepEqual(H.normalizeRecipients(["a@b.com", "c@d.com"], "t"), ["a@b.com", "c@d.com"]);
});

test("an empty recipient list is rejected before any mail is sent", () => {
  assert.throws(() => H.normalizeRecipients([], "t"), /at least one recipient/);
});

// --- Transactions -----------------------------------------------------------

test("a transaction whose lines do not sum to the anchor is rejected with both figures", () => {
  const lines = H.normalizeTransactionLineItems(
    [
      { accountId: "a1", amount: "60.00" },
      { accountId: "a2", amount: "30.00" },
    ],
    "t"
  );
  assert.throws(() => H.assertBalanced("100.00", lines, "t"), /anchor amount is 100.00 but the line items total 90.00/);
});

test("a balanced split transaction passes", () => {
  const lines = H.normalizeTransactionLineItems(
    [
      { accountId: "a1", amount: "60.00" },
      { accountId: "a2", amount: "40.00" },
    ],
    "t"
  );
  assert.doesNotThrow(() => H.assertBalanced("100.00", lines, "t"));
});

test("balance comparison is done in minor units, so float drift cannot fail a valid split", () => {
  const lines = H.normalizeTransactionLineItems(
    [
      { accountId: "a1", amount: "0.10" },
      { accountId: "a2", amount: "0.20" },
    ],
    "t"
  );
  assert.doesNotThrow(() => H.assertBalanced("0.30", lines, "t"));
});

test("transaction lines default to INCREASE and normalize case", () => {
  const [line] = H.normalizeTransactionLineItems([{ accountId: "a1", amount: 5, balance: "decrease" }], "t");
  assert.equal(line.balance, "DECREASE");
  const [other] = H.normalizeTransactionLineItems([{ accountId: "a1", amount: 5 }], "t");
  assert.equal(other.balance, "INCREASE");
});

test("transaction lines require an account and an amount", () => {
  assert.throws(() => H.normalizeTransactionLineItems([{ amount: 1 }], "t"), /missing accountId/);
  assert.throws(() => H.normalizeTransactionLineItems([{ accountId: "a" }], "t"), /missing amount/);
});

test("a supplied external id is preserved so retries stay idempotent", () => {
  assert.equal(H.externalId("prefix", "my-key"), "my-key");
  assert.match(H.externalId("prefix", null), /^prefix-\d{8}T\d{6}/);
});

// --- Addresses --------------------------------------------------------------

test("an empty address is omitted rather than sent as an empty object", () => {
  assert.equal(H.optionalAddress({}), undefined);
  assert.deepEqual(H.optionalAddress({ city: "Burlington" }), { city: "Burlington" });
});

test("country codes are upper-cased for Wave's enum", () => {
  assert.deepEqual(H.optionalAddress({ country_code: "us" }), { countryCode: "US" });
});

test("empty shipping details are omitted", () => {
  assert.equal(H.optionalShipping({}), undefined);
});

// --- Payload shaping --------------------------------------------------------

test("undefined values are stripped so patches do not clear untouched fields", () => {
  assert.deepEqual(H.stripUndefined({ a: 1, b: undefined, c: { d: undefined, e: 2 } }), { a: 1, c: { e: 2 } });
});

test("null is preserved by stripUndefined but dropped by compact", () => {
  assert.deepEqual(H.compact({ a: 1, b: null, c: undefined }), { a: 1 });
});

// --- Formatting -------------------------------------------------------------

test("money renders symbol, value, and currency code", () => {
  assert.equal(H.money({ value: "1,234.56", currency: { code: "CAD", symbol: "$" } }), "$1,234.56 CAD");
  assert.equal(H.money(null), "-");
});

test("addresses flatten to one comma-separated line, skipping blanks", () => {
  assert.equal(
    H.addressLine({ addressLine1: "1 Main St", city: "Burlington", country: { name: "United States" } }),
    "1 Main St, Burlington, United States"
  );
});

test("table cells escape pipes and newlines so a row cannot break the table", () => {
  const rendered = H.table([{ note: "a|b\nc" }], [["Note", "note"]]);
  assert.match(rendered, /a\\\|b c/);
});

test("an empty table says so rather than rendering a bare header", () => {
  assert.equal(H.table([], [["Name", "name"]]), "_No records._");
});

test("kvBlock omits empty values", () => {
  assert.equal(H.kvBlock([["A", "1"], ["B", null], ["C", ""], ["D", "-"]]), "- **A:** 1");
});

test("pagination footer tells the caller how to advance", () => {
  const footer = H.paginationFooter({ page: 1, total_pages: 3, count: 50, total_count: 120, has_more: true, next_page: 2 });
  assert.match(footer, /Page 1 of 3/);
  assert.match(footer, /showing 50 of 120/);
  assert.match(footer, /page=2/);
});

test("pagination footer reports a complete sweep differently", () => {
  assert.match(H.paginationFooter({ fetched_all: true, count: 7 }), /Returned all 7 record/);
});

// --- Account matching -------------------------------------------------------

const ACCOUNTS = [
  { id: "a1", name: "Meals and Entertainment" },
  { id: "a2", name: "Motor Vehicle - Fuel" },
  { id: "a3", name: "Office Supplies" },
];

test("a synonym maps an everyday word onto the right account", () => {
  const match = H.matchAccount("food", ACCOUNTS, H.EXPENSE_SYNONYMS, "expense");
  assert.equal(match.account.id, "a1");
  assert.ok(match.score >= 0.8);
});

test("a substring match beats a fuzzy one", () => {
  assert.equal(H.matchAccount("office supplies", ACCOUNTS, H.EXPENSE_SYNONYMS, "expense").account.id, "a3");
});

test("a weak match refuses to guess and lists the real options", () => {
  assert.throws(
    () => H.matchAccount("cryptocurrency mining rig", ACCOUNTS, H.EXPENSE_SYNONYMS, "expense"),
    (error) => /Office Supplies/.test(error.message) && /wave_create_money_transaction/.test(error.message)
  );
});

test("no accounts at all is reported clearly", () => {
  assert.throws(() => H.matchAccount("food", [], H.EXPENSE_SYNONYMS, "expense"), /no active expense accounts/);
});

test("similarity is symmetric and bounded", () => {
  assert.equal(H.similarity("abc", "abc"), 1);
  assert.equal(H.similarity("", "abc"), 0);
  assert.equal(H.similarity("kitten", "sitting"), H.similarity("sitting", "kitten"));
});

// --- Security ---------------------------------------------------------------

test("tokens are redacted from error text", () => {
  const message = H.sanitizeErrorMessage("failed with Bearer sk-abc123.def and Authorization: Bearer xyz");
  assert.ok(!message.includes("sk-abc123.def"));
  assert.match(message, /REDACTED_TOKEN/);
});

test("credentials are refused for any host other than Wave's GraphQL endpoint", () => {
  assert.throws(() => H.assertWaveApiUrl(new URL("https://evil.example.com/graphql")), /Refusing to send credentials/);
  assert.throws(() => H.assertWaveApiUrl(new URL("http://gql.waveapps.com/graphql/public")), /Refusing to send credentials/);
  assert.doesNotThrow(() => H.assertWaveApiUrl(new URL("https://gql.waveapps.com/graphql/public")));
});

// --- Business resolution ----------------------------------------------------

test("an explicit business id wins over the session default", () => {
  assert.equal(H.requireBusinessId("explicit"), "explicit");
  assert.equal(H.requireBusinessId(), "biz-1");
});

test("no business at all produces an actionable error", () => {
  const bare = createWaveServer({ getAccessToken: async () => "t", hasCredentials: true });
  assert.throws(() => bare.__internals.requireBusinessId(), /No business selected/);
});

// --- Tool registration ------------------------------------------------------

test("every tool carries the wave_ prefix and a description", () => {
  for (const name of rw.listTools()) {
    assert.ok(name.startsWith("wave_"), `${name} lacks the wave_ prefix`);
    assert.ok(rw.toolConfig(name)?.description, `${name} has no description`);
  }
});

test("tool titles are namespaced and humanized", () => {
  assert.equal(H.humanizeToolName("wave_list_invoices"), "Wave: List Invoices");
  assert.equal(H.humanizeToolName("wave_generate_estimate_pdf"), "Wave: Generate Estimate PDF");
});

test("read-only tools are annotated idempotent, because they are", () => {
  const config = rw.toolConfig("wave_list_invoices");
  assert.equal(config.annotations.readOnlyHint, true);
  assert.equal(config.annotations.idempotentHint, true);
  assert.equal(config.annotations.openWorldHint, true);
});

test("destructive tools are annotated as such", () => {
  for (const name of ["wave_delete_invoice", "wave_delete_customer", "wave_archive_account"]) {
    assert.equal(rw.toolConfig(name).annotations.destructiveHint, true, name);
  }
});

test("writes are gated off by default", () => {
  const registered = new Set(ro.listTools());
  for (const gated of ["wave_delete_invoice", "wave_send_invoice", "wave_create_invoice"]) {
    assert.ok(!registered.has(gated), `${gated} leaked into read-only mode`);
  }
  assert.ok(ro.listTools().length > 0, "read-only mode registered no tools at all");
  assert.ok(rw.listTools().length > ro.listTools().length, "WAVE_ALLOW_WRITES registered no extra tools");
});

test("the full API surface is registered when writes are enabled", () => {
  // 42 mutations + 11 root queries + business sub-resources + convenience,
  // minus the ones that share a tool, plus wave_auth_status.
  assert.ok(rw.listTools().length >= 70, `only ${rw.listTools().length} tools registered`);
});

// --- GraphQL documents ------------------------------------------------------

test("every registered GraphQL document is a named query or mutation", () => {
  const documents = [...new Set(__testables.GRAPHQL_DOCUMENTS)];
  assert.ok(documents.length >= 60, `only ${documents.length} documents registered`);
  for (const document of documents) {
    assert.match(document, /^\s*(query|mutation)\s+\w+/, `unnamed operation: ${document.slice(0, 60)}`);
  }
});

test("documents that spread a fragment also define it", () => {
  for (const document of new Set(__testables.GRAPHQL_DOCUMENTS)) {
    const spreads = [...document.matchAll(/\.\.\.(\w+)/g)].map((m) => m[1]);
    for (const spread of spreads) {
      assert.ok(
        document.includes(`fragment ${spread} on `),
        `${document.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1]} spreads ${spread} without defining it`
      );
    }
  }
});

// --- Config resolution ------------------------------------------------------

test("Codex TOML yields WAVE_ keys from a wave server's env table", () => {
  const toml = `
[mcp_servers.other]
command = "x"

[mcp_servers.other.env]
WAVE_ACCESS_TOKEN = "wrong-server"

[mcp_servers.wave-mcp-server.env]
WAVE_ACCESS_TOKEN = "abc123"
WAVE_BUSINESS_ID = "biz-9"
UNRELATED = "ignored"
`;
  const values = __testables.extractFromCodexToml(toml);
  assert.equal(values.WAVE_ACCESS_TOKEN, "abc123");
  assert.equal(values.WAVE_BUSINESS_ID, "biz-9");
  assert.equal(values.UNRELATED, undefined);
});

test("a Codex TOML with no wave server yields nothing", () => {
  const values = __testables.extractFromCodexToml('[mcp_servers.github.env]\nGITHUB_TOKEN = "x"\n');
  assert.deepEqual(values, {});
});

test("a JSON MCP config yields env from the wave server entry only", () => {
  const raw = JSON.stringify({
    mcpServers: {
      github: { env: { WAVE_ACCESS_TOKEN: "wrong" } },
      "wave-mcp-server": { env: { WAVE_ACCESS_TOKEN: "right", WAVE_ALLOW_WRITES: "1" } },
    },
  });
  const values = __testables.extractFromJsonMcpConfig(raw);
  assert.equal(values.WAVE_ACCESS_TOKEN, "right");
  assert.equal(values.WAVE_ALLOW_WRITES, "1");
});

test("only known runtime keys are picked up", () => {
  const values = __testables.pickRuntimeKeys({ WAVE_ACCESS_TOKEN: "a", SOMETHING_ELSE: "b", WAVE_BUSINESS_ID: "" });
  assert.deepEqual(values, { WAVE_ACCESS_TOKEN: "a" });
});

test("truthy flags accept the usual spellings", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(__testables.truthyFlag(value), true, value);
  }
  for (const value of ["0", "false", "", "off", undefined]) {
    assert.equal(__testables.truthyFlag(value), false, String(value));
  }
});

test("envNumber falls back on unset, empty, non-numeric, and below-minimum values", () => {
  delete process.env.WAVE_TEST_NUMBER;
  assert.equal(__testables.envNumber("WAVE_TEST_NUMBER", 42), 42);
  process.env.WAVE_TEST_NUMBER = "";
  assert.equal(__testables.envNumber("WAVE_TEST_NUMBER", 42), 42);
  process.env.WAVE_TEST_NUMBER = "abc";
  assert.equal(__testables.envNumber("WAVE_TEST_NUMBER", 42), 42);
  process.env.WAVE_TEST_NUMBER = "5";
  assert.equal(__testables.envNumber("WAVE_TEST_NUMBER", 42, { min: 10 }), 42);
  process.env.WAVE_TEST_NUMBER = "99";
  assert.equal(__testables.envNumber("WAVE_TEST_NUMBER", 42), 99);
  delete process.env.WAVE_TEST_NUMBER;
});

// --- Fragments --------------------------------------------------------------

test("gql deduplicates repeated fragments", () => {
  const built = __testables.gql("query X { a }", "money", "money");
  assert.equal(built.match(/fragment MoneyFields/g).length, 1);
});

test("Money is always selected with an exact minor-unit value", () => {
  assert.match(__testables.FRAGMENTS.money, /minorUnitValue/);
});

// --- Autostart detection ---------------------------------------------------
// npm installs the bin as a relative symlink, so a naive
// `import.meta.url === "file://" + process.argv[1]` comparison fails and the
// server silently never starts under npx. These cover the resolution.

test("importing this module does not autostart a transport", () => {
  // The suite imported index.js at the top and is still running, which it
  // could not do if the import had opened stdio and blocked.
  assert.equal(typeof __testables.isDirectRun, "function");
  assert.equal(__testables.isDirectRun(), false);
});

test("autostart is refused when argv[1] points at something else", (t) => {
  const original = process.argv[1];
  t.after(() => {
    process.argv[1] = original;
  });
  process.argv[1] = "/definitely/not/this/module.js";
  assert.equal(__testables.isDirectRun(), false);
});

test("WAVE_MCP_NO_AUTOSTART suppresses autostart outright", (t) => {
  const original = process.env.WAVE_MCP_NO_AUTOSTART;
  t.after(() => {
    if (original === undefined) delete process.env.WAVE_MCP_NO_AUTOSTART;
    else process.env.WAVE_MCP_NO_AUTOSTART = original;
  });
  process.env.WAVE_MCP_NO_AUTOSTART = "1";
  assert.equal(__testables.isDirectRun(), false);
});
