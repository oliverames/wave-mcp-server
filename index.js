#!/usr/bin/env node

/**
 * MCP Server for Wave Accounting.
 *
 * Covers Wave's public GraphQL API in full: every mutation and every root
 * query the schema exposes. Wave has one endpoint,
 * https://gql.waveapps.com/graphql/public, authenticated with an OAuth2
 * bearer token.
 *
 * The tool layer is built by createWaveServer(), a factory around injected
 * credentials, so the same code serves both the local stdio process and the
 * hosted Cloudflare Worker with per-user OAuth tokens.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- Init ---

// Cloudflare Workers (nodejs_compat) import this module for createWaveServer,
// but its fs/child_process stubs throw when invoked. Detect Workers so
// import-time config resolution and the stdio autostart are both skipped.
const IS_CLOUDFLARE_WORKERS = globalThis.navigator?.userAgent === "Cloudflare-Workers";

const SERVER_VERSION = "1.0.3";

// --- Structured Logging ---
// JSON lines on stderr. stdout carries the MCP stdio JSON-RPC stream, so
// nothing here may ever write to it. No dependency, so this also runs
// unchanged under Cloudflare Workers, where console.error reaches worker logs.

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const LOG_LEVEL =
  LOG_LEVELS[globalThis.process?.env?.WAVE_LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS.info;

function makeLogger(bindings = {}) {
  const emit = (level, message, meta) => {
    if (LOG_LEVELS[level] < LOG_LEVEL) return;
    console.error(
      JSON.stringify({ time: new Date().toISOString(), level, message, ...bindings, ...meta })
    );
  };
  return {
    debug: (message, meta) => emit("debug", message, meta),
    info: (message, meta) => emit("info", message, meta),
    warn: (message, meta) => emit("warn", message, meta),
    error: (message, meta) => emit("error", message, meta),
    child: (extra) => makeLogger({ ...bindings, ...extra }),
  };
}

const logger = makeLogger({ service: "wave-mcp-server", version: SERVER_VERSION });
const WAVE_ENDPOINT = "https://gql.waveapps.com/graphql/public";
const WAVE_API_HOST = "gql.waveapps.com";
const MAX_TOKEN_FILE_BYTES = 4096;

// Wave caps pageSize at 200 on its offset-paginated connections.
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

// Ceiling for walkPages(). At the 200 max page size this is 100k records, far
// past anything a tool response should return, so hitting it means something
// is wrong rather than merely large.
const MAX_PAGES = 500;

// MCP clients cap how long a single tool call may run -- Codex CLI defaults to
// tool_timeout_sec = 60. Retries have to fit inside that, or the client kills
// the call mid-retry and the user sees a timeout instead of the real error.
const DEFAULT_TIMEOUT_MS = envNumber("WAVE_TIMEOUT_MS", 20000, { min: 1000 });
const DEFAULT_TOTAL_BUDGET_MS = envNumber("WAVE_TOTAL_BUDGET_MS", 50000, { min: 1000 });
const MAX_RESPONSE_BYTES = Math.floor(envNumber("WAVE_MAX_RESPONSE_BYTES", 8388608, { min: 1 }));
const HTTP_RETRIES = Math.floor(envNumber("WAVE_HTTP_RETRIES", 2, { min: 0 }));

// Responses above this are emitted compact rather than pretty-printed.
const PRETTY_PRINT_MAX_BYTES = 262144;

const WAVE_RUNTIME_KEYS = [
  "WAVE_ACCESS_TOKEN",
  "WAVE_ACCESS_TOKEN_FILE",
  "WAVE_OP_PATH",
  "WAVE_BUSINESS_ID",
  "WAVE_ALLOW_WRITES",
  "WAVE_TRACING_ENABLED",
  "WAVE_LOG_LEVEL",
];

// Tracing configuration (W3C Trace Context propagation)
const TRACING_ENABLED = truthyFlag(globalThis.process?.env?.WAVE_TRACING_ENABLED);
const TRACE_ID_HEADER = "traceparent";

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Build a `traceparent` value: version-traceid-spanid-flags. The spec rejects
// an all-zero trace-id or span-id, so both are drawn from the CSPRNG.
function generateTraceId() {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

const runtimeConfig = IS_CLOUDFLARE_WORKERS
  ? {
      accessToken: undefined,
      tokenSource: null,
      values: {},
      sources_checked: [],
      config_fallback_disabled: false,
      detected_agent: "unknown",
      tokenLookupError: undefined,
      lookup_errors: [],
    }
  : resolveWaveRuntimeConfig();

const ACCESS_TOKEN = runtimeConfig.accessToken;
const tokenLookupError = runtimeConfig.tokenLookupError;
const DEFAULT_BUSINESS_ID = runtimeConfig.values.WAVE_BUSINESS_ID?.value;

if (!ACCESS_TOKEN && !IS_CLOUDFLARE_WORKERS) {
  const fallback = tokenLookupError
    ? ` ${tokenLookupError}.`
    : " Add WAVE_ACCESS_TOKEN to the agent config file, set WAVE_ACCESS_TOKEN_FILE, or set WAVE_OP_PATH.";
  console.error(
    `WAVE_ACCESS_TOKEN is required.${fallback} Starting MCP Server for Wave in discovery-only mode.`
  );
}

// --- Helpers ---

// Parse a numeric env var, falling back when it is unset, empty, non-numeric,
// or below `min`. Prevents NaN from silently disabling limits.
function envNumber(name, fallback, { min = 0 } = {}) {
  const raw = globalThis.process?.env?.[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function truthyFlag(value) {
  if (!hasNonEmptyString(value)) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Resolve credentials from, in order: environment, the host agent's own config
 * file, a token file, then 1Password.
 *
 * Reading the agent config matters because MCP clients launch this server as a
 * subprocess: values in claude_desktop_config.json or ~/.codex/config.toml
 * reach us as environment variables only when the user wired them through, and
 * reading the file directly makes a plain install work.
 */
function resolveWaveRuntimeConfig() {
  const sources = loadWaveSettingSources();
  const values = {};

  for (const key of WAVE_RUNTIME_KEYS) {
    const source = sources.find((candidate) => hasNonEmptyString(candidate.values[key]));
    if (source) {
      values[key] = {
        value: source.values[key].trim(),
        source: source.id,
        source_label: source.label,
        path: source.path,
      };
    }
  }

  const lookupErrors = sources.flatMap((source) => source.errors || []).filter(Boolean);

  let accessToken = values.WAVE_ACCESS_TOKEN?.value;
  let tokenSource = accessToken ? values.WAVE_ACCESS_TOKEN.source_label : null;
  let tokenLookupError;

  if (!accessToken && values.WAVE_ACCESS_TOKEN_FILE?.value) {
    try {
      accessToken = readTokenFile(values.WAVE_ACCESS_TOKEN_FILE.value);
      tokenSource = `token file (${values.WAVE_ACCESS_TOKEN_FILE.value})`;
    } catch (error) {
      tokenLookupError = `Could not read WAVE_ACCESS_TOKEN_FILE: ${error.message}`;
      lookupErrors.push(tokenLookupError);
    }
  }

  if (!accessToken && values.WAVE_OP_PATH?.value) {
    try {
      accessToken = readOnePasswordSecret(values.WAVE_OP_PATH.value);
      tokenSource = `1Password (${values.WAVE_OP_PATH.value})`;
    } catch (error) {
      tokenLookupError = `1Password lookup failed: ${error.message}`;
      lookupErrors.push(tokenLookupError);
    }
  }

  return {
    accessToken,
    tokenSource,
    values,
    sources_checked: sources.map((s) => ({ id: s.id, label: s.label, path: s.path, found: s.found })),
    config_fallback_disabled: truthyFlag(globalThis.process?.env?.WAVE_DISABLE_AGENT_CONFIG_FALLBACK),
    detected_agent: detectAgent(),
    tokenLookupError,
    lookup_errors: lookupErrors,
  };
}

function loadWaveSettingSources() {
  const sources = [
    {
      id: "env",
      label: "environment variables",
      path: null,
      values: Object.fromEntries(
        WAVE_RUNTIME_KEYS.map((key) => [key, globalThis.process?.env?.[key]]).filter(([, v]) => v !== undefined)
      ),
      found: true,
      errors: [],
    },
  ];

  if (truthyFlag(globalThis.process?.env?.WAVE_DISABLE_AGENT_CONFIG_FALLBACK)) {
    return sources;
  }

  for (const candidate of agentConfigCandidates()) {
    const source = { ...candidate, values: {}, found: false, errors: [] };
    try {
      const raw = readFileSync(candidate.path, "utf8");
      source.found = true;
      source.values = candidate.extract(raw);
    } catch (error) {
      if (error.code !== "ENOENT") {
        source.errors.push(`Could not read ${candidate.path}: ${error.message}`);
      }
    }
    sources.push(source);
  }

  return sources;
}

function agentConfigCandidates() {
  const home = homedir();
  return [
    {
      id: "claude-desktop",
      label: "Claude Desktop config",
      path: path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      extract: (raw) => extractFromJsonMcpConfig(raw),
    },
    {
      id: "claude-code",
      label: "Claude Code settings",
      path: path.join(home, ".claude", "settings.json"),
      extract: (raw) => extractFromClaudeSettings(raw),
    },
    {
      id: "codex",
      label: "Codex config",
      path: path.join(home, ".codex", "config.toml"),
      extract: (raw) => extractFromCodexToml(raw),
    },
  ];
}

function extractFromJsonMcpConfig(raw) {
  const parsed = JSON.parse(raw);
  const servers = parsed.mcpServers || {};
  for (const key of Object.keys(servers)) {
    if (!/wave/i.test(key)) continue;
    const env = servers[key]?.env;
    if (env && typeof env === "object") return pickRuntimeKeys(env);
  }
  return {};
}

function extractFromClaudeSettings(raw) {
  const parsed = JSON.parse(raw);
  return parsed.env && typeof parsed.env === "object" ? pickRuntimeKeys(parsed.env) : {};
}

/**
 * Pull WAVE_* keys out of a [mcp_servers.<name>.env] table in Codex's TOML.
 *
 * Deliberately a narrow scan rather than a TOML parser: it only needs the env
 * table of a Wave server entry, and adding a parser dependency to reach it
 * would not pay for itself.
 */
function extractFromCodexToml(raw) {
  const values = {};
  let inWaveEnvTable = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const table = trimmed.match(/^\[([^\]]+)\]$/);
    if (table) {
      const name = table[1];
      inWaveEnvTable = /^mcp_servers\.[^.]*wave[^.]*\.env$/i.test(name);
      continue;
    }
    if (!inWaveEnvTable) continue;
    const pair = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/);
    if (pair && WAVE_RUNTIME_KEYS.includes(pair[1])) {
      values[pair[1]] = pair[2];
    }
  }
  return values;
}

function pickRuntimeKeys(source) {
  const values = {};
  for (const key of WAVE_RUNTIME_KEYS) {
    if (hasNonEmptyString(source[key])) values[key] = source[key];
  }
  return values;
}

function readTokenFile(filePath) {
  const resolved = filePath.startsWith("~") ? path.join(homedir(), filePath.slice(1)) : filePath;
  const raw = readFileSync(resolved, "utf8");
  if (raw.length > MAX_TOKEN_FILE_BYTES) {
    throw new Error(`token file is larger than ${MAX_TOKEN_FILE_BYTES} bytes; is it really a token?`);
  }
  const token = raw.trim();
  if (!token) throw new Error("token file is empty");
  return token;
}

/**
 * Read a secret from 1Password via the `op` CLI.
 *
 * execFileSync rather than a shell so an op:// reference containing shell
 * metacharacters cannot become command injection.
 */
function readOnePasswordSecret(reference) {
  if (!/^op:\/\//.test(reference)) {
    throw new Error(`WAVE_OP_PATH must be an op:// reference, got "${reference}"`);
  }
  const output = execFileSync("op", ["read", reference], {
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const token = output.trim();
  if (!token) throw new Error(`1Password returned nothing for ${reference}`);
  return token;
}

/**
 * Strip credentials from text headed for stderr.
 *
 * The factory's sanitizeErrorMessage closes over the live token and is not
 * reachable from process-level handlers, so this covers the header forms that
 * show up in a stack trace.
 */
function redactTokens(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/Authorization:\s*[^\r\n]+/gi, "Authorization: [REDACTED_TOKEN]");
}

function detectAgent() {
  const env = globalThis.process?.env ?? {};
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (env.CODEX_HOME || env.CODEX_SANDBOX) return "codex";
  if (env.TERM_PROGRAM === "vscode") return "vscode";
  return "unknown";
}

// --- GraphQL fragments ---
// One selection set per entity, so a field is spelled correctly once rather
// than once per query, and every tool's output shape stays consistent.
//
// Money is always selected in full: `value` is the display string, and
// `minorUnitValue` gives the amount in minor units for arithmetic that must
// stay exact. `raw` was dropped: Wave deprecated it because it can overflow.

const FRAGMENTS = {
  pageInfo: `
fragment PageInfoFields on OffsetPageInfo {
  currentPage
  totalPages
  totalCount
}`,

  money: `
fragment MoneyFields on Money {
  minorUnitValue
  value
  currency { code symbol }
}`,

  address: `
fragment AddressFields on Address {
  addressLine1
  addressLine2
  city
  postalCode
  province { code name }
  country { code name }
}`,

  account: `
fragment AccountFields on Account {
  id
  name
  description
  displayId
  classicId
  isArchived
  sequence
  balance
  balanceInBusinessCurrency
  normalBalanceType
  currency { code symbol }
  type { name value normalBalanceType }
  subtype { name value archivable systemCreated }
}`,

  customer: `
fragment CustomerFields on Customer {
  id
  name
  firstName
  lastName
  displayId
  email
  mobile
  phone
  fax
  tollFree
  website
  internalNotes
  isArchived
  createdAt
  modifiedAt
  currency { code symbol }
  address { ...AddressFields }
  shippingDetails {
    name
    phone
    instructions
    address { ...AddressFields }
  }
  outstandingAmount { ...MoneyFields }
  overdueAmount { ...MoneyFields }
}`,

  vendor: `
fragment VendorFields on Vendor {
  id
  name
  firstName
  lastName
  displayId
  email
  mobile
  phone
  fax
  tollFree
  website
  internalNotes
  isArchived
  createdAt
  modifiedAt
  currency { code symbol }
  address { ...AddressFields }
  shippingDetails {
    name
    phone
    instructions
    address { ...AddressFields }
  }
}`,

  product: `
fragment ProductFields on Product {
  id
  name
  description
  unitPrice
  isSold
  isBought
  isArchived
  createdAt
  modifiedAt
  incomeAccount { id name }
  expenseAccount { id name }
  defaultSalesTaxes { id name abbreviation rate }
}`,

  salesTax: `
fragment SalesTaxFields on SalesTax {
  id
  name
  abbreviation
  description
  taxNumber
  showTaxNumberOnInvoices
  rate
  rates { effective rate }
  isCompound
  isRecoverable
  isArchived
  createdAt
  modifiedAt
}`,

  invoicePayment: `
fragment InvoicePaymentFields on InvoicePayment {
  id
  amount
  paymentDate
  paymentMethod
  memo
  exchangeRate
  displayExchangeRate
  origin
  state
  transactionType
  paymentProvider
  transactionId
  confirmationCode
  institutionName
  authorizerName
  accountNumberLast3
  accountingTransactionId
  paymentMethodId
  active
  readonlyUrl
  createdAt
  modifiedAt
  businessCurrency { code symbol }
  invoiceCurrency { code symbol }
  paymentCurrency { code symbol }
  account { id name }
  customer { id name }
  paymentDetails { cardType lastFour cardExpiryMonth cardExpiryYear cardSource }
}`,

  // Discounts are interfaces; both concrete types must be spread explicitly.
  invoiceDiscount: `
fragment InvoiceDiscountFields on InvoiceDiscount {
  name
  createdAt
  modifiedAt
  ... on FixedInvoiceDiscount { amount }
  ... on PercentageInvoiceDiscount { percentage }
}`,

  estimateDiscount: `
fragment EstimateDiscountFields on EstimateDiscount {
  name
  createdAt
  modifiedAt
  ... on FixedEstimateDiscount { amount }
  ... on PercentageEstimateDiscount { percentage }
}`,

  invoice: `
fragment InvoiceFields on Invoice {
  id
  status
  title
  subhead
  invoiceNumber
  poNumber
  invoiceDate
  dueDate
  memo
  footer
  pdfUrl
  viewUrl
  exchangeRate
  createdAt
  modifiedAt
  lastSentAt
  lastSentVia
  lastViewedAt
  requireTermsOfServiceAgreement
  disableCreditCardPayments
  disableBankPayments
  disableAmexPayments
  itemTitle
  unitTitle
  priceTitle
  amountTitle
  hideName
  hideDescription
  hideUnit
  hidePrice
  hideAmount
  currency { code symbol }
  customer { id name email }
  subtotal { ...MoneyFields }
  taxTotal { ...MoneyFields }
  discountTotal { ...MoneyFields }
  total { ...MoneyFields }
  amountDue { ...MoneyFields }
  amountPaid { ...MoneyFields }
  discounts { ...InvoiceDiscountFields }
  source {
    ... on Estimate { id }
    ... on NewEstimate { id }
    ... on RecurringInvoice { id }
  }
  invoiceReminders {
    id
    daysDelta
    sent
    sentManually
    issueDate
  }
  items {
    id
    description
    quantity
    unitPrice
    account { id name }
    product { id name }
    subtotal { ...MoneyFields }
    total { ...MoneyFields }
    taxes {
      amount { ...MoneyFields }
      rate
      salesTax { id name abbreviation }
    }
  }
  attachments { id fileName fileSize filePath downloadUrl uploadStatusUpdatedAt }
}`,

  estimate: `
fragment EstimateFields on AREstimate {
  id
  status
  title
  subhead
  estimateNumber
  poNumber
  estimateDate
  dueDate
  memo
  footer
  pdfUrl
  viewUrl
  exchangeRate
  createdAt
  modifiedAt
  lastSentAt
  lastSentVia
  lastViewedAt
  requireTermsOfServiceAgreement
  disableCreditCardPayments
  disableBankPayments
  disableAmexPayments
  itemTitle
  unitTitle
  priceTitle
  amountTitle
  hideName
  hideDescription
  hideUnit
  hidePrice
  hideAmount
  depositStatus
  depositUnit
  depositValue
  depositPaymentStatus
  currency { code symbol }
  customer { id name email }
  subtotal { ...MoneyFields }
  taxTotal { ...MoneyFields }
  discountTotal { ...MoneyFields }
  total { ...MoneyFields }
  amountDue { ...MoneyFields }
  amountPaid { ...MoneyFields }
  depositTotal { ...MoneyFields }
  discounts { ...EstimateDiscountFields }
  items {
    id
    description
    quantity
    unitPrice
    account { id name }
    product { id name }
    subtotal { ...MoneyFields }
    total { ...MoneyFields }
    taxes {
      amount { ...MoneyFields }
      salesTax { id name abbreviation }
    }
  }
}`,

  estimatePayment: `
fragment EstimatePaymentFields on EstimatePayment {
  id
  amount
  paymentDate
  paymentMethod
  memo
  paymentAccountId
  origin
  state
  transactionType
  paymentProvider
  transactionId
  confirmationCode
  originPaymentId
  paymentMethodId
  active
  readonlyUrl
  createdAt
  modifiedAt
  currency { code symbol }
  paymentDetails { cardType lastFour cardExpiryMonth cardExpiryYear cardSource }
}`,

  business: `
fragment BusinessFields on Business {
  id
  name
  isPersonal
  isClassicAccounting
  isClassicInvoicing
  isArchived
  organizationalType
  timezone
  phone
  fax
  mobile
  tollFree
  website
  emailSendEnabled
  createdAt
  modifiedAt
  currency { code symbol name }
  type { name value }
  subtype { name value }
  address { ...AddressFields }
}`,
};

const INPUT_ERRORS = "inputErrors { path message code }";

// Every document built by gql(), so scripts/smoke-validate-graphql.mjs can
// schema-check the whole surface against Wave without a token.
const GRAPHQL_DOCUMENTS = [];

/** Concatenate an operation with the fragments it references, deduplicated. */
function gql(document, ...fragmentKeys) {
  const seen = new Set();
  const parts = [document.trim()];
  for (const key of fragmentKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(FRAGMENTS[key].trim());
  }
  const built = parts.join("\n\n");
  GRAPHQL_DOCUMENTS.push(built);
  return built;
}

// Common fragment bundles, so call sites stay short.
const CUSTOMER_SET = ["customer", "address", "money"];
const VENDOR_SET = ["vendor", "address"];
const INVOICE_SET = ["invoice", "invoiceDiscount", "money"];
const ESTIMATE_SET = ["estimate", "estimateDiscount", "money"];
const BUSINESS_SET = ["business", "address"];

// --- Server factory ---
// Builds the entire tool and resource layer around injected credentials and
// write gating, so the same layer serves both the local stdio process and
// hosted deployments (a Cloudflare Worker with per-user OAuth tokens).
//
// options:
//   getAccessToken: async () => string|null — called per outbound request.
//   hasCredentials: boolean — whether a token source exists.
//   defaultBusinessId: string|undefined — fallback business for tools.
//   writesEnabled: boolean — registers write tools when true.
//   runtime: auth-status reporting only; all fields optional.
//   serverInfo: { name, version } override.
export function createWaveServer(options = {}) {

const {
  getAccessToken = null,
  hasCredentials = false,
  defaultBusinessId = undefined,
  writesEnabled: allowWrites = false,
  runtime = {},
  serverInfo = { name: "wave_mcp", version: SERVER_VERSION },
} = options;

// Most-recently-seen token, kept only so sanitizeErrorMessage can redact it
// from error text. Refreshed on every secureFetch call.
let currentToken = null;

// Session default, settable at runtime by wave_set_default_business.
let sessionBusinessId = defaultBusinessId;

const server = new McpServer(
  { name: serverInfo.name, version: serverInfo.version },
  {
    instructions: [
      "Tools for Wave Accounting (waveapps.com) covering the full public GraphQL API:",
      "businesses, chart of accounts, customers, vendors, products, sales taxes,",
      "invoices and invoice payments, estimates and deposit payments, and money",
      "(bookkeeping) transactions.",
      "",
      "Most tools operate on one business. Call wave_list_businesses first, then",
      "wave_set_default_business so later calls can omit business_id. Any tool still",
      "accepts an explicit business_id to override the default.",
      "",
      'Every read tool accepts response_format ("markdown" for a compact summary,',
      '"json" for the complete record) and paginates with page/page_size, or',
      "fetch_all=true to walk every page.",
      "",
      "Wave has no query for money transactions: they can be created but not read",
      "back. Vendors are read-only. Invoice and estimate line items must each",
      "reference a product.",
    ].join("\n"),
  }
);

// --- Errors ---

function sanitizeErrorMessage(value) {
  let message = String(value ?? "");
  if (currentToken) {
    message = message.split(currentToken).join("[REDACTED_TOKEN]");
  }
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/Authorization:\s*[^\r\n]+/gi, "Authorization: [REDACTED_TOKEN]");
}

class WaveError extends Error {}
class WaveAuthError extends WaveError {}
class WaveConfigError extends WaveError {}

/** Wave reports mutation failures inside the payload, not as GraphQL errors. */
class WaveMutationError extends WaveError {
  constructor(mutation, inputErrors = []) {
    const detail = (inputErrors || [])
      .map((err) => {
        const key = Array.isArray(err.path) ? err.path.join(".") : err.path || "input";
        const code = err.code ? ` [${err.code}]` : "";
        return `${key}: ${err.message || "invalid"}${code}`;
      })
      .join("; ");
    super(
      detail
        ? `${mutation} failed -- ${detail}`
        : `${mutation} failed and Wave returned no field-level detail. This usually means a referenced ID belongs to a different business.`
    );
    this.inputErrors = inputErrors || [];
  }
}

// --- Enhanced Error Types ---
// More granular error types for better error categorization and handling.

/** Thrown when input validation fails before reaching Wave. */
class WaveValidationError extends WaveError {
  constructor(message, field = null) {
    super(message);
    this.name = "WaveValidationError";
    this.field = field;
  }
}

/** Thrown when a rate limit is encountered. */
class WaveRateLimitError extends WaveError {
  constructor(message, retryAfterMs = null) {
    super(message);
    this.name = "WaveRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Thrown when a record is not found. */
class WaveNotFoundError extends WaveError {
  constructor(message, resource = null, id = null) {
    super(message);
    this.name = "WaveNotFoundError";
    this.resource = resource;
    this.id = id;
  }
}

/** Thrown when an operation times out. */
class WaveTimeoutError extends WaveError {
  constructor(message, operation = null, durationMs = null) {
    super(message);
    this.name = "WaveTimeoutError";
    this.operation = operation;
    this.durationMs = durationMs;
  }
}

/** Thrown when a server-side error occurs. */
class WaveServerError extends WaveError {
  constructor(message, status = null, statusText = null) {
    super(message);
    this.name = "WaveServerError";
    this.status = status;
    this.statusText = statusText;
  }
}

/** Thrown when a network error occurs. */
class WaveNetworkError extends WaveError {
  constructor(message, cause = null) {
    super(message);
    this.name = "WaveNetworkError";
    this.cause = cause;
  }
}

// --- Transport ---

/**
 * Pin outbound requests to Wave's GraphQL host.
 *
 * The endpoint is a constant today, but this is the single choke point where
 * a token is attached, so it must never be reachable for another origin.
 */
function assertWaveApiUrl(url) {
  if (url.protocol !== "https:" || url.hostname !== WAVE_API_HOST) {
    throw new WaveError(`Refusing to send credentials to ${url.origin}; expected https://${WAVE_API_HOST}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  return Math.min(2 ** attempt * 1000, 8000);
}

function retryAfterMs(response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number.parseFloat(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/**
 * POST a GraphQL document and return its `data` payload.
 *
 * Retries on 429 and 5xx with exponential backoff, but never past the total
 * budget, so a retry storm cannot outlast the calling MCP client's own tool
 * timeout (Codex kills a call at 60s by default).
 */
async function waveFetch(query, variables = {}) {
  const traceId = TRACING_ENABLED ? generateTraceId() : undefined;
  const url = new URL(WAVE_ENDPOINT);
  assertWaveApiUrl(url);

  const accessToken = getAccessToken ? await getAccessToken() : null;
  if (!accessToken) {
    logger.error("No Wave access token available, aborting waveFetch");
    throw new WaveAuthError(
      "No Wave access token is available. Set WAVE_ACCESS_TOKEN, or reconnect this MCP server to Wave and try again."
    );
  }
  currentToken = accessToken;

  const body = JSON.stringify({ query, variables: stripUndefined(variables) });
  const started = Date.now();
  const budgetLeft = () => DEFAULT_TOTAL_BUDGET_MS - (Date.now() - started);
  const elapsedMs = () => Date.now() - started;

  logger.debug(`Starting waveFetch: ${query.slice(0, 80)}${traceId ? ` (trace: ${traceId})` : ""}`, {
    queryPreview: query.slice(0, 100),
    traceId,
  });

  let lastError = null;

  for (let attempt = 0; attempt <= HTTP_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(DEFAULT_TIMEOUT_MS, Math.max(budgetLeft(), 1)));

    let response;
    let raw;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": `mcp-server-for-wave/${SERVER_VERSION}`,
          ...(traceId && { [TRACE_ID_HEADER]: traceId }),
        },
        body,
        signal: controller.signal,
      });
      // The body is read under the same deadline as the headers. Clearing the
      // timer first would let a server that sends headers but stalls the
      // stream hang the call past both the per-attempt timeout and the total
      // budget, with no error until the client gives up.
      raw = await response.text();
    } catch (error) {
      lastError = error;
      // A GraphQL POST is not idempotent in general, but Wave dedupes writes
      // on externalId and every read is safe, so a transport-level failure
      // (no response received) is retried within budget.
      const delay = backoffMs(attempt);
      if (attempt < HTTP_RETRIES && delay < budgetLeft()) {
        await sleep(delay);
        continue;
      }
      logger.error(`waveFetch failed after ${attempt + 1} attempts`, {
        error: error.message,
        traceId,
        elapsedMs: elapsedMs(),
        attempts: attempt + 1,
      });
      throw new WaveNetworkError(
        `Could not reach the Wave API: ${sanitizeErrorMessage(error.message)}. ` +
          `Gave up after ${Math.round((Date.now() - started) / 1000)}s.`,
        error
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      const delay = retryAfterMs(response) ?? backoffMs(attempt);
      if (attempt >= HTTP_RETRIES || delay >= budgetLeft()) {
        throw new WaveRateLimitError(
          "Wave rate limit reached. Wave allows only about two concurrent requests. " +
            "Wait a moment and retry, or lower page_size / avoid fetch_all on large lists.",
          delay
        );
      }
      await sleep(delay);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new WaveAuthError(
        `Wave rejected the access token (HTTP ${response.status}). Tokens expire, so generate a fresh ` +
          "one at https://developer.waveapps.com/ and update WAVE_ACCESS_TOKEN."
      );
    }

    if (response.status >= 500) {
      lastError = new WaveServerError(`Wave returned HTTP ${response.status}.`, response.status, response.statusText);
      const delay = backoffMs(attempt);
      if (attempt < HTTP_RETRIES && delay < budgetLeft()) {
        await sleep(delay);
        continue;
      }
      logger.error(`Wave server error after ${attempt + 1} attempts`, {
        status: response.status,
        statusText: response.statusText,
        traceId,
        elapsedMs: elapsedMs(),
        attempts: attempt + 1,
      });
      throw lastError;
    }

    if (!response.ok) {
      const text = sanitizeErrorMessage(raw.slice(0, 500));
      logger.error(`Wave returned non-ok response`, {
        status: response.status,
        text,
        traceId,
      });
      throw new WaveServerError(`Wave returned HTTP ${response.status}: ${text}`, response.status, response.statusText);
    }

    if (raw.length > MAX_RESPONSE_BYTES) {
      throw new WaveError(
        `Wave returned ${raw.length} bytes, over the ${MAX_RESPONSE_BYTES}-byte cap. ` +
          "Lower page_size, or drop fetch_all and page through instead."
      );
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new WaveError(
        `Wave returned a malformed JSON body (HTTP ${response.status}): ${sanitizeErrorMessage(raw.slice(0, 200))}`
      );
    }
    raiseForGraphQLErrors(payload);
    const result = payload.data ?? {};

    logger.debug(`waveFetch completed successfully`, {
      resultCount: Object.keys(result || {}).length,
      traceId,
    });

    return result;
  }

  const error = new WaveTimeoutError(
    `Wave API did not respond within ${Math.round(DEFAULT_TOTAL_BUDGET_MS / 1000)}s: ` +
      `${sanitizeErrorMessage(lastError?.message)}. Raise WAVE_TOTAL_BUDGET_MS if your MCP client allows a longer tool timeout.`,
    "waveFetch",
    DEFAULT_TOTAL_BUDGET_MS
  );
  logger.error(`waveFetch timed out`, {
    elapsedMs: DEFAULT_TOTAL_BUDGET_MS,
    traceId,
  });
  throw error;
}

function raiseForGraphQLErrors(payload) {
  const errors = payload?.errors;
  if (!errors || errors.length === 0) return;

  const codes = new Set(errors.map((e) => e?.extensions?.code).filter(Boolean));
  const messages = sanitizeErrorMessage(errors.map((e) => e.message || "unknown error").join("; "));

  if (codes.has("UNAUTHENTICATED")) {
    throw new WaveAuthError(
      `Wave rejected the access token: ${messages}. Generate a fresh token at ` +
        "https://developer.waveapps.com/ and update WAVE_ACCESS_TOKEN."
    );
  }
  if (codes.has("GRAPHQL_VALIDATION_FAILED")) {
    throw new WaveError(
      `Wave rejected the query as invalid: ${messages}. This is a bug in the MCP server, not in your input.`
    );
  }
  if (codes.has("NOT_FOUND")) {
    throw new WaveNotFoundError(
      `Wave could not find the requested record: ${messages}. Check that the ID belongs to the selected business.`,
      "record",
      errors.map((e) => e.path).join('.') || null
    );
  }
  throw new WaveError(`Wave API error: ${messages}`);
}

/** Run a mutation and return its payload, raising if it did not succeed. */
async function waveMutate(query, variables, rootField) {
  const data = await waveFetch(query, variables);
  const payload = data?.[rootField];
  if (payload == null) {
    throw new WaveError(
      `Wave returned no payload for ${rootField}. The record may not exist, or the token may lack permission for this business.`
    );
  }
  if (payload.didSucceed === false) {
    throw new WaveMutationError(rootField, payload.inputErrors);
  }
  return payload;
}

/**
 * Fetch one page, or every page, of an offset-paginated connection.
 *
 * `pathKeys` locates the connection in the response, e.g. ["business", "invoices"].
 * A fetchAll walk that stops at the safety ceiling reports truncated: true
 * rather than claiming completeness.
 */
async function walkPages(
  query,
  variables,
  pathKeys,
  { page = 1, pageSize = DEFAULT_PAGE_SIZE, fetchAll = false, maxPages = MAX_PAGES } = {}
) {
  const size = Math.max(1, Math.min(pageSize, MAX_PAGE_SIZE));
  const items = [];
  let current = page;
  let pageInfo = {};
  let walked = 0;
  let truncated = false;

  for (;;) {
    const data = await waveFetch(query, { ...variables, page: current, pageSize: size });
    const connection = pathKeys.reduce((node, key) => (node == null ? node : node[key]), data);
    if (connection == null) {
      throw new WaveError(
        `Wave returned no data at ${pathKeys.join(".")}. Check that the business ID is correct and the token can access it.`
      );
    }

    for (const edge of connection.edges || []) {
      if (edge?.node != null) items.push(edge.node);
    }
    pageInfo = connection.pageInfo || {};
    walked += 1;

    const totalPages = pageInfo.totalPages || 1;
    if (!fetchAll || current >= totalPages) break;
    if (walked >= maxPages) {
      truncated = true;
      break;
    }
    current += 1;
  }

  const totalPages = pageInfo.totalPages || 1;
  const hasMore = !fetchAll && current < totalPages;

  return {
    items,
    page,
    page_size: size,
    count: items.length,
    total_count: pageInfo.totalCount ?? null,
    total_pages: totalPages,
    has_more: hasMore,
    next_page: hasMore ? current + 1 : null,
    fetched_all: fetchAll && !truncated,
    truncated,
  };
}

/** Drop undefined values so Wave sees omitted fields rather than explicit nulls. */
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = stripUndefined(item);
    }
    return out;
  }
  return value;
}

function requireBusinessId(businessId) {
  const resolved = businessId || sessionBusinessId;
  if (!resolved) {
    throw new WaveConfigError(
      "No business selected. Call wave_list_businesses to see the available IDs, then either pass " +
        "business_id explicitly or call wave_set_default_business to set one for the session."
    );
  }
  return resolved;
}

// --- Formatting ---
// Every read tool takes response_format: "markdown" (compact, default) or
// "json" (complete). Markdown drops empty fields so a list of twenty invoices
// does not bury the useful columns under nulls.

function ok(text) {
  return { content: [{ type: "text", text }] };
}

function render(data, format, markdownFn) {
  if (format === "json") return ok(jsonText(data));
  return ok(markdownFn());
}

function jsonText(data) {
  const compact = JSON.stringify(data);
  return compact.length > PRETTY_PRINT_MAX_BYTES ? compact : JSON.stringify(data, null, 2);
}

/** Format a Wave Money object as e.g. `$1,234.56 CAD`. */
function money(value) {
  if (!value || value.value == null) return "-";
  const code = value.currency?.code ?? "";
  const symbol = value.currency?.symbol ?? "";
  return `${symbol}${value.value} ${code}`.trim();
}

function yesNo(value) {
  if (value == null) return "-";
  return value ? "yes" : "no";
}

/** Flatten an Address into a single comma-separated line. */
function addressLine(value) {
  if (!value) return "";
  return [
    value.addressLine1,
    value.addressLine2,
    value.city,
    value.province?.name,
    value.postalCode,
    value.country?.name,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Render (label, value) pairs as a markdown bullet list, skipping empties. */
function kvBlock(pairs) {
  return pairs
    .filter(([, value]) => value != null && value !== "" && value !== "-")
    .map(([label, value]) => `- **${label}:** ${value}`)
    .join("\n");
}

function cell(value) {
  if (value == null) return "-";
  if (typeof value === "boolean") return yesNo(value);
  // Pipes would break the table; newlines would break the row.
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Render rows as a markdown table. Columns are [header, key|fn]. */
function table(rows, columns) {
  if (!rows || rows.length === 0) return "_No records._";
  const headers = columns.map(([header]) => header);
  const body = rows.map((row) =>
    "| " + columns.map(([, accessor]) => cell(typeof accessor === "function" ? accessor(row) : row[accessor])).join(" | ") + " |"
  );
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...body,
  ].join("\n");
}

/** Describe where the caller is in a paginated set, and how to advance. */
function paginationFooter(result) {
  if (result.truncated) {
    return (
      `\n_Warning: stopped at the ${MAX_PAGES}-page safety ceiling after collecting ${result.count} record(s); ` +
      "the list may be incomplete. Page through with `page=N` instead of fetch_all._"
    );
  }
  if (result.fetched_all) return `\n_Returned all ${result.count} record(s)._`;
  const totalPages = result.total_pages || 1;
  let line = `\n_Page ${result.page} of ${totalPages} - showing ${result.count}`;
  if (result.total_count != null) line += ` of ${result.total_count}`;
  line += " record(s)._";
  if (result.has_more) {
    line += ` Pass \`page=${result.next_page}\` for the next page, or \`fetch_all=true\` to retrieve every record.`;
  }
  return line;
}

/** Standard markdown rendering for a paginated list of records. */
function listing(result, title, columns, emptyHint = "") {
  if (!result.items || result.items.length === 0) {
    return `**${title}**\n\nNo records found. ${emptyHint}`.trimEnd();
  }
  return `**${title}**\n\n${table(result.items, columns)}\n${paginationFooter(result)}`;
}

/** Standard confirmation for a successful mutation. */
function success(message, pairs = []) {
  const block = kvBlock(pairs);
  return block ? `${message}\n\n${block}` : message;
}

// --- Input normalizers ---

const DECIMAL_HINT =
  'Decimal amount as a string, e.g. "150.00". Strings avoid the binary-float rounding that turns 0.1 + 0.2 into 0.30000000000000004.';

/** Render a money/decimal argument as a string. */
function decimalStr(value) {
  return value == null ? undefined : String(value);
}

function optionalAddress(a = {}) {
  const address = {
    addressLine1: a.address_line1,
    addressLine2: a.address_line2,
    city: a.city,
    provinceCode: a.province_code,
    countryCode: a.country_code ? a.country_code.toUpperCase() : undefined,
    postalCode: a.postal_code,
  };
  const populated = Object.fromEntries(Object.entries(address).filter(([, v]) => v != null));
  // Wave rejects an address object whose fields are all null, so an empty
  // address has to be omitted entirely rather than sent as {}.
  return Object.keys(populated).length ? populated : undefined;
}

function optionalShipping(s = {}) {
  const shipping = {
    name: s.shipping_name,
    phone: s.shipping_phone,
    instructions: s.shipping_instructions,
    address: optionalAddress({
      address_line1: s.shipping_address_line1,
      address_line2: s.shipping_address_line2,
      city: s.shipping_city,
      province_code: s.shipping_province_code,
      country_code: s.shipping_country_code,
      postal_code: s.shipping_postal_code,
    }),
  };
  const populated = Object.fromEntries(Object.entries(shipping).filter(([, v]) => v != null));
  return Object.keys(populated).length ? populated : undefined;
}

function compact(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([, v]) => v != null));
}

/**
 * Validate and normalize invoice/estimate line items.
 *
 * Wave requires productId on every line: a line item is always tied to a
 * product, and description/price merely override that product's defaults.
 * Validating here produces a far clearer message than Wave's own.
 */
function normalizeLineItems(items, context, { allowName = false } = {}) {
  if (!items || items.length === 0) {
    throw new WaveError(
      `At least one ${context.toLowerCase()} line item is required. Supply a list such as ` +
        '[{"productId": "...", "quantity": 1, "unitPrice": "10.00"}].'
    );
  }
  return items.map((item, index) => {
    const productId = item.productId ?? item.product_id;
    if (!productId) {
      throw new WaveError(
        `${context} item ${index + 1} is missing productId. Every Wave line item must reference a product -- ` +
          "call wave_list_products to find one, or wave_create_product to add it."
      );
    }
    const entry = { productId };
    if (item.description != null) entry.description = item.description;
    if (allowName && item.name != null) entry.name = item.name;
    if (item.quantity != null) entry.quantity = String(item.quantity);
    const unitPrice = item.unitPrice ?? item.unit_price;
    if (unitPrice != null) entry.unitPrice = String(unitPrice);
    if (item.taxes && item.taxes.length) {
      entry.taxes = item.taxes.map((tax) => normalizeItemTax(tax, context, index));
    }
    return entry;
  });
}

function normalizeItemTax(tax, context, index) {
  if (typeof tax === "string") return { salesTaxId: tax };
  const salesTaxId = tax?.salesTaxId ?? tax?.sales_tax_id ?? tax?.id;
  if (!salesTaxId) {
    throw new WaveError(
      `${context} item ${index + 1} has a tax entry without salesTaxId. Call wave_list_sales_taxes to find the ID.`
    );
  }
  const entry = { salesTaxId };
  if (tax.amount != null) entry.amount = String(tax.amount);
  return entry;
}

/**
 * Drop tax `amount` fields for estimates.
 *
 * EstimateCreateItemTaxInput accepts only salesTaxId; the invoice equivalent
 * also takes amount. Sharing the normalizer and trimming here keeps one code
 * path for both.
 */
function stripEstimateItemTaxes(items) {
  return items.map((item) => {
    if (!item.taxes) return item;
    return { ...item, taxes: item.taxes.map((t) => ({ salesTaxId: t.salesTaxId })) };
  });
}

/**
 * Validate discount entries. A discount is either FIXED with an amount or
 * PERCENTAGE with a percentage; the type is inferred when omitted.
 */
function normalizeDiscounts(discounts, context) {
  if (!discounts || discounts.length === 0) return undefined;
  return discounts.map((discount, index) => {
    const amount = discount.amount;
    const percentage = discount.percentage;
    const type = String(
      discount.discountType ?? discount.discount_type ?? (percentage != null ? "PERCENTAGE" : "FIXED")
    ).toUpperCase();
    if (type !== "FIXED" && type !== "PERCENTAGE") {
      throw new WaveError(`${context} discount ${index + 1} has discountType '${type}'; expected FIXED or PERCENTAGE.`);
    }
    if (type === "FIXED" && amount == null) {
      throw new WaveError(`${context} discount ${index + 1} is FIXED but has no amount.`);
    }
    if (type === "PERCENTAGE" && percentage == null) {
      throw new WaveError(`${context} discount ${index + 1} is PERCENTAGE but has no percentage.`);
    }
    const entry = { discountType: type };
    if (discount.name != null) entry.name = discount.name;
    if (amount != null) entry.amount = String(amount);
    if (percentage != null) entry.percentage = String(percentage);
    return entry;
  });
}

/** Accept a single address or a list, and return a non-empty list. */
function normalizeRecipients(to, context) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean).map(String);
  if (recipients.length === 0) {
    throw new WaveError(`${context} needs at least one recipient email address.`);
  }
  return recipients;
}

function externalId(prefix, supplied) {
  if (supplied) return supplied;
  // Wave dedupes on externalId, so a caller-supplied value makes retries safe.
  // When none is given, a timestamped value keeps calls apart -- plus a random
  // tail, because two creates inside the same millisecond would otherwise share
  // an id and Wave would silently drop the second as a duplicate.
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  let random = "";
  if (globalThis.crypto?.getRandomValues) {
    random = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)), (byte) =>
      byte.toString(36).padStart(2, "0")
    ).join("");
  }
  return `${prefix}-${timestamp}${random ? `-${random}` : ""}`;
}

/**
 * Warn early when line items do not sum to the anchor amount.
 *
 * Wave rejects an unbalanced transaction, but its error names neither figure.
 * Comparing here produces a message that says exactly what is off, and by how
 * much. Compared in minor units to avoid float drift.
 */
function assertBalanced(anchorAmount, lineItems, context) {
  const toMinor = (v) => Math.round(Number.parseFloat(v) * 100);
  const anchor = toMinor(anchorAmount);
  if (!Number.isFinite(anchor)) return;
  let total = 0;
  for (const item of lineItems) {
    const value = toMinor(item.amount);
    if (!Number.isFinite(value)) return;
    total += value;
  }
  if (anchor !== total) {
    const fmt = (minor) => (minor / 100).toFixed(2);
    throw new WaveError(
      `${context} does not balance: the anchor amount is ${fmt(anchor)} but the line items total ` +
        `${fmt(total)} (a difference of ${fmt(anchor - total)}). Every line item amount must add up to the anchor amount.`
    );
  }
}

function normalizeTransactionLineItems(lineItems, context) {
  if (!lineItems || lineItems.length === 0) {
    throw new WaveError(
      "At least one line item is required. Each needs an accountId and an amount, and together they must total the anchor amount."
    );
  }
  return lineItems.map((item, index) => {
    const accountId = item.accountId ?? item.account_id;
    if (!accountId) {
      throw new WaveError(
        `${context} line item ${index + 1} is missing accountId. Call wave_list_accounts to find the category account.`
      );
    }
    if (item.amount == null) {
      throw new WaveError(`${context} line item ${index + 1} is missing amount.`);
    }
    const entry = {
      accountId,
      amount: String(item.amount),
      balance: String(item.balance ?? "INCREASE").toUpperCase(),
    };
    const customerId = item.customerId ?? item.customer_id;
    if (customerId) entry.customerId = customerId;
    if (item.description != null) entry.description = item.description;
    if (item.taxes && item.taxes.length) {
      entry.taxes = item.taxes.map((tax) => {
        const salesTaxId = tax.salesTaxId ?? tax.sales_tax_id;
        if (!salesTaxId || tax.amount == null) {
          throw new WaveError(
            `${context} line item ${index + 1} tax entries need both salesTaxId and amount.`
          );
        }
        return { salesTaxId, amount: String(tax.amount) };
      });
    }
    return entry;
  });
}

// --- Tool registration ---

// Every tool this server knows about, registered or not. Write tools stay in
// the catalog while gated off so wave_auth_status can report how many are
// hidden and why.
const toolCatalog = new Map();
// The subset actually exposed over MCP.
const registeredTools = new Set();

function writesAllowed() {
  return allowWrites;
}

function humanizeToolName(name) {
  const words = name.replace(/^wave_/, "").split("_");
  return `Wave: ${words.map((w) => (w === "pdf" ? "PDF" : w.charAt(0).toUpperCase() + w.slice(1))).join(" ")}`;
}

/**
 * Register a tool with a consistent title and full annotation set.
 *
 * `openWorldHint` is always true: every tool reaches Wave's API. A read-only
 * tool is idempotent by definition, so that hint is derived rather than
 * repeated at each call site.
 */
function registerTool(name, config, handler) {
  const readOnly = !!config.readOnly;
  const completed = {
    title: config.title ?? humanizeToolName(name),
    description: config.description,
    inputSchema: config.inputSchema ?? {},
    // Declared per tool; the SDK then validates every successful
    // structuredContent against it before responding.
    outputSchema: config.outputSchema,
    annotations: {
      title: config.title ?? humanizeToolName(name),
      readOnlyHint: readOnly,
      destructiveHint: !!config.destructive,
      idempotentHint: readOnly || !!config.idempotent,
      openWorldHint: true,
    },
  };

  const wrapped = async (args = {}) => {
    try {
      return await handler(args);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: sanitizeErrorMessage(error?.message ?? String(error)) }],
      };
    }
  };

  toolCatalog.set(name, { config: completed, isWrite: !readOnly });
  registeredTools.add(name);
  server.registerTool(name, completed, wrapped);
}

/**
 * Register a tool that changes data in Wave.
 *
 * Write tools stay unregistered unless WAVE_ALLOW_WRITES is set. Wave has
 * genuinely irreversible operations -- deleting an invoice, emailing a
 * customer -- so the default install is read-only and opting in is explicit.
 */
function registerWriteTool(name, config, handler) {
  toolCatalog.set(name, { config: { ...config, title: config.title ?? humanizeToolName(name) }, isWrite: true });
  if (!writesAllowed()) return;
  registerTool(name, config, handler);
}

// Shared zod pieces, so every tool describes these the same way.
const responseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe('Output format: "markdown" for a compact human-readable summary, "json" for the complete record.');

const pageSchema = z.number().int().min(1).default(1).describe("1-based page number for offset pagination.");

const pageSizeSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .default(DEFAULT_PAGE_SIZE)
  .describe(`Records per page (1-${MAX_PAGE_SIZE}).`);

const fetchAllSchema = z
  .boolean()
  .default(false)
  .describe("Walk every page instead of returning just one. Slower, but complete.");

const businessIdSchema = z
  .string()
  .optional()
  .describe("Business to operate on. Defaults to the session business set by wave_set_default_business.");

const paginationSchema = {
  page: pageSchema,
  page_size: pageSizeSchema,
  fetch_all: fetchAllSchema,
  response_format: responseFormatSchema,
};

// --- Tools: reference data ---

const Q_USER = `query GetUser { user { id firstName lastName defaultEmail createdAt modifiedAt } }`;
const Q_CURRENCIES = `query ListCurrencies { currencies { code symbol name plural exponent } }`;
const Q_CURRENCY = `query GetCurrency($code: CurrencyCode!) { currency(code: $code) { code symbol name plural exponent } }`;
const Q_COUNTRIES = `query ListCountries { countries { code name nameWithArticle currency { code symbol } } }`;
const Q_COUNTRY = gql(`
query GetCountry($code: CountryCode!) {
  country(code: $code) {
    code
    name
    nameWithArticle
    currency { code symbol name }
    provinces { code name slug }
  }
}`);
const Q_PROVINCE = `query GetProvince($code: String!) { province(code: $code) { code name slug } }`;
const Q_ACCOUNT_TYPES = `query ListAccountTypes { accountTypes { name value normalBalanceType } }`;
const Q_ACCOUNT_SUBTYPES = gql(`
query ListAccountSubtypes {
  accountSubtypes {
    name
    value
    description
    archivable
    systemCreated
    type { name value normalBalanceType }
  }
}`);
const Q_OAUTH_APP = gql(`
query GetOAuthApplication {
  oAuthApplication { id name description clientId logoUrl createdAt modifiedAt }
}`);

// Output contract for wave_auth_status. It is the one tool whose result is a
// stable, machine-consumed shape rather than Wave entity data, so it carries a
// real outputSchema: the SDK validates every successful response against it,
// and clients can parse structuredContent without scraping markdown.
const authStatusOutputSchema = {
  has_credentials: z.boolean(),
  token_source: z.string().nullable(),
  writes_enabled: z.boolean(),
  default_business_id: z.string().nullable(),
  detected_agent: z.string(),
  config_fallback_disabled: z.boolean(),
  sources_checked: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      path: z.string().nullable(),
      found: z.boolean(),
    })
  ),
  lookup_errors: z.array(z.string()),
  registered_tools: z.number().int(),
  write_tools_hidden: z.number().int(),
  next_step: z.string().optional(),
};

registerTool(
  "wave_auth_status",
  {
    readOnly: true,
    description:
      "Report how this server resolved its Wave credentials and whether write tools are enabled. Makes no Wave API request, so it works even when the token is missing or expired -- use it first when other tools report authentication problems.",
    outputSchema: authStatusOutputSchema,
  },
  async () => {
    const status = {
      has_credentials: hasCredentials,
      token_source: runtime.tokenSource ?? null,
      writes_enabled: writesAllowed(),
      default_business_id: sessionBusinessId ?? null,
      detected_agent: runtime.detected_agent ?? "unknown",
      config_fallback_disabled: runtime.config_fallback_disabled ?? false,
      sources_checked: runtime.sources_checked ?? [],
      lookup_errors: runtime.lookup_errors ?? [],
      registered_tools: registeredTools.size,
      write_tools_hidden: [...toolCatalog.keys()].filter((name) => !registeredTools.has(name)).length,
    };
    if (!status.has_credentials) {
      status.next_step =
        "Set WAVE_ACCESS_TOKEN in your MCP client config, or set WAVE_ACCESS_TOKEN_FILE / WAVE_OP_PATH. Create a token at https://developer.waveapps.com/.";
    } else if (!status.writes_enabled) {
      status.next_step =
        "Read tools are active. Set WAVE_ALLOW_WRITES=1 to enable the tools that create, change, delete, or email records.";
    }
    return {
      content: [{ type: "text", text: jsonText(status) }],
      structuredContent: status,
    };
  }
);

registerTool(
  "wave_get_user",
  {
    readOnly: true,
    description:
      "Get the Wave user account that owns the current access token. Useful for confirming which account a token authenticates as.",
    inputSchema: { response_format: responseFormatSchema },
  },
  async ({ response_format = "markdown" }) => {
    const data = await waveFetch(Q_USER);
    const user = data.user;
    if (!user) return ok("Wave returned no user for this token. The token may be invalid or revoked.");
    return render(user, response_format, () => {
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
      return `**${name || "Wave user"}**\n\n${kvBlock([
        ["ID", `\`${user.id}\``],
        ["Email", user.defaultEmail],
        ["Created", user.createdAt],
        ["Modified", user.modifiedAt],
      ])}`;
    });
  }
);

registerTool(
  "wave_list_currencies",
  {
    readOnly: true,
    description:
      "List the currency codes Wave supports. Wave supports about 160 currencies, so pass search to narrow the list.",
    inputSchema: {
      search: z.string().optional().describe('Case-insensitive filter on code or name, e.g. "CAD" or "dollar".'),
      response_format: responseFormatSchema,
    },
  },
  async ({ search, response_format = "markdown" }) => {
    const data = await waveFetch(Q_CURRENCIES);
    let currencies = data.currencies || [];
    if (search) {
      const needle = search.toLowerCase();
      currencies = currencies.filter(
        (c) => c.code.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle)
      );
    }
    return render(currencies, response_format, () => {
      if (!currencies.length) return `No currencies matched \`${search}\`.`;
      return `**Currencies** (${currencies.length} shown)\n\n${table(currencies, [
        ["Code", "code"],
        ["Name", "name"],
        ["Symbol", "symbol"],
        ["Decimal places", "exponent"],
      ])}`;
    });
  }
);

registerTool(
  "wave_get_currency",
  {
    readOnly: true,
    description: "Get one currency by ISO 4217 code.",
    inputSchema: {
      code: z.string().describe('Currency code such as "USD", "CAD", or "EUR".'),
      response_format: responseFormatSchema,
    },
  },
  async ({ code, response_format = "markdown" }) => {
    const data = await waveFetch(Q_CURRENCY, { code: code.toUpperCase() });
    const currency = data.currency;
    if (!currency) return ok(`No currency found for code \`${code}\`. Call wave_list_currencies to see valid codes.`);
    return render(currency, response_format, () =>
      `**${currency.name} (${currency.code})**\n\n${kvBlock([
        ["Symbol", currency.symbol],
        ["Plural", currency.plural],
        ["Decimal places", currency.exponent],
      ])}`
    );
  }
);

registerTool(
  "wave_list_countries",
  {
    readOnly: true,
    description: "List the countries Wave supports, with each one's default currency.",
    inputSchema: {
      search: z.string().optional().describe("Case-insensitive filter on country code or name."),
      response_format: responseFormatSchema,
    },
  },
  async ({ search, response_format = "markdown" }) => {
    const data = await waveFetch(Q_COUNTRIES);
    let countries = data.countries || [];
    if (search) {
      const needle = search.toLowerCase();
      countries = countries.filter(
        (c) => c.code.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle)
      );
    }
    return render(countries, response_format, () => {
      if (!countries.length) return `No countries matched \`${search}\`.`;
      return `**Countries** (${countries.length} shown)\n\n${table(countries, [
        ["Code", "code"],
        ["Name", "name"],
        ["Currency", (r) => r.currency?.code ?? "-"],
      ])}`;
    });
  }
);

registerTool(
  "wave_get_country",
  {
    readOnly: true,
    description:
      "Get one country and its provinces or states. Use this to find the province codes that address fields expect.",
    inputSchema: {
      code: z.string().describe('ISO 3166-1 alpha-2 code such as "US", "CA", or "GB".'),
      response_format: responseFormatSchema,
    },
  },
  async ({ code, response_format = "markdown" }) => {
    const data = await waveFetch(Q_COUNTRY, { code: code.toUpperCase() });
    const country = data.country;
    if (!country) return ok(`No country found for code \`${code}\`. Call wave_list_countries to see valid codes.`);
    return render(country, response_format, () => {
      const head = `**${country.name} (${country.code})**\n\n${kvBlock([
        ["Default currency", `${country.currency?.code} (${country.currency?.name})`],
      ])}`;
      const provinces = country.provinces || [];
      if (!provinces.length) return head;
      return `${head}\n\n**Provinces / states** (${provinces.length})\n\n${table(provinces, [
        ["Code", "code"],
        ["Name", "name"],
      ])}`;
    });
  }
);

registerTool(
  "wave_get_province",
  {
    readOnly: true,
    description: "Get one province or state by its code.",
    inputSchema: {
      code: z.string().describe('Province code, typically country-qualified, e.g. "CA-ON" or "US-NY".'),
      response_format: responseFormatSchema,
    },
  },
  async ({ code, response_format = "markdown" }) => {
    const data = await waveFetch(Q_PROVINCE, { code });
    const province = data.province;
    if (!province) {
      return ok(
        `No province found for code \`${code}\`. Codes are usually country-qualified ("CA-ON", "US-NY"); call wave_get_country to list them.`
      );
    }
    return render(province, response_format, () =>
      `**${province.name}**\n\n${kvBlock([["Code", `\`${province.code}\``], ["Slug", province.slug]])}`
    );
  }
);

registerTool(
  "wave_list_account_types",
  {
    readOnly: true,
    description:
      "List the five top-level account types in Wave's chart of accounts: ASSET, LIABILITY, EQUITY, INCOME, and EXPENSE, each with its normal balance.",
    inputSchema: { response_format: responseFormatSchema },
  },
  async ({ response_format = "markdown" }) => {
    const data = await waveFetch(Q_ACCOUNT_TYPES);
    const types = data.accountTypes || [];
    return render(types, response_format, () =>
      `**Account types**\n\n${table(types, [
        ["Name", "name"],
        ["Value", "value"],
        ["Normal balance", "normalBalanceType"],
      ])}`
    );
  }
);

registerTool(
  "wave_list_account_subtypes",
  {
    readOnly: true,
    description:
      "List account subtypes -- the value wave_create_account needs. Every account belongs to a subtype (CASH_AND_BANK, EXPENSE, INCOME, ...), which in turn determines its type. Some subtypes are system-created and cannot be used for new accounts.",
    inputSchema: {
      account_type: z
        .string()
        .optional()
        .describe("Filter to one type: ASSET, LIABILITY, EQUITY, INCOME, EXPENSE."),
      creatable_only: z
        .boolean()
        .default(false)
        .describe("Exclude system-created subtypes unavailable to new accounts."),
      response_format: responseFormatSchema,
    },
  },
  async ({ account_type, creatable_only = false, response_format = "markdown" }) => {
    const data = await waveFetch(Q_ACCOUNT_SUBTYPES);
    let subtypes = data.accountSubtypes || [];
    if (account_type) {
      const wanted = account_type.toUpperCase();
      subtypes = subtypes.filter((s) => s.type?.value === wanted);
    }
    if (creatable_only) subtypes = subtypes.filter((s) => !s.systemCreated);
    return render(subtypes, response_format, () => {
      if (!subtypes.length) {
        return "No account subtypes matched. Valid account_type values are ASSET, LIABILITY, EQUITY, INCOME, EXPENSE.";
      }
      return `**Account subtypes** (${subtypes.length} shown)\n\n${table(subtypes, [
        ["Subtype", "value"],
        ["Name", "name"],
        ["Type", (r) => r.type?.value ?? "-"],
        ["Archivable", (r) => yesNo(r.archivable)],
        ["System", (r) => yesNo(r.systemCreated)],
      ])}`;
    });
  }
);

registerTool(
  "wave_get_oauth_application",
  {
    readOnly: true,
    description: "Get the OAuth application that issued the current access token.",
    inputSchema: { response_format: responseFormatSchema },
  },
  async ({ response_format = "markdown" }) => {
    const data = await waveFetch(Q_OAUTH_APP);
    const app = data.oAuthApplication;
    if (!app) {
      return ok(
        "Wave returned no OAuth application for this token. Personal access tokens are not tied to an application, so this is expected unless the token came from an OAuth flow."
      );
    }
    return render(app, response_format, () =>
      `**${app.name}**\n\n${kvBlock([
        ["ID", `\`${app.id}\``],
        ["Client ID", `\`${app.clientId}\``],
        ["Description", app.description],
        ["Logo URL", app.logoUrl],
        ["Created", app.createdAt],
        ["Modified", app.modifiedAt],
      ])}`
    );
  }
);

// --- Tools: businesses ---

const Q_LIST_BUSINESSES = gql(
  `
query ListBusinesses($page: Int!, $pageSize: Int!, $isArchived: Boolean) {
  businesses(page: $page, pageSize: $pageSize, isArchived: $isArchived) {
    pageInfo { ...PageInfoFields }
    edges {
      node {
        id
        name
        isPersonal
        isClassicAccounting
        isClassicInvoicing
        isArchived
        currency { code symbol }
        type { name value }
        subtype { name value }
      }
    }
  }
}`,
  "pageInfo"
);

const Q_GET_BUSINESS = gql(
  `query GetBusiness($id: ID!) { business(id: $id) { ...BusinessFields } }`,
  ...BUSINESS_SET
);

const Q_SETTINGS = gql(`
query GetInvoiceEstimateSettings($id: ID!) {
  business(id: $id) {
    id
    name
    emailSendEnabled
    invoiceEstimateSettings { generalSettings { accentColor logoUrl } }
  }
}`);

registerTool(
  "wave_list_businesses",
  {
    readOnly: true,
    description:
      "List the Wave businesses this access token can reach. Start here: every other tool needs a business ID. Pass one to wave_set_default_business so later calls can omit it.",
    inputSchema: {
      is_archived: z.boolean().optional().describe("Filter to archived (true) or active (false) businesses."),
      ...paginationSchema,
    },
  },
  async ({ is_archived, page = 1, page_size = DEFAULT_PAGE_SIZE, fetch_all = false, response_format = "markdown" }) => {
    const result = await walkPages(Q_LIST_BUSINESSES, { isArchived: is_archived }, ["businesses"], {
      page,
      pageSize: page_size,
      fetchAll: fetch_all,
    });
    return render(result, response_format, () =>
      listing(result, "Wave businesses", [
        ["Name", "name"],
        ["ID", "id"],
        ["Currency", (r) => r.currency?.code ?? "-"],
        ["Type", (r) => r.type?.name ?? "-"],
        ["Personal", (r) => yesNo(r.isPersonal)],
        ["Archived", (r) => yesNo(r.isArchived)],
      ])
    );
  }
);

registerTool(
  "wave_get_business",
  {
    readOnly: true,
    description: "Get full detail for one business: currency, address, type, and settings.",
    inputSchema: { business_id: businessIdSchema, response_format: responseFormatSchema },
  },
  async ({ business_id, response_format = "markdown" }) => {
    const resolved = requireBusinessId(business_id);
    const data = await waveFetch(Q_GET_BUSINESS, { id: resolved });
    const business = data.business;
    if (!business) {
      return ok(`No business found with ID \`${resolved}\`. Call wave_list_businesses to see valid IDs.`);
    }
    return render(business, response_format, () =>
      `**${business.name}**\n\n${kvBlock([
        ["ID", `\`${business.id}\``],
        ["Currency", `${business.currency?.code} (${business.currency?.name})`],
        ["Type", business.type?.name],
        ["Subtype", business.subtype?.name],
        ["Organizational type", business.organizationalType],
        ["Address", addressLine(business.address)],
        ["Phone", business.phone],
        ["Mobile", business.mobile],
        ["Fax", business.fax],
        ["Toll free", business.tollFree],
        ["Website", business.website],
        ["Timezone", business.timezone],
        ["Email sending enabled", yesNo(business.emailSendEnabled)],
        ["Classic accounting", yesNo(business.isClassicAccounting)],
        ["Classic invoicing", yesNo(business.isClassicInvoicing)],
        ["Personal", yesNo(business.isPersonal)],
        ["Archived", yesNo(business.isArchived)],
        ["Created", business.createdAt],
        ["Modified", business.modifiedAt],
      ])}`
    );
  }
);

registerTool(
  "wave_set_default_business",
  {
    readOnly: false,
    idempotent: true,
    description:
      "Set the business that later tool calls use when none is given. This is session state on the running server, not a change in Wave. Set WAVE_BUSINESS_ID in the environment to make it persist across restarts.",
    inputSchema: { business_id: z.string().describe("The Wave business ID to make the default.") },
  },
  async ({ business_id }) => {
    const data = await waveFetch(Q_GET_BUSINESS, { id: business_id });
    const business = data.business;
    if (!business) {
      return ok(
        `No business found with ID \`${business_id}\`, so the default is unchanged. Call wave_list_businesses to see valid IDs.`
      );
    }
    sessionBusinessId = business_id;
    return ok(
      `Default business set to **${business.name}** (\`${business_id}\`). Later calls can omit business_id.`
    );
  }
);

registerTool(
  "wave_get_invoice_estimate_settings",
  {
    readOnly: true,
    description: "Get the branding applied to invoices and estimates: accent color and logo.",
    inputSchema: { business_id: businessIdSchema, response_format: responseFormatSchema },
  },
  async ({ business_id, response_format = "markdown" }) => {
    const resolved = requireBusinessId(business_id);
    const data = await waveFetch(Q_SETTINGS, { id: resolved });
    const business = data.business || {};
    const settings = business.invoiceEstimateSettings?.generalSettings || {};
    return render(business, response_format, () =>
      `**Invoice and estimate settings**\n\n${kvBlock([
        ["Business", business.name],
        ["Accent color", settings.accentColor],
        ["Logo URL", settings.logoUrl],
        ["Email sending enabled", yesNo(business.emailSendEnabled)],
      ])}`
    );
  }
);

// --- Tools: chart of accounts ---

const Q_LIST_ACCOUNTS = gql(
  `
query ListAccounts(
  $businessId: ID!
  $page: Int!
  $pageSize: Int!
  $types: [AccountTypeValue!]
  $subtypes: [AccountSubtypeValue!]
  $excludedSubtypes: [AccountSubtypeValue!]
  $isArchived: Boolean
) {
  business(id: $businessId) {
    id
    accounts(
      page: $page
      pageSize: $pageSize
      types: $types
      subtypes: $subtypes
      excludedSubtypes: $excludedSubtypes
      isArchived: $isArchived
    ) {
      pageInfo { ...PageInfoFields }
      edges { node { ...AccountFields } }
    }
  }
}`,
  "pageInfo",
  "account"
);

const Q_GET_ACCOUNT = gql(
  `query GetAccount($businessId: ID!, $id: ID!) { business(id: $businessId) { id account(id: $id) { ...AccountFields } } }`,
  "account"
);

const M_CREATE_ACCOUNT = gql(
  `
mutation CreateAccount($input: AccountCreateInput!) {
  accountCreate(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    account { ...AccountFields }
  }
}`,
  "account"
);

const M_PATCH_ACCOUNT = gql(
  `
mutation PatchAccount($input: AccountPatchInput!) {
  accountPatch(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    account { ...AccountFields }
  }
}`,
  "account"
);

const M_ARCHIVE_ACCOUNT = gql(`
mutation ArchiveAccount($input: AccountArchiveInput!) {
  accountArchive(input: $input) { didSucceed ${INPUT_ERRORS} }
}`);

const ACCOUNT_COLUMNS = [
  ["Name", "name"],
  ["ID", "id"],
  ["Type", (r) => r.type?.name ?? "-"],
  ["Subtype", (r) => r.subtype?.name ?? "-"],
  ["Balance", "balance"],
  ["Currency", (r) => r.currency?.code ?? "-"],
  ["Archived", (r) => yesNo(r.isArchived)],
];

function accountDetail(account) {
  return `**${account.name}**\n\n${kvBlock([
    ["ID", `\`${account.id}\``],
    ["Display ID", account.displayId],
    ["Description", account.description],
    ["Type", account.type?.name],
    ["Subtype", account.subtype?.name],
    ["Normal balance", account.normalBalanceType],
    ["Balance", account.balance],
    ["Balance in business currency", account.balanceInBusinessCurrency],
    ["Currency", account.currency?.code],
    ["Sequence", account.sequence],
    ["Archived", yesNo(account.isArchived)],
  ])}`;
}

registerTool(
  "wave_list_accounts",
  {
    readOnly: true,
    description:
      "List the chart of accounts, with balances. Filter by type to find the account a transaction needs: EXPENSE for expense categories, INCOME for revenue, ASSET with subtype CASH_AND_BANK for bank accounts, LIABILITY with subtype CREDIT_CARD for cards.",
    inputSchema: {
      business_id: businessIdSchema,
      types: z.array(z.string()).optional().describe("Filter by type: ASSET, LIABILITY, EQUITY, INCOME, EXPENSE."),
      subtypes: z.array(z.string()).optional().describe('Filter by subtype, e.g. ["CASH_AND_BANK", "CREDIT_CARD"].'),
      excluded_subtypes: z.array(z.string()).optional().describe("Subtypes to omit."),
      is_archived: z.boolean().optional().describe("Filter to archived (true) or active (false) accounts."),
      ...paginationSchema,
    },
  },
  async ({
    business_id,
    types,
    subtypes,
    excluded_subtypes,
    is_archived,
    page = 1,
    page_size = DEFAULT_PAGE_SIZE,
    fetch_all = false,
    response_format = "markdown",
  }) => {
    const resolved = requireBusinessId(business_id);
    const result = await walkPages(
      Q_LIST_ACCOUNTS,
      compact({
        businessId: resolved,
        types: types?.map((t) => t.toUpperCase()),
        subtypes: subtypes?.map((s) => s.toUpperCase()),
        excludedSubtypes: excluded_subtypes?.map((s) => s.toUpperCase()),
        isArchived: is_archived,
      }),
      ["business", "accounts"],
      { page, pageSize: page_size, fetchAll: fetch_all }
    );
    return render(result, response_format, () => listing(result, "Chart of accounts", ACCOUNT_COLUMNS));
  }
);

registerTool(
  "wave_get_account",
  {
    readOnly: true,
    description: "Get one account by ID, including its current balance.",
    inputSchema: {
      account_id: z.string().describe("The Wave account ID."),
      business_id: businessIdSchema,
      response_format: responseFormatSchema,
    },
  },
  async ({ account_id, business_id, response_format = "markdown" }) => {
    const resolved = requireBusinessId(business_id);
    const data = await waveFetch(Q_GET_ACCOUNT, { businessId: resolved, id: account_id });
    const account = data.business?.account;
    if (!account) return ok(`No account found with ID \`${account_id}\` in this business.`);
    return render(account, response_format, () => accountDetail(account));
  }
);

registerWriteTool(
  "wave_create_account",
  {
    description:
      "Create an account in the chart of accounts. The subtype determines the account's type: pick it with wave_list_account_subtypes. Common choices are EXPENSE, INCOME, CASH_AND_BANK, CREDIT_CARD, and COST_OF_GOODS_SOLD.",
    inputSchema: {
      name: z.string().describe('Account name, e.g. "Software Subscriptions".'),
      subtype: z.string().describe('Subtype value such as "EXPENSE" or "CASH_AND_BANK".'),
      business_id: businessIdSchema,
      description: z.string().optional().describe("Optional longer description."),
      display_id: z.string().optional().describe("Optional account number used for ordering and reports."),
      currency: z.string().optional().describe("Currency code. Defaults to the business currency."),
      can_archive: z.boolean().optional().describe("Whether the account may be archived later."),
      response_format: responseFormatSchema,
    },
  },
  async ({ name, subtype, business_id, description, display_id, currency, can_archive, response_format = "markdown" }) => {
    const resolved = requireBusinessId(business_id);
    const input = compact({
      businessId: resolved,
      name,
      subtype: subtype.toUpperCase(),
      description,
      displayId: display_id,
      currency: currency?.toUpperCase(),
      restrictions: can_archive == null ? undefined : { canArchive: can_archive },
    });
    const result = await waveMutate(M_CREATE_ACCOUNT, { input }, "accountCreate");
    const account = result.account || {};
    return render(account, response_format, () =>
      success(`Created account **${account.name ?? name}**.`, [
        ["ID", `\`${account.id}\``],
        ["Type", account.type?.name],
        ["Subtype", account.subtype?.name],
        ["Currency", account.currency?.code],
      ])
    );
  }
);

registerWriteTool(
  "wave_patch_account",
  {
    idempotent: true,
    description:
      "Update an account's name, description, or display ID. Wave requires the account's current sequence as an optimistic-concurrency check, so read the account first with wave_get_account and pass the value it returns. Only the fields you supply are changed.",
    inputSchema: {
      account_id: z.string().describe("The account to update."),
      sequence: z.number().int().describe("The account's current sequence, from wave_get_account."),
      name: z.string().optional().describe("New name."),
      description: z.string().optional().describe("New description."),
      display_id: z.string().optional().describe("New display ID / account number."),
      response_format: responseFormatSchema,
    },
  },
  async ({ account_id, sequence, name, description, display_id, response_format = "markdown" }) => {
    const input = compact({ id: account_id, sequence, name, description, displayId: display_id });
    if (Object.keys(input).length <= 2) {
      return ok("Nothing to update. Supply at least one of name, description, or display_id.");
    }
    const result = await waveMutate(M_PATCH_ACCOUNT, { input }, "accountPatch");
    const account = result.account || {};
    return render(account, response_format, () =>
      success(`Updated account **${account.name}**.`, [["ID", `\`${account.id}\``]])
    );
  }
);

registerWriteTool(
  "wave_archive_account",
  {
    destructive: true,
    idempotent: true,
    description:
      "Archive an account, hiding it from pickers while keeping its history. Wave has no delete for accounts, and no un-archive through the API: to restore one, use the Wave web app. Accounts carrying a balance or created by Wave itself cannot be archived.",
    inputSchema: { account_id: z.string().describe("The account to archive.") },
  },
  async ({ account_id }) => {
    await waveMutate(M_ARCHIVE_ACCOUNT, { input: { id: account_id } }, "accountArchive");
    return ok(
      `Archived account \`${account_id}\`. Past transactions keep it; it no longer appears when categorizing. Restore it from the Wave web app.`
    );
  }
);

// --- Tools: customers ---

const Q_LIST_CUSTOMERS = gql(
  `
query ListCustomers(
  $businessId: ID!
  $page: Int!
  $pageSize: Int!
  $sort: [CustomerSort!]!
  $email: String
  $modifiedAtAfter: DateTime
  $modifiedAtBefore: DateTime
) {
  business(id: $businessId) {
    id
    customers(
      page: $page
      pageSize: $pageSize
      sort: $sort
      email: $email
      modifiedAtAfter: $modifiedAtAfter
      modifiedAtBefore: $modifiedAtBefore
    ) {
      pageInfo { ...PageInfoFields }
      edges { node { ...CustomerFields } }
    }
  }
}`,
  "pageInfo",
  ...CUSTOMER_SET
);

const Q_GET_CUSTOMER = gql(
  `query GetCustomer($businessId: ID!, $id: ID!) { business(id: $businessId) { id customer(id: $id) { ...CustomerFields } } }`,
  ...CUSTOMER_SET
);

const M_CREATE_CUSTOMER = gql(
  `
mutation CreateCustomer($input: CustomerCreateInput!) {
  customerCreate(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    customer { ...CustomerFields }
  }
}`,
  ...CUSTOMER_SET
);

const M_PATCH_CUSTOMER = gql(
  `
mutation PatchCustomer($input: CustomerPatchInput!) {
  customerPatch(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    customer { ...CustomerFields }
  }
}`,
  ...CUSTOMER_SET
);

const M_DELETE_CUSTOMER = gql(`
mutation DeleteCustomer($input: CustomerDeleteInput!) {
  customerDelete(input: $input) { didSucceed ${INPUT_ERRORS} }
}`);

const CUSTOMER_COLUMNS = [
  ["Name", "name"],
  ["ID", "id"],
  ["Email", "email"],
  ["Phone", "phone"],
  ["Outstanding", (r) => money(r.outstandingAmount)],
  ["Overdue", (r) => money(r.overdueAmount)],
];

// Shared between create and patch: Wave's customer input is wide, and
// duplicating twenty fields per tool would drift.
const customerFieldSchema = {
  first_name: z.string().optional().describe("Contact first name."),
  last_name: z.string().optional().describe("Contact last name."),
  email: z.string().optional().describe("Email address, used when sending invoices."),
  phone: z.string().optional().describe("Phone number."),
  mobile: z.string().optional().describe("Mobile number."),
  fax: z.string().optional().describe("Fax number."),
  toll_free: z.string().optional().describe("Toll-free number."),
  website: z.string().optional().describe("Website URL."),
  display_id: z.string().optional().describe("Your own customer number."),
  internal_notes: z.string().optional().describe("Notes visible only to you."),
  currency: z.string().optional().describe("Currency code. Defaults to the business currency."),
  address_line1: z.string().optional().describe("Billing street address."),
  address_line2: z.string().optional().describe("Billing address line 2."),
  city: z.string().optional().describe("Billing city."),
  province_code: z.string().optional().describe('Billing province or state code, e.g. "CA-ON", "US-NY".'),
  country_code: z.string().optional().describe('Billing ISO country code, e.g. "US", "CA".'),
  postal_code: z.string().optional().describe("Billing postal or ZIP code."),
  shipping_name: z.string().optional().describe("Shipping recipient name."),
  shipping_phone: z.string().optional().describe("Shipping contact phone."),
  shipping_instructions: z.string().optional().describe("Delivery instructions."),
  shipping_address_line1: z.string().optional().describe("Shipping street address."),
  shipping_address_line2: z.string().optional().describe("Shipping address line 2."),
  shipping_city: z.string().optional().describe("Shipping city."),
  shipping_province_code: z.string().optional().describe("Shipping province or state code."),
  shipping_country_code: z.string().optional().describe("Shipping ISO country code."),
  shipping_postal_code: z.string().optional().describe("Shipping postal or ZIP code."),
};

function customerInputFrom(args) {
  return {
    firstName: args.first_name,
    lastName: args.last_name,
    email: args.email,
    phone: args.phone,
    mobile: args.mobile,
    fax: args.fax,
    tollFree: args.toll_free,
    website: args.website,
    displayId: args.display_id,
    internalNotes: args.internal_notes,
    currency: args.currency?.toUpperCase(),
    address: optionalAddress(args),
    shippingDetails: optionalShipping(args),
  };
}

function customerDetail(customer) {
  const shipping = customer.shippingDetails || {};
  return `**${customer.name}**\n\n${kvBlock([
    ["ID", `\`${customer.id}\``],
    ["Display ID", customer.displayId],
    ["First name", customer.firstName],
    ["Last name", customer.lastName],
    ["Email", customer.email],
    ["Phone", customer.phone],
    ["Mobile", customer.mobile],
    ["Fax", customer.fax],
    ["Toll free", customer.tollFree],
    ["Website", customer.website],
    ["Currency", customer.currency?.code],
    ["Address", addressLine(customer.address)],
    ["Shipping name", shipping.name],
    ["Shipping address", addressLine(shipping.address)],
    ["Shipping phone", shipping.phone],
    ["Shipping instructions", shipping.instructions],
    ["Internal notes", customer.internalNotes],
    ["Outstanding", money(customer.outstandingAmount)],
    ["Overdue", money(customer.overdueAmount)],
    ["Archived", yesNo(customer.isArchived)],
    ["Created", customer.createdAt],
    ["Modified", customer.modifiedAt],
  ])}`;
}

registerTool(
  "wave_list_customers",
  {
    readOnly: true,
    description:
      "List customers, with each one's outstanding and overdue balance. Wave can filter by exact email only; name_contains is applied by this server after fetching, so combine it with fetch_all=true when searching a large customer list.",
    inputSchema: {
      business_id: businessIdSchema,
      email: z.string().optional().describe("Exact email match, applied by Wave."),
      name_contains: z.string().optional().describe("Case-insensitive substring match on name, applied locally."),
      sort: z
        .array(z.string())
        .optional()
        .describe("NAME_ASC, NAME_DESC, CREATED_AT_ASC/DESC, MODIFIED_AT_ASC/DESC. Defaults to NAME_ASC."),
      modified_after: z.string().optional().describe("ISO 8601 timestamp; only customers changed after it."),
      modified_before: z.string().optional().describe("ISO 8601 timestamp; only customers changed before it."),
      ...paginationSchema,
    },
  },
  async ({
    business_id,
    email,
    name_contains,
    sort,
    modified_after,
    modified_before,
    page = 1,
    page_size = DEFAULT_PAGE_SIZE,
    fetch_all = false,
    response_format = "markdown",
  }) => {
    const resolved = requireBusinessId(business_id);
    let result = await walkPages(
      Q_LIST_CUSTOMERS,
      compact({
        businessId: resolved,
        sort: sort?.map((s) => s.toUpperCase()) ?? ["NAME_ASC"],
        email,
        modifiedAtAfter: modified_after,
        modifiedAtBefore: modified_before,
      }),
      ["business", "customers"],
      { page, pageSize: page_size, fetchAll: fetch_all }
    );
    if (name_contains) {
      const needle = name_contains.toLowerCase();
      const items = result.items.filter((c) => (c.name || "").toLowerCase().includes(needle));
      result = { ...result, items, count: items.length };
    }
    return render(result, response_format, () =>
      listing(
        result,
        "Customers",
        CUSTOMER_COLUMNS,
        name_contains ? "Wave filters customers by exact email only; pass fetch_all=true when searching by name." : ""
      )
    );
  }
);

registerTool(
  "wave_get_customer",
  {
    readOnly: true,
    description: "Get one customer by ID, including address and shipping details.",
    inputSchema: {
      customer_id: z.string().describe("The Wave customer ID."),
      business_id: businessIdSchema,
      response_format: responseFormatSchema,
    },
  },
  async ({ customer_id, business_id, response_format = "markdown" }) => {
    const resolved = requireBusinessId(business_id);
    const data = await waveFetch(Q_GET_CUSTOMER, { businessId: resolved, id: customer_id });
    const customer = data.business?.customer;
    if (!customer) return ok(`No customer found with ID \`${customer_id}\` in this business.`);
    return render(customer, response_format, () => customerDetail(customer));
  }
);

registerWriteTool(
  "wave_create_customer",
  {
    description: "Create a customer. Only the name is required. Customers are what invoices and estimates are billed to.",
    inputSchema: {
      name: z.string().describe("Customer or company name."),
      business_id: businessIdSchema,
      ...customerFieldSchema,
      response_format: responseFormatSchema,
    },
  },
  async (args) => {
    const resolved = requireBusinessId(args.business_id);
    const input = compact({ businessId: resolved, name: args.name, ...customerInputFrom(args) });
    const result = await waveMutate(M_CREATE_CUSTOMER, { input }, "customerCreate");
    const customer = result.customer || {};
    return render(customer, args.response_format ?? "markdown", () =>
      success(`Created customer **${customer.name ?? args.name}**.`, [
        ["ID", `\`${customer.id}\``],
        ["Email", customer.email],
      ])
    );
  }
);

registerWriteTool(
  "wave_patch_customer",
  {
    idempotent: true,
    description:
      "Update a customer. Only the fields you supply change. Address and shipping are replaced wholesale when any part of them is supplied, so include every line you want to keep.",
    inputSchema: {
      customer_id: z.string().describe("The customer to update."),
      name: z.string().optional().describe("New name."),
      ...customerFieldSchema,
      response_format: responseFormatSchema,
    },
  },
  async (args) => {
    const input = compact({ id: args.customer_id, name: args.name, ...customerInputFrom(args) });
    if (Object.keys(input).length === 1) {
      return ok("Nothing to update. Supply at least one field to change.");
    }
    const result = await waveMutate(M_PATCH_CUSTOMER, { input }, "customerPatch");
    const customer = result.customer || {};
    return render(customer, args.response_format ?? "markdown", () =>
      success(`Updated customer **${customer.name}**.`, [["ID", `\`${customer.id}\``]])
    );
  }
);

registerWriteTool(
  "wave_delete_customer",
  {
    destructive: true,
    idempotent: true,
    description:
      "Delete a customer. Wave archives rather than hard-deletes a customer that has invoices or transactions, so history is preserved either way. This cannot be undone through the API.",
    inputSchema: { customer_id: z.string().describe("The customer to delete.") },
  },
  async ({ customer_id }) => {
    await waveMutate(M_DELETE_CUSTOMER, { input: { id: customer_id } }, "customerDelete");
    return ok(
      `Deleted customer \`${customer_id}\`. Wave archives instead of deleting when the customer has invoices or transactions, so any history remains.`
    );
  }
);

// --- Tools: vendors (read-only; Wave's API has no vendor mutations) ---

const Q_LIST_VENDORS = gql(
  `
query ListVendors(
  $businessId: ID!
  $page: Int!
  $pageSize: Int!
  $email: String
  $modifiedAtAfter: DateTime
  $modifiedAtBefore: DateTime
) {
  business(id: $businessId) {
    id
    vendors(
      page: $page
      pageSize: $pageSize
      email: $email
      modifiedAtAfter: $modifiedAtAfter
      modifiedAtBefore: $modifiedAtBefore
    ) {
      pageInfo { ...PageInfoFields }
      edges { node { ...VendorFields } }
    }
  }
}`,
  "pageInfo",
  ...VENDOR_SET
);

const Q_GET_VENDOR = gql(
  `query GetVendor($businessId: ID!, $id: ID!) { business(id: $businessId) { id vendor(id: $id) { ...VendorFields } } }`,
  ...VENDOR_SET
);

const VENDOR_CREATE_HINT =
  "Wave's API has no vendor mutations, so vendors can only be added in the web app under Purchases > Vendors.";

registerTool(
  "wave_list_vendors",
  {
    readOnly: true,
    description:
      "List vendors -- the suppliers a business buys from. Vendors are read-only in Wave's API: they can be listed and read but not created, changed, or deleted. Wave filters by exact email only; name_contains is applied locally, so pair it with fetch_all=true on a long vendor list.",
    inputSchema: {
      business_id: businessIdSchema,
      email: z.string().optional().describe("Exact email match, applied by Wave."),
      name_contains: z.string().optional().describe("Case-insensitive substring match on name, applied locally."),
      modified_after: z.string().optional().describe("ISO 8601 timestamp; only vendors changed after it."),
      modified_before: z.string().optional().describe("ISO 8601 timestamp; only vendors changed before it."),
      ...paginationSchema,
    },
  },
  async ({
    business_id,
    email,
    name_contains,
    modified_after,
    modified_before,
    page = 1,
    page_size = DEFAULT_PAGE_SIZE,
    fetch_all = false,
    response_format = "markdown",
  }) => {
    const resolved = requireBusinessId(business_id);
    let result = await walkPages(
      Q_LIST_VENDORS,
      compact({
        businessId: resolved,
        email,
        modifiedAtAfter: modified_after,
        modifiedAtBefore: modified_before,
      }),
      ["business", "vendors"],
      { page, pageSize: page_size, fetchAll: fetch_all }
    );
    if (name_contains) {
      const needle = name_contains.toLowerCase();
      const items = result.items.filter((v) => (v.name || "").toLowerCase().includes(needle));
      result = { ...result, items, count: items.length };
    }
    return render(result, response_format, () =>
      listing(
        result,
        "Vendors",
        [
          ["Name", "name"],
          ["ID", "id"],
          ["Email", "email"],
          ["Phone", "phone"],
          ["Archived", (r) => yesNo(r.isArchived)],
        ],
        VENDOR_CREATE_HINT
      )
    );
  }
);

registerTool(
  "wave_get_vendor",
  {
    readOnly: true,
    description: "Get one vendor by ID, including address and shipping details.",
    inputSchema: {
      vendor_id: z.string().describe("The Wave vendor ID."),
      business_id: businessIdSchema,
      response_format: responseFormatSchema,
    },
  },
  async ({ vendor_id, business_id, response_format = "markdown" }) => {
    const resolved = requireBusinessId(business_id);
    const data = await waveFetch(Q_GET_VENDOR, { businessId: resolved, id: vendor_id });
    const vendor = data.business?.vendor;
    if (!vendor) return ok(`No vendor found with ID \`${vendor_id}\` in this business.`);
    return render(vendor, response_format, () => {
      const shipping = vendor.shippingDetails || {};
      return `**${vendor.name}**\n\n${kvBlock([
        ["ID", `\`${vendor.id}\``],
        ["Display ID", vendor.displayId],
        ["First name", vendor.firstName],
        ["Last name", vendor.lastName],
        ["Email", vendor.email],
        ["Phone", vendor.phone],
        ["Mobile", vendor.mobile],
        ["Fax", vendor.fax],
        ["Toll free", vendor.tollFree],
        ["Website", vendor.website],
        ["Currency", vendor.currency?.code],
        ["Address", addressLine(vendor.address)],
        ["Shipping name", shipping.name],
        ["Shipping address", addressLine(shipping.address)],
        ["Internal notes", vendor.internalNotes],
        ["Archived", yesNo(vendor.isArchived)],
        ["Created", vendor.createdAt],
        ["Modified", vendor.modifiedAt],
      ])}`;
    });
  }
);

// --- Tools: products ---

const Q_LIST_PRODUCTS = gql(
  `
query ListProducts(
  $businessId: ID!
  $page: Int!
  $pageSize: Int!
  $sort: [ProductSort!]!
  $isSold: Boolean
  $isBought: Boolean
  $isArchived: Boolean
  $modifiedAtAfter: DateTime
  $modifiedAtBefore: DateTime
) {
  business(id: $businessId) {
    id
    products(
      page: $page
      pageSize: $pageSize
      sort: $sort
      isSold: $isSold
      isBought: $isBought
      isArchived: $isArchived
      modifiedAtAfter: $modifiedAtAfter
      modifiedAtBefore: $modifiedAtBefore
    ) {
      pageInfo { ...PageInfoFields }
      edges { node { ...ProductFields } }
    }
  }
}`,
  "pageInfo",
  "product"
);

const Q_GET_PRODUCT = gql(
  `query GetProduct($businessId: ID!, $id: ID!) { business(id: $businessId) { id product(id: $id) { ...ProductFields } } }`,
  "product"
);

const M_CREATE_PRODUCT = gql(
  `
mutation CreateProduct($input: ProductCreateInput!) {
  productCreate(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    product { ...ProductFields }
  }
}`,
  "product"
);

const M_PATCH_PRODUCT = gql(
  `
mutation PatchProduct($input: ProductPatchInput!) {
  productPatch(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    product { ...ProductFields }
  }
}`,
  "product"
);

const M_ARCHIVE_PRODUCT = gql(`
mutation ArchiveProduct($input: ProductArchiveInput!) {
  productArchive(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    product { id name isArchived }
  }
}`);

registerTool(
  "wave_list_products",
  {
    readOnly: true,
    description:
      "List products and services. Invoice and estimate line items must reference a product, so this is the usual first step when building either one.",
    inputSchema: {
      business_id: businessIdSchema,
      is_sold: z.boolean().optional().describe("Only products sold to customers."),
      is_bought: z.boolean().optional().describe("Only products bought from vendors."),
      is_archived: z.boolean().optional().describe("Filter to archived (true) or active (false) products."),
      name_contains: z.string().optional().describe("Case-insensitive substring match on name, applied locally."),
      sort: z
        .array(z.string())
        .optional()
        .describe("NAME_ASC, NAME_DESC, CREATED_AT_ASC/DESC, MODIFIED_AT_ASC/DESC. Defaults to NAME_ASC."),
      modified_after: z.string().optional().describe("ISO 8601 timestamp; only products changed after it."),
      modified_before: z.string().optional().describe("ISO 8601 timestamp; only products changed before it."),
      ...paginationSchema,
    },
  },
  async ({
    business_id,
    is_sold,
    is_bought,
    is_archived,
    name_contains,
    sort,
    modified_after,
    modified_before,
    page = 1,
    page_size = DEFAULT_PAGE_SIZE,
    fetch_all = false,
    response_format = "markdown",
  }) => {
    const resolved = requireBusinessId(business_id);
    let result = await walkPages(
      Q_LIST_PRODUCTS,
      compact({
        businessId: resolved,
        sort: sort?.map((s) => s.toUpperCase()) ?? ["NAME_ASC"],
        isSold: is_sold,
        isBought: is_bought,
        isArchived: is_archived,
        modifiedAtAfter: modified_after,
        modifiedAtBefore: modified_before,
      }),
      ["business", "products"],
      { page, pageSize: page_size, fetchAll: fetch_all }
    );
    if (name_contains) {
      const needle = name_contains.toLowerCase();
      const items = result.items.filter((p) => (p.name || "").toLowerCase().includes(needle));
      result = { ...result, items, count: items.length };
    }
    return render(result, response_format, () =>
      listing(result, "Products and services", [
        ["Name", "name"],
        ["ID", "id"],
        ["Unit price", "unitPrice"],
        ["Sold", (r) => yesNo(r.isSold)],
        ["Bought", (r) => yesNo(r.isBought)],
        ["Income account", (r) => r.incomeAccount?.name ?? "-"],
        ["Archived", (r) => yesNo(r.isArchived)],
      ])
    );
  }
);

registerTool(
  "wave_get_product",
  {
    readOnly: true,
    description: "Get one product by ID, including its accounts and default sales taxes.",
    inputSchema: {
      product_id: z.string().describe("The Wave product ID."),
      business_id: businessIdSchema,
      response_format: responseFormatSchema,
    },
  },
  async ({ product_id, business_id, response_format = "markdown" }) => {
    const resolved = requireBusinessId(business_id);
    const data = await waveFetch(Q_GET_PRODUCT, { businessId: resolved, id: product_id });
    const product = data.business?.product;
    if (!product) return ok(`No product found with ID \`${product_id}\` in this business.`);
    return render(product, response_format, () => {
      const taxes = (product.defaultSalesTaxes || [])
        .map((t) => `${t.name} (${t.abbreviation} ${t.rate})`)
        .join(", ");
      return `**${product.name}**\n\n${kvBlock([
        ["ID", `\`${product.id}\``],
        ["Description", product.description],
        ["Unit price", product.unitPrice],
        ["Sold to customers", yesNo(product.isSold)],
        ["Bought from vendors", yesNo(product.isBought)],
        ["Income account", product.incomeAccount?.name],
        ["Expense account", product.expenseAccount?.name],
        ["Default sales taxes", taxes],
        ["Archived", yesNo(product.isArchived)],
        ["Created", product.createdAt],
        ["Modified", product.modifiedAt],
      ])}`;
    });
  }
);

registerWriteTool(
  "wave_create_product",
  {
    description:
      "Create a product or service. Set income_account_id to make it sellable on invoices and estimates, and expense_account_id to make it purchasable. Find IDs with wave_list_accounts.",
    inputSchema: {
      name: z.string().describe("Product or service name."),
      unit_price: z.string().describe(`Default price per unit. ${DECIMAL_HINT}`),
      business_id: businessIdSchema,
      description: z.string().optional().describe("Default line-item description on invoices."),
      income_account_id: z.string().optional().describe("Income account credited when sold."),
      expense_account_id: z.string().optional().describe("Expense account debited when bought."),
      default_sales_tax_ids: z.array(z.string()).optional().describe("Sales taxes applied by default."),
      response_format: responseFormatSchema,
    },
  },
  async ({
    name,
    unit_price,
    business_id,
    description,
    income_account_id,
    expense_account_id,
    default_sales_tax_ids,
    response_format = "markdown",
  }) => {
    const resolved = requireBusinessId(business_id);
    const input = compact({
      businessId: resolved,
      name,
      unitPrice: decimalStr(unit_price),
      description,
      incomeAccountId: income_account_id,
      expenseAccountId: expense_account_id,
      defaultSalesTaxIds: default_sales_tax_ids,
    });
    const result = await waveMutate(M_CREATE_PRODUCT, { input }, "productCreate");
    const product = result.product || {};
    return render(product, response_format, () =>
      success(`Created product **${product.name ?? name}**.`, [
        ["ID", `\`${product.id}\``],
        ["Unit price", product.unitPrice],
        ["Sold", yesNo(product.isSold)],
        ["Bought", yesNo(product.isBought)],
      ])
    );
  }
);

registerWriteTool(
  "wave_patch_product",
  {
    idempotent: true,
    description:
      "Update a product. Only the fields you supply change. Supplying default_sales_tax_ids replaces the whole list, so include every tax you want to keep; pass an empty list to clear them.",
    inputSchema: {
      product_id: z.string().describe("The product to update."),
      name: z.string().optional().describe("New name."),
      description: z.string().optional().describe("New default description."),
      unit_price: z.string().optional().describe(`New unit price. ${DECIMAL_HINT}`),
      income_account_id: z.string().optional().describe("New income account."),
      expense_account_id: z.string().optional().describe("New expense account."),
      default_sales_tax_ids: z.array(z.string()).optional().describe("Replacement list of default sales taxes."),
      response_format: responseFormatSchema,
    },
  },
  async ({
    product_id,
    name,
    description,
    unit_price,
    income_account_id,
    expense_account_id,
    default_sales_tax_ids,
    response_format = "markdown",
  }) => {
    const input = compact({
      id: product_id,
      name,
      description,
      unitPrice: decimalStr(unit_price),
      incomeAccountId: income_account_id,
      expenseAccountId: expense_account_id,
      defaultSalesTaxIds: default_sales_tax_ids,
    });
    if (Object.keys(input).length === 1) return ok("Nothing to update. Supply at least one field to change.");
    const result = await waveMutate(M_PATCH_PRODUCT, { input }, "productPatch");
    const product = result.product || {};
    return render(product, response_format, () =>
      success(`Updated product **${product.name}**.`, [
        ["ID", `\`${product.id}\``],
        ["Unit price", product.unitPrice],
      ])
    );
  }
);

registerWriteTool(
  "wave_archive_product",
  {
    destructive: true,
    idempotent: true,
    description:
      "Archive a product, removing it from pickers on new invoices. Existing invoices that use it are untouched. Wave has no product delete, and no un-archive through the API.",
    inputSchema: { product_id: z.string().describe("The product to archive.") },
  },
  async ({ product_id }) => {
    const result = await waveMutate(M_ARCHIVE_PRODUCT, { input: { id: product_id } }, "productArchive");
    const name = result.product?.name ?? product_id;
    return ok(
      `Archived product **${name}**. Existing invoices are unaffected; it no longer appears when building new ones.`
    );
  }
);

// --- Tools: sales taxes ---

const Q_LIST_SALES_TAXES = gql(
  `
query ListSalesTaxes(
  $businessId: ID!
  $page: Int!
  $pageSize: Int!
  $isArchived: Boolean
  $modifiedAtAfter: DateTime
  $modifiedAtBefore: DateTime
) {
  business(id: $businessId) {
    id
    salesTaxes(
      page: $page
      pageSize: $pageSize
      isArchived: $isArchived
      modifiedAtAfter: $modifiedAtAfter
      modifiedAtBefore: $modifiedAtBefore
    ) {
      pageInfo { ...PageInfoFields }
      edges { node { ...SalesTaxFields } }
    }
  }
}`,
  "pageInfo",
  "salesTax"
);

const Q_GET_SALES_TAX = gql(
  `query GetSalesTax($businessId: ID!, $id: ID!) { business(id: $businessId) { id salesTax(id: $id) { ...SalesTaxFields } } }`,
  "salesTax"
);

const M_CREATE_SALES_TAX = gql(
  `
mutation CreateSalesTax($input: SalesTaxCreateInput!) {
  salesTaxCreate(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    salesTax { ...SalesTaxFields }
  }
}`,
  "salesTax"
);

const M_PATCH_SALES_TAX = gql(
  `
mutation PatchSalesTax($input: SalesTaxPatchInput!) {
  salesTaxPatch(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    salesTax { ...SalesTaxFields }
  }
}`,
  "salesTax"
);

const M_ARCHIVE_SALES_TAX = gql(`
mutation ArchiveSalesTax($input: SalesTaxArchiveInput!) {
  salesTaxArchive(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    salesTax { id name isArchived }
  }
}`);

registerTool(
  "wave_list_sales_taxes",
  {
    readOnly: true,
    description: "List sales taxes, with their current rate and rate history.",
    inputSchema: {
      business_id: businessIdSchema,
      is_archived: z.boolean().optional().describe("Filter to archived (true) or active (false) taxes."),
      modified_after: z.string().optional().describe("ISO 8601 timestamp; only taxes changed after it."),
      modified_before: z.string().optional().describe("ISO 8601 timestamp; only taxes changed before it."),
      ...paginationSchema,
    },
  },
  async ({
    business_id,
    is_archived,
    modified_after,
    modified_before,
    page = 1,
    page_size = DEFAULT_PAGE_SIZE,
    fetch_all = false,
    response_format = "markdown",
  }) => {
    const resolved = requireBusinessId(business_id);
    const result = await walkPages(
      Q_LIST_SALES_TAXES,
      compact({
        businessId: resolved,
        isArchived: is_archived,
        modifiedAtAfter: modified_after,
        modifiedAtBefore: modified_before,
      }),
      ["business", "salesTaxes"],
      { page, pageSize: page_size, fetchAll: fetch_all }
    );
    return render(result, response_format, () =>
      listing(result, "Sales taxes", [
        ["Name", "name"],
        ["Abbr.", "abbreviation"],
        ["ID", "id"],
        ["Rate", "rate"],
        ["Compound", (r) => yesNo(r.isCompound)],
        ["Recoverable", (r) => yesNo(r.isRecoverable)],
        ["Archived", (r) => yesNo(r.isArchived)],
      ])
    );
  }
);

registerTool(
  "wave_get_sales_tax",
  {
    readOnly: true,
    description: "Get one sales tax by ID, including its full rate history.",
    inputSchema: {
      sales_tax_id: z.string().describe("The Wave sales tax ID."),
      business_id: businessIdSchema,
      response_format: responseFormatSchema,
    },
  },
  async ({ sales_tax_id, business_id, response_format = "markdown" }) => {
    const resolved = requireBusinessId(business_id);
    const data = await waveFetch(Q_GET_SALES_TAX, { businessId: resolved, id: sales_tax_id });
    const tax = data.business?.salesTax;
    if (!tax) return ok(`No sales tax found with ID \`${sales_tax_id}\` in this business.`);
    return render(tax, response_format, () => {
      const history = (tax.rates || []).map((r) => `${r.effective}: ${r.rate}`).join("; ");
      return `**${tax.name} (${tax.abbreviation})**\n\n${kvBlock([
        ["ID", `\`${tax.id}\``],
        ["Current rate", tax.rate],
        ["Rate history", history],
        ["Description", tax.description],
        ["Tax number", tax.taxNumber],
        ["Show number on invoices", yesNo(tax.showTaxNumberOnInvoices)],
        ["Compound", yesNo(tax.isCompound)],
        ["Recoverable", yesNo(tax.isRecoverable)],
        ["Archived", yesNo(tax.isArchived)],
        ["Created", tax.createdAt],
        ["Modified", tax.modifiedAt],
      ])}`;
    });
  }
);

registerWriteTool(
  "wave_create_sales_tax",
  {
    description: 'Create a sales tax. The rate is a decimal fraction, not a percentage: 7% is "0.07".',
    inputSchema: {
      name: z.string().describe('Full name, e.g. "Harmonized Sales Tax".'),
      abbreviation: z.string().describe('Short code shown on invoices, e.g. "HST".'),
      rate: z.string().describe('Decimal fraction, e.g. "0.13" for 13%.'),
      business_id: businessIdSchema,
      description: z.string().optional().describe("Optional description."),
      tax_number: z.string().optional().describe("Your registration number for this tax."),
      show_tax_number_on_invoices: z.boolean().optional().describe("Print the registration number on invoices."),
      is_compound: z
        .boolean()
        .optional()
        .describe("Calculate this tax on top of other taxes rather than on the subtotal."),
      is_recoverable: z.boolean().optional().describe("Tax you can reclaim, such as input tax credits."),
      response_format: responseFormatSchema,
    },
  },
  async ({
    name,
    abbreviation,
    rate,
    business_id,
    description,
    tax_number,
    show_tax_number_on_invoices,
    is_compound,
    is_recoverable,
    response_format = "markdown",
  }) => {
    const resolved = requireBusinessId(business_id);
    const input = compact({
      businessId: resolved,
      name,
      abbreviation,
      rate: decimalStr(rate),
      description,
      taxNumber: tax_number,
      showTaxNumberOnInvoices: show_tax_number_on_invoices,
      isCompound: is_compound,
      isRecoverable: is_recoverable,
    });
    const result = await waveMutate(M_CREATE_SALES_TAX, { input }, "salesTaxCreate");
    const tax = result.salesTax || {};
    return render(tax, response_format, () =>
      success(`Created sales tax **${tax.name ?? name}** (${tax.abbreviation ?? abbreviation}).`, [
        ["ID", `\`${tax.id}\``],
        ["Rate", tax.rate],
      ])
    );
  }
);

registerWriteTool(
  "wave_patch_sales_tax",
  {
    idempotent: true,
    description:
      "Update a sales tax, including scheduling a new rate. A rate is never edited in place: add a dated entry to rates and Wave applies it from that date on, so invoices issued earlier keep the old rate. Whether a tax is compound or recoverable is fixed at creation.",
    inputSchema: {
      sales_tax_id: z.string().describe("The sales tax to update."),
      name: z.string().optional().describe("New full name."),
      abbreviation: z.string().optional().describe("New short code."),
      description: z.string().optional().describe("New description."),
      tax_number: z.string().optional().describe("New registration number."),
      show_tax_number_on_invoices: z.boolean().optional().describe("Print the registration number on invoices."),
      rates: z
        .array(
          z.object({
            effective: z.string().describe("Date the rate takes effect, YYYY-MM-DD."),
            rate: z.string().describe('Decimal fraction, e.g. "0.07".'),
          })
        )
        .optional()
        .describe("Rate schedule entries. Each new rate applies from its effective date onward."),
      response_format: responseFormatSchema,
    },
  },
  async ({
    sales_tax_id,
    name,
    abbreviation,
    description,
    tax_number,
    show_tax_number_on_invoices,
    rates,
    response_format = "markdown",
  }) => {
    const input = compact({
      id: sales_tax_id,
      name,
      abbreviation,
      description,
      taxNumber: tax_number,
      showTaxNumberOnInvoices: show_tax_number_on_invoices,
      rates: rates?.map((r) => ({ effective: String(r.effective), rate: String(r.rate) })),
    });
    if (Object.keys(input).length === 1) return ok("Nothing to update. Supply at least one field to change.");
    const result = await waveMutate(M_PATCH_SALES_TAX, { input }, "salesTaxPatch");
    const tax = result.salesTax || {};
    return render(tax, response_format, () =>
      success(`Updated sales tax **${tax.name}**.`, [
        ["ID", `\`${tax.id}\``],
        ["Current rate", tax.rate],
      ])
    );
  }
);

registerWriteTool(
  "wave_archive_sales_tax",
  {
    destructive: true,
    idempotent: true,
    description:
      "Archive a sales tax so it stops appearing on new invoices. Existing invoices keep the tax they were issued with.",
    inputSchema: { sales_tax_id: z.string().describe("The sales tax to archive.") },
  },
  async ({ sales_tax_id }) => {
    const result = await waveMutate(M_ARCHIVE_SALES_TAX, { input: { id: sales_tax_id } }, "salesTaxArchive");
    const name = result.salesTax?.name ?? sales_tax_id;
    return ok(`Archived sales tax **${name}**. Existing invoices keep it; it no longer appears on new ones.`);
  }
);

// --- Tools: invoices ---
// Draft -> approve -> send -> get paid. Wave models each step as its own
// mutation, and all of them are exposed here.

const Q_LIST_INVOICES = gql(
  `
query ListInvoices(
  $businessId: ID!
  $page: Int!
  $pageSize: Int!
  $sort: [InvoiceSort!]!
  $status: InvoiceStatus
  $customerId: ID
  $currency: CurrencyCode
  $invoiceDateStart: Date
  $invoiceDateEnd: Date
  $modifiedAtAfter: DateTime
  $modifiedAtBefore: DateTime
  $invoiceNumber: String
  $amountDue: Decimal
) {
  business(id: $businessId) {
    id
    invoices(
      page: $page
      pageSize: $pageSize
      sort: $sort
      status: $status
      customerId: $customerId
      currency: $currency
      invoiceDateStart: $invoiceDateStart
      invoiceDateEnd: $invoiceDateEnd
      modifiedAtAfter: $modifiedAtAfter
      modifiedAtBefore: $modifiedAtBefore
      invoiceNumber: $invoiceNumber
      amountDue: $amountDue
    ) {
      pageInfo { ...PageInfoFields }
      edges {
        node {
          id
          status
          title
          invoiceNumber
          poNumber
          invoiceDate
          dueDate
          viewUrl
          pdfUrl
          createdAt
          modifiedAt
          lastSentAt
          currency { code symbol }
          customer { id name email }
          total { ...MoneyFields }
          amountDue { ...MoneyFields }
          amountPaid { ...MoneyFields }
        }
      }
    }
  }
}`,
  "pageInfo",
  "money"
);

const Q_GET_INVOICE = gql(
  `
query GetInvoice($businessId: ID!, $id: ID!) {
  business(id: $businessId) {
    id
    invoice(id: $id) {
      ...InvoiceFields
      payments { ...InvoicePaymentFields }
    }
  }
}`,
  ...INVOICE_SET,
  "invoicePayment"
);

const M_CREATE_INVOICE = gql(
  `
mutation CreateInvoice($input: InvoiceCreateInput!) {
  invoiceCreate(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    invoice { ...InvoiceFields }
  }
}`,
  ...INVOICE_SET
);

const M_PATCH_INVOICE = gql(
  `
mutation PatchInvoice($input: InvoicePatchInput!) {
  invoicePatch(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    invoice { ...InvoiceFields }
  }
}`,
  ...INVOICE_SET
);

const M_CLONE_INVOICE = gql(
  `
mutation CloneInvoice($input: InvoiceCloneInput!) {
  invoiceClone(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    invoice { ...InvoiceFields }
  }
}`,
  ...INVOICE_SET
);

const M_APPROVE_INVOICE = gql(`
mutation ApproveInvoice($input: InvoiceApproveInput!) {
  invoiceApprove(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    invoice { id status invoiceNumber viewUrl pdfUrl }
  }
}`);

const M_SEND_INVOICE = gql(`
mutation SendInvoice($input: InvoiceSendInput!) {
  invoiceSend(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    invoice { id status invoiceNumber lastSentAt lastSentVia viewUrl }
  }
}`);

const M_MARK_SENT_INVOICE = gql(`
mutation MarkInvoiceSent($input: InvoiceMarkSentInput!) {
  invoiceMarkSent(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    invoice { id status invoiceNumber lastSentAt lastSentVia }
  }
}`);

const M_DELETE_INVOICE = gql(`
mutation DeleteInvoice($input: InvoiceDeleteInput!) {
  invoiceDelete(input: $input) { didSucceed ${INPUT_ERRORS} }
}`);

const lineItemsSchema = z
  .array(
    z.object({
      productId: z.string().describe("Product this line bills for. Required on every Wave line item."),
      description: z.string().optional().describe("Overrides the product's default description."),
      quantity: z.union([z.string(), z.number()]).optional().describe("Quantity. Defaults to 1."),
      unitPrice: z.union([z.string(), z.number()]).optional().describe("Overrides the product's unit price."),
      taxes: z
        .array(z.union([z.string(), z.object({ salesTaxId: z.string(), amount: z.union([z.string(), z.number()]).optional() })]))
        .optional()
        .describe("Sales tax IDs, or objects with salesTaxId and an optional amount."),
    })
  )
  .describe("Line items. Each must reference a product; call wave_list_products to find IDs.");

const discountsSchema = z
  .array(
    z.object({
      name: z.string().optional().describe("Label shown on the document."),
      discountType: z.string().optional().describe("FIXED or PERCENTAGE. Inferred when omitted."),
      amount: z.union([z.string(), z.number()]).optional().describe("Fixed amount off."),
      percentage: z.union([z.string(), z.number()]).optional().describe("Percentage off, e.g. 10 for 10%."),
    })
  )
  .optional()
  .describe('Discounts, e.g. [{"discountType": "PERCENTAGE", "percentage": "10"}].');

const documentPresentationSchema = {
  disable_credit_card_payments: z.boolean().optional().describe("Turn off card payments."),
  disable_bank_payments: z.boolean().optional().describe("Turn off bank payments."),
  disable_amex_payments: z.boolean().optional().describe("Turn off Amex specifically."),
  require_terms_of_service_agreement: z.boolean().optional().describe("Require terms acceptance before paying."),
};

function invoiceDetail(invoice) {
  const sections = [
    `**Invoice ${invoice.invoiceNumber} - ${invoice.status}**\n\n${kvBlock([
      ["ID", `\`${invoice.id}\``],
      ["Title", invoice.title],
      ["Subhead", invoice.subhead],
      ["Customer", invoice.customer?.name],
      ["Customer email", invoice.customer?.email],
      ["PO number", invoice.poNumber],
      ["Invoice date", invoice.invoiceDate],
      ["Due date", invoice.dueDate],
      ["Currency", invoice.currency?.code],
      ["Subtotal", money(invoice.subtotal)],
      ["Discount", money(invoice.discountTotal)],
      ["Tax", money(invoice.taxTotal)],
      ["Total", money(invoice.total)],
      ["Paid", money(invoice.amountPaid)],
      ["Amount due", money(invoice.amountDue)],
      ["Memo", invoice.memo],
      ["Footer", invoice.footer],
      ["Last sent", invoice.lastSentAt],
      ["Last sent via", invoice.lastSentVia],
      ["Last viewed", invoice.lastViewedAt],
      ["View URL", invoice.viewUrl],
      ["PDF URL", invoice.pdfUrl],
      ["Created", invoice.createdAt],
      ["Modified", invoice.modifiedAt],
    ])}`,
  ];

  if (invoice.items?.length) {
    sections.push(
      `\n**Line items**\n\n${table(invoice.items, [
        ["Product", (r) => r.product?.name ?? "-"],
        ["Description", "description"],
        ["Qty", "quantity"],
        ["Unit price", "unitPrice"],
        ["Total", (r) => money(r.total)],
        ["Taxes", (r) => (r.taxes || []).map((t) => t.salesTax?.abbreviation ?? "?").join(", ") || "-"],
      ])}`
    );
  }
  if (invoice.discounts?.length) {
    sections.push(
      `\n**Discounts**\n\n${table(invoice.discounts, [
        ["Name", "name"],
        ["Amount", "amount"],
        ["Percentage", "percentage"],
      ])}`
    );
  }
  const payments = (invoice.payments || []).filter(Boolean);
  if (payments.length) {
    sections.push(
      `\n**Payments**\n\n${table(payments, [
        ["Date", "paymentDate"],
        ["Amount", "amount"],
        ["Method", "paymentMethod"],
        ["Account", (r) => r.account?.name ?? "-"],
        ["Memo", "memo"],
        ["ID", "id"],
      ])}`
    );
  }
  return sections.join("\n");
}

registerTool(
  "wave_list_invoices",
  {
    readOnly: true,
    description:
      'List invoices, filtered by status, customer, date range, or amount due. To find unpaid invoices use status "UNPAID"; "OVERDUE" narrows that to ones past their due date.',
    inputSchema: {
      business_id: businessIdSchema,
      status: z
        .string()
        .optional()
        .describe("DRAFT, SAVED, UNPAID, SENT, VIEWED, PARTIAL, PAID, OVERDUE, OVERPAID."),
      customer_id: z.string().optional().describe("Only invoices for this customer."),
      currency: z.string().optional().describe('Currency code, e.g. "USD".'),
      invoice_number: z.string().optional().describe("Substring match applied by Wave: 12 also matches 112 and 120."),
      amount_due: z.string().optional().describe('Exact outstanding amount match, e.g. "250.00".'),
      invoice_date_start: z.string().optional().describe("Earliest invoice date, YYYY-MM-DD."),
      invoice_date_end: z.string().optional().describe("Latest invoice date, YYYY-MM-DD."),
      modified_after: z.string().optional().describe("ISO 8601 timestamp; only invoices changed after it."),
      modified_before: z.string().optional().describe("ISO 8601 timestamp; only invoices changed before it."),
      sort: z
        .array(z.string())
        .optional()
        .describe('e.g. ["INVOICE_DATE_DESC"], ["AMOUNT_DUE_DESC"], ["CUSTOMER_NAME_ASC"]. Defaults to INVOICE_DATE_DESC.'),
      ...paginationSchema,
    },
  },
  async (args) => {
    const resolved = requireBusinessId(args.business_id);
    const result = await walkPages(
      Q_LIST_INVOICES,
      compact({
        businessId: resolved,
        sort: args.sort?.map((s) => s.toUpperCase()) ?? ["INVOICE_DATE_DESC"],
        status: args.status?.toUpperCase(),
        customerId: args.customer_id,
        currency: args.currency?.toUpperCase(),
        invoiceNumber: args.invoice_number,
        amountDue: decimalStr(args.amount_due),
        invoiceDateStart: args.invoice_date_start,
        invoiceDateEnd: args.invoice_date_end,
        modifiedAtAfter: args.modified_after,
        modifiedAtBefore: args.modified_before,
      }),
      ["business", "invoices"],
      { page: args.page ?? 1, pageSize: args.page_size ?? DEFAULT_PAGE_SIZE, fetchAll: args.fetch_all ?? false }
    );
    return render(result, args.response_format ?? "markdown", () =>
      listing(result, "Invoices", [
        ["Number", "invoiceNumber"],
        ["Customer", (r) => r.customer?.name ?? "-"],
        ["Status", "status"],
        ["Date", "invoiceDate"],
        ["Due", "dueDate"],
        ["Total", (r) => money(r.total)],
        ["Due amount", (r) => money(r.amountDue)],
        ["ID", "id"],
      ])
    );
  }
);

registerTool(
  "wave_get_invoice",
  {
    readOnly: true,
    description: "Get one invoice in full: line items, taxes, discounts, and payments.",
    inputSchema: {
      invoice_id: z.string().describe("The Wave invoice ID."),
      business_id: businessIdSchema,
      response_format: responseFormatSchema,
    },
  },
  async ({ invoice_id, business_id, response_format = "markdown" }) => {
    const resolved = requireBusinessId(business_id);
    const data = await waveFetch(Q_GET_INVOICE, { businessId: resolved, id: invoice_id });
    const invoice = data.business?.invoice;
    if (!invoice) return ok(`No invoice found with ID \`${invoice_id}\` in this business.`);
    return render(invoice, response_format, () => invoiceDetail(invoice));
  }
);

registerWriteTool(
  "wave_create_invoice",
  {
    description:
      "Create an invoice. Every line item must reference a product, so call wave_list_products first (or wave_create_product). A new invoice is a DRAFT and is not visible to the customer: approve it with wave_approve_invoice, then deliver it with wave_send_invoice.",
    inputSchema: {
      customer_id: z.string().describe("Customer to bill."),
      items: lineItemsSchema,
      business_id: businessIdSchema,
      status: z.string().default("DRAFT").describe("DRAFT or SAVED."),
      title: z.string().optional().describe('Heading on the invoice. Defaults to "Invoice".'),
      subhead: z.string().optional().describe("Text under the title."),
      invoice_number: z.string().optional().describe("Your own number. Wave assigns the next one if omitted."),
      po_number: z.string().optional().describe("Customer purchase order number."),
      invoice_date: z.string().optional().describe("Issue date, YYYY-MM-DD. Defaults to today."),
      due_date: z.string().optional().describe("Payment due date, YYYY-MM-DD."),
      currency: z.string().optional().describe("Currency code. Defaults to the customer or business currency."),
      exchange_rate: z.string().optional().describe("Rate to the business currency, for foreign-currency invoices."),
      memo: z.string().optional().describe("Note shown to the customer."),
      footer: z.string().optional().describe("Footer text."),
      discounts: discountsSchema,
      ...documentPresentationSchema,
      response_format: responseFormatSchema,
    },
  },
  async (args) => {
    const resolved = requireBusinessId(args.business_id);
    const items = normalizeLineItems(args.items, "Invoice");
    const input = compact({
      businessId: resolved,
      customerId: args.customer_id,
      status: (args.status ?? "DRAFT").toUpperCase(),
      items,
      title: args.title,
      subhead: args.subhead,
      invoiceNumber: args.invoice_number,
      poNumber: args.po_number,
      invoiceDate: args.invoice_date,
      dueDate: args.due_date,
      currency: args.currency?.toUpperCase(),
      exchangeRate: decimalStr(args.exchange_rate),
      memo: args.memo,
      footer: args.footer,
      discounts: normalizeDiscounts(args.discounts, "Invoice"),
      disableCreditCardPayments: args.disable_credit_card_payments,
      disableBankPayments: args.disable_bank_payments,
      disableAmexPayments: args.disable_amex_payments,
      requireTermsOfServiceAgreement: args.require_terms_of_service_agreement,
    });
    const result = await waveMutate(M_CREATE_INVOICE, { input }, "invoiceCreate");
    const invoice = result.invoice || {};
    return render(invoice, args.response_format ?? "markdown", () => {
      let body = success(`Created invoice **${invoice.invoiceNumber}** (${invoice.status}).`, [
        ["ID", `\`${invoice.id}\``],
        ["Customer", invoice.customer?.name],
        ["Total", money(invoice.total)],
        ["Amount due", money(invoice.amountDue)],
        ["Due date", invoice.dueDate],
        ["View URL", invoice.viewUrl],
      ]);
      if (invoice.status === "DRAFT") {
        body +=
          "\n\nIt is still a draft. Call wave_approve_invoice to finalize it, then wave_send_invoice to email it.";
      }
      return body;
    });
  }
);

registerWriteTool(
  "wave_patch_invoice",
  {
    idempotent: true,
    description:
      "Update an invoice. Only the fields you supply change. Supplying items replaces every line item, so send the complete list. Wave restricts edits to invoices that have payments recorded against them.",
    inputSchema: {
      invoice_id: z.string().describe("The invoice to update."),
      customer_id: z.string().optional().describe("Reassign to a different customer."),
      status: z.string().optional().describe("DRAFT or SAVED."),
      items: lineItemsSchema.optional().describe("Replacement line items. Replaces all existing items."),
      title: z.string().optional().describe("New title."),
      subhead: z.string().optional().describe("New subhead."),
      invoice_number: z.string().optional().describe("New invoice number."),
      po_number: z.string().optional().describe("New PO number."),
      invoice_date: z.string().optional().describe("New issue date, YYYY-MM-DD."),
      due_date: z.string().optional().describe("New due date, YYYY-MM-DD."),
      currency: z.string().optional().describe("New currency code."),
      exchange_rate: z.string().optional().describe("New exchange rate."),
      memo: z.string().optional().describe("New customer-facing memo."),
      footer: z.string().optional().describe("New footer."),
      discounts: discountsSchema,
      ...documentPresentationSchema,
      response_format: responseFormatSchema,
    },
  },
  async (args) => {
    const input = compact({
      id: args.invoice_id,
      customerId: args.customer_id,
      status: args.status?.toUpperCase(),
      items: args.items ? normalizeLineItems(args.items, "Invoice") : undefined,
      title: args.title,
      subhead: args.subhead,
      invoiceNumber: args.invoice_number,
      poNumber: args.po_number,
      invoiceDate: args.invoice_date,
      dueDate: args.due_date,
      currency: args.currency?.toUpperCase(),
      exchangeRate: decimalStr(args.exchange_rate),
      memo: args.memo,
      footer: args.footer,
      discounts: normalizeDiscounts(args.discounts, "Invoice"),
      disableCreditCardPayments: args.disable_credit_card_payments,
      disableBankPayments: args.disable_bank_payments,
      disableAmexPayments: args.disable_amex_payments,
      requireTermsOfServiceAgreement: args.require_terms_of_service_agreement,
    });
    if (Object.keys(input).length === 1) return ok("Nothing to update. Supply at least one field to change.");
    const result = await waveMutate(M_PATCH_INVOICE, { input }, "invoicePatch");
    const invoice = result.invoice || {};
    return render(invoice, args.response_format ?? "markdown", () =>
      success(`Updated invoice **${invoice.invoiceNumber}**.`, [
        ["ID", `\`${invoice.id}\``],
        ["Status", invoice.status],
        ["Total", money(invoice.total)],
        ["Amount due", money(invoice.amountDue)],
      ])
    );
  }
);

registerWriteTool(
  "wave_clone_invoice",
  {
    description:
      "Copy an invoice into a new draft. The copy takes the original's customer, line items, and settings, with a fresh invoice number and today's date. Useful for recurring billing.",
    inputSchema: {
      invoice_id: z.string().describe("The invoice to copy."),
      response_format: responseFormatSchema,
    },
  },
  async ({ invoice_id, response_format = "markdown" }) => {
    const result = await waveMutate(M_CLONE_INVOICE, { input: { invoiceId: invoice_id } }, "invoiceClone");
    const invoice = result.invoice || {};
    return render(invoice, response_format, () =>
      success(`Cloned into draft invoice **${invoice.invoiceNumber}**.`, [
        ["New ID", `\`${invoice.id}\``],
        ["Status", invoice.status],
        ["Total", money(invoice.total)],
        ["Invoice date", invoice.invoiceDate],
      ])
    );
  }
);

registerWriteTool(
  "wave_approve_invoice",
  {
    idempotent: true,
    description:
      "Approve a draft invoice, moving it out of DRAFT and into the books. An approved invoice can be sent and paid, and it posts to accounts receivable. Approving does not notify the customer.",
    inputSchema: {
      invoice_id: z.string().describe("The draft invoice to approve."),
      response_format: responseFormatSchema,
    },
  },
  async ({ invoice_id, response_format = "markdown" }) => {
    const result = await waveMutate(M_APPROVE_INVOICE, { input: { invoiceId: invoice_id } }, "invoiceApprove");
    const invoice = result.invoice || {};
    return render(invoice, response_format, () =>
      success(`Approved invoice **${invoice.invoiceNumber}**.`, [
        ["ID", `\`${invoice.id}\``],
        ["Status", invoice.status],
        ["View URL", invoice.viewUrl],
      ]) + "\n\nThe customer has not been notified. Call wave_send_invoice to email it."
    );
  }
);

registerWriteTool(
  "wave_send_invoice",
  {
    description:
      "Email an invoice to a customer through Wave. This sends real email to real recipients, so confirm the addresses before calling it. The invoice must be approved first. Sending is not reversible.",
    inputSchema: {
      invoice_id: z.string().describe("The invoice to send."),
      to: z
        .union([z.string(), z.array(z.string())])
        .describe("Recipient email address, or a list of them. Real mail is sent to these addresses."),
      subject: z.string().optional().describe("Email subject. Wave supplies a default."),
      message: z.string().optional().describe("Body text. Wave supplies a default."),
      attach_pdf: z.boolean().default(false).describe("Attach the invoice PDF as well as linking to it."),
      cc_myself: z.boolean().optional().describe("Send a copy to the business email."),
      from_address: z.string().optional().describe("Reply-to address; must be verified in Wave."),
      response_format: responseFormatSchema,
    },
  },
  async ({ invoice_id, to, subject, message, attach_pdf = false, cc_myself, from_address, response_format = "markdown" }) => {
    const recipients = normalizeRecipients(to, "wave_send_invoice");
    const input = compact({
      invoiceId: invoice_id,
      to: recipients,
      subject,
      message,
      attachPDF: attach_pdf,
      ccMyself: cc_myself,
      fromAddress: from_address,
    });
    const result = await waveMutate(M_SEND_INVOICE, { input }, "invoiceSend");
    const invoice = result.invoice || {};
    return render(invoice, response_format, () =>
      success(`Sent invoice **${invoice.invoiceNumber}** to ${recipients.join(", ")}.`, [
        ["ID", `\`${invoice.id}\``],
        ["Status", invoice.status],
        ["Sent at", invoice.lastSentAt],
        ["Sent via", invoice.lastSentVia],
        ["View URL", invoice.viewUrl],
      ])
    );
  }
);

registerWriteTool(
  "wave_mark_invoice_sent",
  {
    idempotent: true,
    description:
      "Record that an invoice was delivered outside Wave, without emailing it. Use this when you sent the invoice yourself and want Wave's status to reflect that. No email is sent.",
    inputSchema: {
      invoice_id: z.string().describe("The invoice to mark."),
      send_method: z
        .string()
        .default("MARKED_SENT")
        .describe("MARKED_SENT, EXPORT_PDF, SHARED_LINK, GMAIL, OUTLOOK, YAHOO, WAVE, NOT_SENT, SKIPPED."),
      sent_at: z.string().optional().describe("When it was sent, ISO 8601. Defaults to now."),
      response_format: responseFormatSchema,
    },
  },
  async ({ invoice_id, send_method = "MARKED_SENT", sent_at, response_format = "markdown" }) => {
    const input = compact({ invoiceId: invoice_id, sendMethod: send_method.toUpperCase(), sentAt: sent_at });
    const result = await waveMutate(M_MARK_SENT_INVOICE, { input }, "invoiceMarkSent");
    const invoice = result.invoice || {};
    return render(invoice, response_format, () =>
      success(`Marked invoice **${invoice.invoiceNumber}** as sent. No email was sent.`, [
        ["ID", `\`${invoice.id}\``],
        ["Status", invoice.status],
        ["Sent at", invoice.lastSentAt],
        ["Sent via", invoice.lastSentVia],
      ])
    );
  }
);

registerWriteTool(
  "wave_delete_invoice",
  {
    destructive: true,
    idempotent: true,
    description:
      "Delete an invoice. This cannot be undone. Wave refuses to delete an invoice that has payments recorded against it; delete those first with wave_delete_invoice_payment.",
    inputSchema: { invoice_id: z.string().describe("The invoice to delete.") },
  },
  async ({ invoice_id }) => {
    await waveMutate(M_DELETE_INVOICE, { input: { invoiceId: invoice_id } }, "invoiceDelete");
    return ok(`Deleted invoice \`${invoice_id}\`.`);
  }
);

// --- Tools: invoice payments ---

const Q_GET_INVOICE_PAYMENT = gql(
  `
query GetInvoicePayment($businessId: ID!, $id: ID!) {
  business(id: $businessId) {
    id
    invoicePayment(id: $id) {
      ...InvoicePaymentFields
      invoice { id invoiceNumber status }
    }
  }
}`,
  "invoicePayment"
);

const M_CREATE_INVOICE_PAYMENT = gql(
  `
mutation CreateInvoicePayment($input: InvoicePaymentCreateManualInput!) {
  invoicePaymentCreateManual(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    invoicePayment {
      ...InvoicePaymentFields
      invoice { id invoiceNumber status }
    }
  }
}`,
  "invoicePayment"
);

const M_PATCH_INVOICE_PAYMENT = gql(
  `
mutation PatchInvoicePayment($input: InvoicePaymentPatchInput!) {
  invoicePaymentPatch(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    invoicePayment {
      ...InvoicePaymentFields
      invoice { id invoiceNumber status }
    }
  }
}`,
  "invoicePayment"
);

const M_DELETE_INVOICE_PAYMENT = gql(`
mutation DeleteInvoicePayment($input: InvoicePaymentDeleteInput!) {
  invoicePaymentDelete(input: $input) { didSucceed ${INPUT_ERRORS} }
}`);

const M_SEND_INVOICE_RECEIPT = gql(`
mutation SendInvoicePaymentReceipt($input: InvoicePaymentReceiptSendInput!) {
  invoicePaymentReceiptSend(input: $input) { didSucceed ${INPUT_ERRORS} }
}`);

function paymentDetail(payment, kind) {
  const parent = payment.invoice || payment.estimate || {};
  return `**${kind} payment**\n\n${kvBlock([
    ["ID", `\`${payment.id}\``],
    ["Amount", payment.amount],
    ["Payment date", payment.paymentDate],
    ["Method", payment.paymentMethod],
    ["Memo", payment.memo],
    ["Deposited to", payment.account?.name],
    ["Customer", payment.customer?.name],
    ["Applied to", parent.invoiceNumber ?? parent.estimateNumber],
    ["Parent status", parent.status],
    ["State", payment.state],
    ["Origin", payment.origin],
    ["Provider", payment.paymentProvider],
    ["Exchange rate", payment.exchangeRate],
    ["Transaction ID", payment.transactionId],
    ["Confirmation code", payment.confirmationCode],
    ["Created", payment.createdAt],
    ["Modified", payment.modifiedAt],
  ])}`;
}

const PAYMENT_METHODS = "CASH, CHEQUE, CREDIT_CARD, BANK_TRANSFER, PAYPAL, OTHER, UNSPECIFIED";

registerTool(
  "wave_get_invoice_payment",
  {
    readOnly: true,
    description:
      "Get one invoice payment by ID. To see every payment on an invoice, call wave_get_invoice instead: it returns them all.",
    inputSchema: {
      payment_id: z.string().describe("The Wave invoice payment ID."),
      business_id: businessIdSchema,
      response_format: responseFormatSchema,
    },
  },
  async ({ payment_id, business_id, response_format = "markdown" }) => {
    const resolved = requireBusinessId(business_id);
    const data = await waveFetch(Q_GET_INVOICE_PAYMENT, { businessId: resolved, id: payment_id });
    const payment = data.business?.invoicePayment;
    if (!payment) return ok(`No invoice payment found with ID \`${payment_id}\` in this business.`);
    return render(payment, response_format, () => paymentDetail(payment, "Invoice"));
  }
);

registerWriteTool(
  "wave_create_invoice_payment",
  {
    description:
      "Record a manual payment against an invoice. This posts money to the account you name and reduces the invoice's amount due. It records a payment you already received; it does not charge anyone. Find payment_account_id with wave_list_accounts filtered to subtypes [\"CASH_AND_BANK\"].",
    inputSchema: {
      invoice_id: z.string().describe("The invoice being paid."),
      payment_account_id: z.string().describe("Bank or cash account the money landed in."),
      amount: z.string().describe(`Amount received. ${DECIMAL_HINT}`),
      payment_date: z.string().describe("Date received, YYYY-MM-DD."),
      payment_method: z.string().default("UNSPECIFIED").describe(PAYMENT_METHODS),
      exchange_rate: z.string().default("1").describe("Rate to the business currency."),
      memo: z.string().optional().describe("Note on the payment, such as a cheque number."),
      response_format: responseFormatSchema,
    },
  },
  async ({
    invoice_id,
    payment_account_id,
    amount,
    payment_date,
    payment_method = "UNSPECIFIED",
    exchange_rate = "1",
    memo,
    response_format = "markdown",
  }) => {
    const input = compact({
      invoiceId: invoice_id,
      paymentAccountId: payment_account_id,
      amount: decimalStr(amount),
      paymentDate: payment_date,
      paymentMethod: payment_method.toUpperCase(),
      exchangeRate: decimalStr(exchange_rate),
      memo,
    });
    const result = await waveMutate(M_CREATE_INVOICE_PAYMENT, { input }, "invoicePaymentCreateManual");
    const payment = result.invoicePayment || {};
    const invoice = payment.invoice || {};
    return render(payment, response_format, () =>
      success(`Recorded a ${payment.amount ?? amount} payment on invoice **${invoice.invoiceNumber}**.`, [
        ["Payment ID", `\`${payment.id}\``],
        ["Payment date", payment.paymentDate],
        ["Method", payment.paymentMethod],
        ["Deposited to", payment.account?.name],
        ["Invoice status", invoice.status],
      ])
    );
  }
);

registerWriteTool(
  "wave_patch_invoice_payment",
  {
    idempotent: true,
    description:
      "Update a recorded invoice payment. Only the fields you supply change. Changing the amount re-derives the invoice's amount due and may move it between PARTIAL, PAID, and OVERPAID.",
    inputSchema: {
      payment_id: z.string().describe("The payment to update."),
      payment_account_id: z.string().optional().describe("Move the payment to a different bank account."),
      amount: z.string().optional().describe(`Corrected amount. ${DECIMAL_HINT}`),
      payment_date: z.string().optional().describe("Corrected date, YYYY-MM-DD."),
      payment_method: z.string().optional().describe(PAYMENT_METHODS),
      exchange_rate: z.string().optional().describe("Corrected exchange rate."),
      memo: z.string().optional().describe("New memo."),
      response_format: responseFormatSchema,
    },
  },
  async ({ payment_id, payment_account_id, amount, payment_date, payment_method, exchange_rate, memo, response_format = "markdown" }) => {
    const input = compact({
      id: payment_id,
      paymentAccountId: payment_account_id,
      amount: decimalStr(amount),
      paymentDate: payment_date,
      paymentMethod: payment_method?.toUpperCase(),
      exchangeRate: decimalStr(exchange_rate),
      memo,
    });
    if (Object.keys(input).length === 1) return ok("Nothing to update. Supply at least one field to change.");
    const result = await waveMutate(M_PATCH_INVOICE_PAYMENT, { input }, "invoicePaymentPatch");
    const payment = result.invoicePayment || {};
    const invoice = payment.invoice || {};
    return render(payment, response_format, () =>
      success(`Updated payment on invoice **${invoice.invoiceNumber}**.`, [
        ["Payment ID", `\`${payment.id}\``],
        ["Amount", payment.amount],
        ["Payment date", payment.paymentDate],
        ["Invoice status", invoice.status],
      ])
    );
  }
);

registerWriteTool(
  "wave_delete_invoice_payment",
  {
    destructive: true,
    idempotent: true,
    description:
      "Delete a recorded invoice payment. This cannot be undone. The invoice's amount due goes back up by the deleted amount.",
    inputSchema: { payment_id: z.string().describe("The payment to delete.") },
  },
  async ({ payment_id }) => {
    await waveMutate(M_DELETE_INVOICE_PAYMENT, { input: { id: payment_id } }, "invoicePaymentDelete");
    return ok(`Deleted invoice payment \`${payment_id}\`. The invoice's amount due has increased by that amount.`);
  }
);

registerWriteTool(
  "wave_send_invoice_payment_receipt",
  {
    description:
      "Email a payment receipt to a customer. This sends real email to real recipients, so confirm the addresses first.",
    inputSchema: {
      invoice_id: z.string().describe("The invoice the payment belongs to."),
      payment_id: z.string().describe("The payment to receipt."),
      to: z.union([z.string(), z.array(z.string())]).describe("Recipient email address, or a list of them."),
      subject: z.string().optional().describe("Email subject. Wave supplies a default."),
      message: z.string().optional().describe("Body text. Wave supplies a default."),
      attach_pdf: z.boolean().optional().describe("Attach the receipt as a PDF."),
      cc_myself: z.boolean().optional().describe("Send a copy to the business email."),
      from_address: z.string().optional().describe("Reply-to address; must be verified in Wave."),
    },
  },
  async ({ invoice_id, payment_id, to, subject, message, attach_pdf, cc_myself, from_address }) => {
    const recipients = normalizeRecipients(to, "wave_send_invoice_payment_receipt");
    const input = compact({
      invoiceId: invoice_id,
      invoicePaymentId: payment_id,
      to: recipients,
      subject,
      message,
      attachPdf: attach_pdf,
      ccMyself: cc_myself,
      fromAddress: from_address,
    });
    await waveMutate(M_SEND_INVOICE_RECEIPT, { input }, "invoicePaymentReceiptSend");
    return ok(`Sent a payment receipt for invoice \`${invoice_id}\` to ${recipients.join(", ")}.`);
  }
);

// --- Tools: estimates ---
// Draft -> approve -> send -> customer accepts -> convert to invoice.
// Estimates additionally support deposits, PDF generation, and an
// acceptance history.

const Q_LIST_ESTIMATES = gql(
  `
query ListEstimates(
  $businessId: ID!
  $page: Int!
  $pageSize: Int!
  $sort: EstimateSort!
  $status: EstimateListStatusFilter
  $customerId: ID
  $currency: CurrencyCode
  $estimateDateStart: Date
  $estimateDateEnd: Date
  $modifiedAtAfter: DateTime
  $modifiedAtBefore: DateTime
  $estimateNumber: String
  $amountDue: Decimal
) {
  business(id: $businessId) {
    id
    estimates(
      page: $page
      pageSize: $pageSize
      sort: $sort
      status: $status
      customerId: $customerId
      currency: $currency
      estimateDateStart: $estimateDateStart
      estimateDateEnd: $estimateDateEnd
      modifiedAtAfter: $modifiedAtAfter
      modifiedAtBefore: $modifiedAtBefore
      estimateNumber: $estimateNumber
      amountDue: $amountDue
    ) {
      pageInfo { ...PageInfoFields }
      edges {
        node {
          id
          status
          title
          estimateNumber
          poNumber
          estimateDate
          dueDate
          viewUrl
          pdfUrl
          createdAt
          modifiedAt
          lastSentAt
          depositStatus
          depositPaymentStatus
          currency { code symbol }
          customer { id name email }
          total { ...MoneyFields }
          amountDue { ...MoneyFields }
          amountPaid { ...MoneyFields }
        }
      }
    }
  }
}`,
  "pageInfo",
  "money"
);

const Q_GET_ESTIMATE = gql(
  `
query GetEstimate(
  $businessId: ID!
  $id: ID!
  $embedAttachments: Boolean
  $embedHistory: Boolean
  $embedDepositPayments: Boolean
) {
  business(id: $businessId) {
    id
    estimate(
      id: $id
      embedAttachments: $embedAttachments
      embedHistory: $embedHistory
      embedDepositPayments: $embedDepositPayments
    ) {
      ...EstimateFields
      attachments { id fileName fileSize downloadUrl }
      history { entityId entityType state name email timestamp }
      payments { ...EstimatePaymentFields }
    }
  }
}`,
  ...ESTIMATE_SET,
  "estimatePayment"
);

const M_CREATE_ESTIMATE = gql(
  `
mutation CreateEstimate($input: EstimateCreateInput!) {
  estimateCreate(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    estimate { ...EstimateFields }
  }
}`,
  ...ESTIMATE_SET
);

const M_PATCH_ESTIMATE = gql(
  `
mutation PatchEstimate($input: EstimatePatchInput!) {
  estimatePatch(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    estimate { ...EstimateFields }
  }
}`,
  ...ESTIMATE_SET
);

const M_CLONE_ESTIMATE = gql(
  `
mutation CloneEstimate($input: EstimateCloneInput!) {
  estimateClone(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    estimate { ...EstimateFields }
  }
}`,
  ...ESTIMATE_SET
);

const M_APPROVE_ESTIMATE = gql(`
mutation ApproveEstimate($input: EstimateApproveInput!) {
  estimateApprove(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    estimate { id status estimateNumber viewUrl pdfUrl }
  }
}`);

const M_SEND_ESTIMATE = gql(`
mutation SendEstimate($input: EstimateSendInput!) {
  estimateSend(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    estimate { id status estimateNumber lastSentAt lastSentVia viewUrl }
  }
}`);

const M_MARK_SENT_ESTIMATE = gql(`
mutation MarkEstimateSent($input: EstimateMarkSentInput!) {
  estimateMarkSent(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    estimate { id status estimateNumber lastSentAt lastSentVia }
  }
}`);

const M_MARK_ACCEPTED_ESTIMATE = gql(`
mutation MarkEstimateAccepted($input: EstimateMarkAcceptedInput!) {
  estimateMarkAccepted(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    estimate { id status estimateNumber }
  }
}`);

const M_RESET_ACCEPTANCE = gql(`
mutation ResetEstimateAcceptance($input: EstimateResetAcceptanceInput!) {
  estimateResetAcceptance(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    estimate { id status estimateNumber }
  }
}`);

const M_SEND_ACCEPTANCE_EMAIL = gql(`
mutation SendEstimateAcceptanceEmail($input: EstimateSendAcceptanceCustomerEmailInput!) {
  estimateSendAcceptanceCustomerEmail(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    estimate { id status estimateNumber }
  }
}`);

const M_GENERATE_PDF = gql(`
mutation GenerateEstimatePdf($input: EstimateGeneratePdfInput!) {
  estimateGeneratePdf(input: $input) { didSucceed ${INPUT_ERRORS} pdfUrl }
}`);

const M_CONVERT_TO_INVOICE = gql(`
mutation ConvertEstimateToInvoice($input: ConvertEstimateToInvoiceInput!) {
  convertEstimateToInvoice(input: $input) { didSucceed ${INPUT_ERRORS} invoiceId }
}`);

const M_DELETE_ESTIMATE = gql(`
mutation DeleteEstimate($input: EstimateDeleteInput!) {
  estimateDelete(input: $input) { didSucceed ${INPUT_ERRORS} }
}`);

function estimateDetail(estimate) {
  const sections = [
    `**Estimate ${estimate.estimateNumber} - ${estimate.status}**\n\n${kvBlock([
      ["ID", `\`${estimate.id}\``],
      ["Title", estimate.title],
      ["Subhead", estimate.subhead],
      ["Customer", estimate.customer?.name],
      ["Customer email", estimate.customer?.email],
      ["PO number", estimate.poNumber],
      ["Estimate date", estimate.estimateDate],
      ["Expires", estimate.dueDate],
      ["Currency", estimate.currency?.code],
      ["Subtotal", money(estimate.subtotal)],
      ["Discount", money(estimate.discountTotal)],
      ["Tax", money(estimate.taxTotal)],
      ["Total", money(estimate.total)],
      ["Paid", money(estimate.amountPaid)],
      ["Amount due", money(estimate.amountDue)],
      ["Deposit required", estimate.depositStatus],
      ["Deposit value", estimate.depositValue],
      ["Deposit unit", estimate.depositUnit],
      ["Deposit total", money(estimate.depositTotal)],
      ["Deposit payment status", estimate.depositPaymentStatus],
      ["Memo", estimate.memo],
      ["Footer", estimate.footer],
      ["Last sent", estimate.lastSentAt],
      ["Last sent via", estimate.lastSentVia],
      ["Last viewed", estimate.lastViewedAt],
      ["View URL", estimate.viewUrl],
      ["PDF URL", estimate.pdfUrl],
      ["Created", estimate.createdAt],
      ["Modified", estimate.modifiedAt],
    ])}`,
  ];

  if (estimate.items?.length) {
    sections.push(
      `\n**Line items**\n\n${table(estimate.items, [
        ["Product", (r) => r.product?.name ?? "-"],
        ["Description", "description"],
        ["Qty", "quantity"],
        ["Unit price", "unitPrice"],
        ["Total", (r) => money(r.total)],
      ])}`
    );
  }
  if (estimate.history?.length) {
    sections.push(
      `\n**Acceptance history**\n\n${table(estimate.history, [
        ["When", "timestamp"],
        ["State", "state"],
        ["Who", "name"],
        ["Email", "email"],
        ["Type", "entityType"],
      ])}`
    );
  }
  const payments = (estimate.payments || []).filter(Boolean);
  if (payments.length) {
    sections.push(
      `\n**Deposit payments**\n\n${table(payments, [
        ["Date", "paymentDate"],
        ["Amount", "amount"],
        ["Method", "paymentMethod"],
        ["State", "state"],
        ["ID", "id"],
      ])}`
    );
  }
  return sections.join("\n");
}

registerTool(
  "wave_list_estimates",
  {
    readOnly: true,
    description: "List estimates (quotes), filtered by status, customer, or date range.",
    inputSchema: {
      business_id: businessIdSchema,
      status: z
        .string()
        .optional()
        .describe("DRAFT, SENT, VIEWED, ACCEPTED, APPROVED, CONVERTED, EXPIRED, REJECTED, ACTIVE, PAID, PARTIAL, UNPAID."),
      customer_id: z.string().optional().describe("Only estimates for this customer."),
      currency: z.string().optional().describe('Currency code, e.g. "USD".'),
      estimate_number: z.string().optional().describe("Exact estimate number match."),
      amount_due: z.string().optional().describe("Exact outstanding amount match."),
      estimate_date_start: z.string().optional().describe("Earliest estimate date, YYYY-MM-DD."),
      estimate_date_end: z.string().optional().describe("Latest estimate date, YYYY-MM-DD."),
      modified_after: z.string().optional().describe("ISO 8601 timestamp; only estimates changed after it."),
      modified_before: z.string().optional().describe("ISO 8601 timestamp; only estimates changed before it."),
      sort: z
        .string()
        .optional()
        .describe('A single value such as "ESTIMATE_DATE_DESC" or "TOTAL_DESC". Defaults to ESTIMATE_DATE_DESC.'),
      ...paginationSchema,
    },
  },
  async (args) => {
    const resolved = requireBusinessId(args.business_id);
    const result = await walkPages(
      Q_LIST_ESTIMATES,
      compact({
        businessId: resolved,
        sort: args.sort?.toUpperCase() ?? "ESTIMATE_DATE_DESC",
        status: args.status?.toUpperCase(),
        customerId: args.customer_id,
        currency: args.currency?.toUpperCase(),
        estimateNumber: args.estimate_number,
        amountDue: decimalStr(args.amount_due),
        estimateDateStart: args.estimate_date_start,
        estimateDateEnd: args.estimate_date_end,
        modifiedAtAfter: args.modified_after,
        modifiedAtBefore: args.modified_before,
      }),
      ["business", "estimates"],
      { page: args.page ?? 1, pageSize: args.page_size ?? DEFAULT_PAGE_SIZE, fetchAll: args.fetch_all ?? false }
    );
    return render(result, args.response_format ?? "markdown", () =>
      listing(result, "Estimates", [
        ["Number", "estimateNumber"],
        ["Customer", (r) => r.customer?.name ?? "-"],
        ["Status", "status"],
        ["Date", "estimateDate"],
        ["Expires", "dueDate"],
        ["Total", (r) => money(r.total)],
        ["ID", "id"],
      ])
    );
  }
);

registerTool(
  "wave_get_estimate",
  {
    readOnly: true,
    description: "Get one estimate in full: line items, deposits, and acceptance history.",
    inputSchema: {
      estimate_id: z.string().describe("The Wave estimate ID."),
      business_id: businessIdSchema,
      include_attachments: z.boolean().default(true).describe("Include attached files."),
      include_history: z.boolean().default(true).describe("Include the acceptance and rejection audit trail."),
      include_deposit_payments: z.boolean().default(true).describe("Include deposit payments recorded against it."),
      response_format: responseFormatSchema,
    },
  },
  async ({
    estimate_id,
    business_id,
    include_attachments = true,
    include_history = true,
    include_deposit_payments = true,
    response_format = "markdown",
  }) => {
    const resolved = requireBusinessId(business_id);
    const data = await waveFetch(Q_GET_ESTIMATE, {
      businessId: resolved,
      id: estimate_id,
      embedAttachments: include_attachments,
      embedHistory: include_history,
      embedDepositPayments: include_deposit_payments,
    });
    const estimate = data.business?.estimate;
    if (!estimate) return ok(`No estimate found with ID \`${estimate_id}\` in this business.`);
    return render(estimate, response_format, () => estimateDetail(estimate));
  }
);

registerWriteTool(
  "wave_create_estimate",
  {
    description:
      "Create an estimate (quote). Line items follow the same shape as invoices and must reference a product, but unitPrice is required on each line. To ask for a deposit, set deposit_status to ENABLED_OPTIONAL or ENABLED_MANDATORY along with deposit_value and deposit_unit. Estimates are always created as DRAFT.",
    inputSchema: {
      customer_id: z.string().describe("Customer to quote."),
      items: lineItemsSchema,
      business_id: businessIdSchema,
      title: z.string().optional().describe('Heading on the estimate. Defaults to "Estimate".'),
      subhead: z.string().optional().describe("Text under the title."),
      estimate_number: z.string().optional().describe("Your own number. Wave assigns the next one if omitted."),
      po_number: z.string().optional().describe("Customer purchase order number."),
      estimate_date: z.string().optional().describe("Issue date, YYYY-MM-DD. Defaults to today."),
      due_date: z.string().optional().describe("Expiry date, YYYY-MM-DD."),
      currency: z.string().optional().describe("Currency code. Defaults to the customer or business currency."),
      exchange_rate: z.string().optional().describe("Rate to the business currency."),
      memo: z.string().optional().describe("Note shown to the customer."),
      footer: z.string().optional().describe("Footer text."),
      discounts: discountsSchema,
      deposit_status: z.string().optional().describe("DISABLED, ENABLED_OPTIONAL, or ENABLED_MANDATORY."),
      deposit_value: z.string().optional().describe('Deposit amount or percentage, e.g. "25".'),
      deposit_unit: z.string().optional().describe("AMOUNT or PERCENTAGE."),
      ...documentPresentationSchema,
      response_format: responseFormatSchema,
    },
  },
  async (args) => {
    const resolved = requireBusinessId(args.business_id);
    const items = stripEstimateItemTaxes(normalizeLineItems(args.items, "Estimate", { allowName: true }));
    const input = compact({
      businessId: resolved,
      customerId: args.customer_id,
      status: "DRAFT",
      items,
      title: args.title,
      subhead: args.subhead,
      estimateNumber: args.estimate_number,
      poNumber: args.po_number,
      estimateDate: args.estimate_date,
      dueDate: args.due_date,
      currency: args.currency?.toUpperCase(),
      exchangeRate: decimalStr(args.exchange_rate),
      memo: args.memo,
      footer: args.footer,
      discounts: normalizeDiscounts(args.discounts, "Estimate"),
      depositStatus: args.deposit_status?.toUpperCase(),
      depositValue: decimalStr(args.deposit_value),
      depositUnit: args.deposit_unit?.toUpperCase(),
      disableCreditCardPayments: args.disable_credit_card_payments,
      disableBankPayments: args.disable_bank_payments,
      disableAmexPayments: args.disable_amex_payments,
      requireTermsOfServiceAgreement: args.require_terms_of_service_agreement,
    });
    const result = await waveMutate(M_CREATE_ESTIMATE, { input }, "estimateCreate");
    const estimate = result.estimate || {};
    return render(estimate, args.response_format ?? "markdown", () =>
      success(`Created estimate **${estimate.estimateNumber}** (${estimate.status}).`, [
        ["ID", `\`${estimate.id}\``],
        ["Customer", estimate.customer?.name],
        ["Total", money(estimate.total)],
        ["Expires", estimate.dueDate],
        ["View URL", estimate.viewUrl],
      ]) + "\n\nIt is a draft. Call wave_approve_estimate, then wave_send_estimate to email it."
    );
  }
);

registerWriteTool(
  "wave_patch_estimate",
  {
    idempotent: true,
    description:
      "Update an estimate. Wave's estimate patch is unusual: customer_id, status, title, estimate_date, currency, exchange_rate, and due_date are all mandatory even when unchanged. Read the estimate first with wave_get_estimate and pass its current values for anything you are not changing, or those fields will be overwritten. Supplying items replaces every line item.",
    inputSchema: {
      estimate_id: z.string().describe("The estimate to update."),
      customer_id: z.string().describe("Customer. Required by Wave even if unchanged."),
      status: z.string().describe("Current or new status. Required by Wave even if unchanged."),
      title: z.string().describe("Title. Required by Wave even if unchanged."),
      estimate_date: z.string().describe("Issue date, YYYY-MM-DD. Required by Wave even if unchanged."),
      currency: z.string().describe("Currency code. Required by Wave even if unchanged."),
      exchange_rate: z.string().describe("Exchange rate. Required by Wave even if unchanged."),
      due_date: z.string().describe("Expiry date, YYYY-MM-DD. Required by Wave even if unchanged."),
      items: lineItemsSchema.optional().describe("Replacement line items. Replaces all existing items."),
      subhead: z.string().optional().describe("New subhead."),
      estimate_number: z.string().optional().describe("New estimate number."),
      po_number: z.string().optional().describe("New PO number."),
      memo: z.string().optional().describe("New customer-facing memo."),
      footer: z.string().optional().describe("New footer."),
      discounts: discountsSchema,
      deposit_status: z.string().optional().describe("DISABLED, ENABLED_OPTIONAL, ENABLED_MANDATORY."),
      deposit_value: z.string().optional().describe("Deposit amount or percentage."),
      deposit_unit: z.string().optional().describe("AMOUNT or PERCENTAGE."),
      ...documentPresentationSchema,
      response_format: responseFormatSchema,
    },
  },
  async (args) => {
    const input = compact({
      id: args.estimate_id,
      customerId: args.customer_id,
      status: args.status.toUpperCase(),
      title: args.title,
      estimateDate: args.estimate_date,
      currency: args.currency.toUpperCase(),
      exchangeRate: decimalStr(args.exchange_rate),
      dueDate: args.due_date,
      items: args.items
        ? stripEstimateItemTaxes(normalizeLineItems(args.items, "Estimate", { allowName: true }))
        : undefined,
      subhead: args.subhead,
      estimateNumber: args.estimate_number,
      poNumber: args.po_number,
      memo: args.memo,
      footer: args.footer,
      discounts: normalizeDiscounts(args.discounts, "Estimate"),
      depositStatus: args.deposit_status?.toUpperCase(),
      depositValue: decimalStr(args.deposit_value),
      depositUnit: args.deposit_unit?.toUpperCase(),
      disableCreditCardPayments: args.disable_credit_card_payments,
      disableBankPayments: args.disable_bank_payments,
      disableAmexPayments: args.disable_amex_payments,
      requireTermsOfServiceAgreement: args.require_terms_of_service_agreement,
    });
    const result = await waveMutate(M_PATCH_ESTIMATE, { input }, "estimatePatch");
    const estimate = result.estimate || {};
    return render(estimate, args.response_format ?? "markdown", () =>
      success(`Updated estimate **${estimate.estimateNumber}**.`, [
        ["ID", `\`${estimate.id}\``],
        ["Status", estimate.status],
        ["Total", money(estimate.total)],
      ])
    );
  }
);

registerWriteTool(
  "wave_clone_estimate",
  {
    description: "Copy an estimate into a new draft.",
    inputSchema: {
      estimate_id: z.string().describe("The estimate to copy."),
      response_format: responseFormatSchema,
    },
  },
  async ({ estimate_id, response_format = "markdown" }) => {
    const result = await waveMutate(M_CLONE_ESTIMATE, { input: { estimateId: estimate_id } }, "estimateClone");
    const estimate = result.estimate || {};
    return render(estimate, response_format, () =>
      success(`Cloned into draft estimate **${estimate.estimateNumber}**.`, [
        ["New ID", `\`${estimate.id}\``],
        ["Status", estimate.status],
        ["Total", money(estimate.total)],
      ])
    );
  }
);

registerWriteTool(
  "wave_approve_estimate",
  {
    idempotent: true,
    description:
      "Approve a draft estimate so it can be sent to the customer. This does not notify anyone: use wave_send_estimate for that.",
    inputSchema: {
      estimate_id: z.string().describe("The draft estimate to approve."),
      response_format: responseFormatSchema,
    },
  },
  async ({ estimate_id, response_format = "markdown" }) => {
    const result = await waveMutate(M_APPROVE_ESTIMATE, { input: { estimateId: estimate_id } }, "estimateApprove");
    const estimate = result.estimate || {};
    return render(estimate, response_format, () =>
      success(`Approved estimate **${estimate.estimateNumber}**.`, [
        ["ID", `\`${estimate.id}\``],
        ["Status", estimate.status],
        ["View URL", estimate.viewUrl],
      ]) + "\n\nThe customer has not been notified. Call wave_send_estimate to email it."
    );
  }
);

registerWriteTool(
  "wave_send_estimate",
  {
    description:
      "Email an estimate to a customer through Wave. This sends real email to real recipients, so confirm the addresses before calling it. Sending is not reversible.",
    inputSchema: {
      estimate_id: z.string().describe("The estimate to send."),
      to: z.union([z.string(), z.array(z.string())]).describe("Recipient email address, or a list of them."),
      subject: z.string().optional().describe("Email subject. Wave supplies a default."),
      message: z.string().optional().describe("Body text. Wave supplies a default."),
      attach_pdf: z.boolean().default(false).describe("Attach the estimate PDF."),
      cc_myself: z.boolean().optional().describe("Send a copy to the business email."),
      from_address: z.string().optional().describe("Reply-to address; must be verified in Wave."),
      hide_grand_total: z.boolean().default(false).describe("Omit the grand total from the email body."),
      include_attachments: z.boolean().default(false).describe("Include files attached to the estimate."),
      response_format: responseFormatSchema,
    },
  },
  async (args) => {
    const recipients = normalizeRecipients(args.to, "wave_send_estimate");
    const input = compact({
      estimateId: args.estimate_id,
      to: recipients,
      subject: args.subject,
      message: args.message,
      attachPDF: args.attach_pdf ?? false,
      ccMyself: args.cc_myself,
      fromAddress: args.from_address,
      hideGrandTotal: args.hide_grand_total ?? false,
      includeAttachments: args.include_attachments ?? false,
    });
    const result = await waveMutate(M_SEND_ESTIMATE, { input }, "estimateSend");
    const estimate = result.estimate || {};
    return render(estimate, args.response_format ?? "markdown", () =>
      success(`Sent estimate **${estimate.estimateNumber}** to ${recipients.join(", ")}.`, [
        ["ID", `\`${estimate.id}\``],
        ["Status", estimate.status],
        ["Sent at", estimate.lastSentAt],
        ["View URL", estimate.viewUrl],
      ])
    );
  }
);

registerWriteTool(
  "wave_mark_estimate_sent",
  {
    idempotent: true,
    description: "Record that an estimate was delivered outside Wave. Sends no email.",
    inputSchema: {
      estimate_id: z.string().describe("The estimate to mark."),
      send_method: z
        .string()
        .default("MARKED_SENT")
        .describe("MARKED_SENT, EXPORT_PDF, SHARED_LINK, GMAIL, OUTLOOK, YAHOO, WAVE, NOT_SENT, SKIPPED."),
      sent_at: z.string().optional().describe("When it was sent, ISO 8601. Defaults to now."),
      response_format: responseFormatSchema,
    },
  },
  async ({ estimate_id, send_method = "MARKED_SENT", sent_at, response_format = "markdown" }) => {
    const input = compact({ estimateId: estimate_id, sendMethod: send_method.toUpperCase(), sentAt: sent_at });
    const result = await waveMutate(M_MARK_SENT_ESTIMATE, { input }, "estimateMarkSent");
    const estimate = result.estimate || {};
    return render(estimate, response_format, () =>
      success(`Marked estimate **${estimate.estimateNumber}** as sent. No email was sent.`, [
        ["ID", `\`${estimate.id}\``],
        ["Status", estimate.status],
      ])
    );
  }
);

registerWriteTool(
  "wave_mark_estimate_accepted",
  {
    idempotent: true,
    description:
      "Record that the customer accepted an estimate. Use this when acceptance happened offline. An accepted estimate can be turned into an invoice with wave_convert_estimate_to_invoice.",
    inputSchema: {
      estimate_id: z.string().describe("The estimate the customer accepted."),
      response_format: responseFormatSchema,
    },
  },
  async ({ estimate_id, response_format = "markdown" }) => {
    const result = await waveMutate(
      M_MARK_ACCEPTED_ESTIMATE,
      { input: { estimateId: estimate_id } },
      "estimateMarkAccepted"
    );
    const estimate = result.estimate || {};
    return render(estimate, response_format, () =>
      success(`Marked estimate **${estimate.estimateNumber}** as accepted.`, [
        ["ID", `\`${estimate.id}\``],
        ["Status", estimate.status],
      ]) + "\n\nCall wave_convert_estimate_to_invoice to bill it."
    );
  }
);

registerWriteTool(
  "wave_reset_estimate_acceptance",
  {
    destructive: true,
    idempotent: true,
    description:
      "Undo an estimate's acceptance, returning it to an unaccepted state. This discards the recorded acceptance, including who accepted and when.",
    inputSchema: {
      estimate_id: z.string().describe("The estimate to reset."),
      response_format: responseFormatSchema,
    },
  },
  async ({ estimate_id, response_format = "markdown" }) => {
    const result = await waveMutate(
      M_RESET_ACCEPTANCE,
      { input: { estimateId: estimate_id } },
      "estimateResetAcceptance"
    );
    const estimate = result.estimate || {};
    return render(estimate, response_format, () =>
      success(`Reset acceptance on estimate **${estimate.estimateNumber}**.`, [
        ["ID", `\`${estimate.id}\``],
        ["Status", estimate.status],
      ])
    );
  }
);

registerWriteTool(
  "wave_send_estimate_acceptance_email",
  {
    description:
      "Email the customer a confirmation that their estimate was accepted. This sends real email to the customer on file.",
    inputSchema: {
      estimate_id: z.string().describe("The accepted estimate."),
      response_format: responseFormatSchema,
    },
  },
  async ({ estimate_id, response_format = "markdown" }) => {
    const result = await waveMutate(
      M_SEND_ACCEPTANCE_EMAIL,
      { input: { estimateId: estimate_id } },
      "estimateSendAcceptanceCustomerEmail"
    );
    const estimate = result.estimate || {};
    return render(estimate, response_format, () =>
      success(`Sent an acceptance confirmation for estimate **${estimate.estimateNumber}**.`, [
        ["ID", `\`${estimate.id}\``],
        ["Status", estimate.status],
      ])
    );
  }
);

registerWriteTool(
  "wave_generate_estimate_pdf",
  {
    idempotent: true,
    description: "Generate a PDF of an estimate and return its download URL.",
    inputSchema: {
      estimate_id: z.string().describe("The estimate to render."),
      response_format: responseFormatSchema,
    },
  },
  async ({ estimate_id, response_format = "markdown" }) => {
    const result = await waveMutate(M_GENERATE_PDF, { input: { estimateId: estimate_id } }, "estimateGeneratePdf");
    return render({ pdfUrl: result.pdfUrl }, response_format, () =>
      success(`Generated a PDF for estimate \`${estimate_id}\`.`, [["PDF URL", result.pdfUrl]])
    );
  }
);

registerWriteTool(
  "wave_convert_estimate_to_invoice",
  {
    description:
      "Turn an accepted estimate into an invoice. Wave copies the customer, line items, and totals onto a new invoice and marks the estimate CONVERTED. The invoice starts as a draft.",
    inputSchema: {
      estimate_id: z.string().describe("The estimate to convert."),
      response_format: responseFormatSchema,
    },
  },
  async ({ estimate_id, response_format = "markdown" }) => {
    const result = await waveMutate(
      M_CONVERT_TO_INVOICE,
      { input: { estimateId: estimate_id } },
      "convertEstimateToInvoice"
    );
    return render({ invoiceId: result.invoiceId }, response_format, () =>
      success(`Converted estimate \`${estimate_id}\` into an invoice.`, [
        ["New invoice ID", `\`${result.invoiceId}\``],
      ]) + "\n\nCall wave_get_invoice to review it, then wave_approve_invoice to finalize."
    );
  }
);

registerWriteTool(
  "wave_delete_estimate",
  {
    destructive: true,
    idempotent: true,
    description: "Delete an estimate. This cannot be undone.",
    inputSchema: { estimate_id: z.string().describe("The estimate to delete.") },
  },
  async ({ estimate_id }) => {
    await waveMutate(M_DELETE_ESTIMATE, { input: { estimateId: estimate_id } }, "estimateDelete");
    return ok(`Deleted estimate \`${estimate_id}\`.`);
  }
);

// --- Tools: estimate deposit payments ---

const Q_GET_ESTIMATE_PAYMENT = gql(
  `
query GetEstimatePayment($businessId: ID!, $id: ID!) {
  business(id: $businessId) {
    id
    estimatePayment(id: $id) {
      ...EstimatePaymentFields
      estimate { id estimateNumber status }
    }
  }
}`,
  "estimatePayment"
);

const M_CREATE_ESTIMATE_PAYMENT = gql(
  `
mutation CreateEstimateDepositPayment($input: EstimateDepositPaymentCreateManualInput!) {
  estimateDepositPaymentCreateManual(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    estimatePayment { ...EstimatePaymentFields }
  }
}`,
  "estimatePayment"
);

const M_UPDATE_ESTIMATE_PAYMENT = gql(
  `
mutation UpdateEstimateDepositPayment($input: EstimateDepositPaymentUpdateManualInput!) {
  estimateDepositPaymentUpdateManual(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    estimatePayment { ...EstimatePaymentFields }
  }
}`,
  "estimatePayment"
);

const M_DELETE_ESTIMATE_PAYMENT = gql(`
mutation DeleteEstimatePayment($input: EstimatePaymentDeleteInput!) {
  estimatePaymentDelete(input: $input) { didSucceed ${INPUT_ERRORS} }
}`);

const M_SEND_ESTIMATE_RECEIPT = gql(`
mutation SendEstimateDepositReceipt($input: EstimateDepositPaymentReceiptSendInput!) {
  estimateDepositPaymentReceiptSend(input: $input) { didSucceed ${INPUT_ERRORS} }
}`);

registerTool(
  "wave_get_estimate_payment",
  {
    readOnly: true,
    description:
      "Get one estimate deposit payment by ID. To see every deposit on an estimate, call wave_get_estimate with include_deposit_payments=true.",
    inputSchema: {
      payment_id: z.string().describe("The Wave estimate payment ID."),
      business_id: businessIdSchema,
      response_format: responseFormatSchema,
    },
  },
  async ({ payment_id, business_id, response_format = "markdown" }) => {
    const resolved = requireBusinessId(business_id);
    const data = await waveFetch(Q_GET_ESTIMATE_PAYMENT, { businessId: resolved, id: payment_id });
    const payment = data.business?.estimatePayment;
    if (!payment) return ok(`No estimate payment found with ID \`${payment_id}\` in this business.`);
    return render(payment, response_format, () => paymentDetail(payment, "Estimate deposit"));
  }
);

registerWriteTool(
  "wave_create_estimate_deposit_payment",
  {
    description:
      "Record a deposit received against an estimate. Use this for money taken up front, before the estimate becomes an invoice. It records a payment you already received; it does not charge anyone.",
    inputSchema: {
      estimate_id: z.string().describe("The estimate the deposit applies to."),
      amount: z.string().describe(`Amount received. ${DECIMAL_HINT}`),
      payment_date: z.string().describe("Date received, YYYY-MM-DD."),
      payment_method: z.string().default("OTHER").describe("CASH, CHEQUE, CREDIT_CARD, BANK_TRANSFER, PAYPAL, OTHER."),
      payment_account_id: z.string().optional().describe("Bank or cash account the money landed in."),
      memo: z.string().optional().describe("Note on the deposit."),
      response_format: responseFormatSchema,
    },
  },
  async ({ estimate_id, amount, payment_date, payment_method = "OTHER", payment_account_id, memo, response_format = "markdown" }) => {
    const input = compact({
      estimateId: estimate_id,
      amount: decimalStr(amount),
      paymentDate: payment_date,
      paymentMethod: payment_method.toUpperCase(),
      paymentAccountId: payment_account_id,
      memo,
    });
    const result = await waveMutate(M_CREATE_ESTIMATE_PAYMENT, { input }, "estimateDepositPaymentCreateManual");
    const payment = result.estimatePayment || {};
    return render(payment, response_format, () =>
      success(`Recorded a ${payment.amount ?? amount} deposit on estimate \`${estimate_id}\`.`, [
        ["Payment ID", `\`${payment.id}\``],
        ["Payment date", payment.paymentDate],
        ["Method", payment.paymentMethod],
        ["State", payment.state],
      ])
    );
  }
);

registerWriteTool(
  "wave_update_estimate_deposit_payment",
  {
    idempotent: true,
    description:
      "Update a recorded estimate deposit. Only the fields you supply change. Wave requires the estimate ID alongside the payment ID.",
    inputSchema: {
      payment_id: z.string().describe("The deposit payment to update."),
      estimate_id: z.string().describe("The estimate it belongs to. Required by Wave."),
      amount: z.string().optional().describe(`Corrected amount. ${DECIMAL_HINT}`),
      payment_date: z.string().optional().describe("Corrected date, YYYY-MM-DD."),
      payment_method: z.string().optional().describe("CASH, CHEQUE, CREDIT_CARD, BANK_TRANSFER, PAYPAL, OTHER."),
      payment_account_id: z.string().optional().describe("Move the deposit to a different bank account."),
      memo: z.string().optional().describe("New memo."),
      response_format: responseFormatSchema,
    },
  },
  async ({ payment_id, estimate_id, amount, payment_date, payment_method, payment_account_id, memo, response_format = "markdown" }) => {
    const input = compact({
      id: payment_id,
      estimateId: estimate_id,
      amount: decimalStr(amount),
      paymentDate: payment_date,
      paymentMethod: payment_method?.toUpperCase(),
      paymentAccountId: payment_account_id,
      memo,
    });
    if (Object.keys(input).length === 2) return ok("Nothing to update. Supply at least one field to change.");
    const result = await waveMutate(M_UPDATE_ESTIMATE_PAYMENT, { input }, "estimateDepositPaymentUpdateManual");
    const payment = result.estimatePayment || {};
    return render(payment, response_format, () =>
      success(`Updated deposit payment on estimate \`${estimate_id}\`.`, [
        ["Payment ID", `\`${payment.id}\``],
        ["Amount", payment.amount],
        ["Payment date", payment.paymentDate],
      ])
    );
  }
);

registerWriteTool(
  "wave_delete_estimate_payment",
  {
    destructive: true,
    idempotent: true,
    description: "Delete a recorded estimate deposit payment. This cannot be undone.",
    inputSchema: { payment_id: z.string().describe("The deposit payment to delete.") },
  },
  async ({ payment_id }) => {
    await waveMutate(M_DELETE_ESTIMATE_PAYMENT, { input: { id: payment_id } }, "estimatePaymentDelete");
    return ok(`Deleted estimate deposit payment \`${payment_id}\`.`);
  }
);

registerWriteTool(
  "wave_send_estimate_deposit_receipt",
  {
    description: "Email a deposit receipt to a customer. This sends real email to real recipients.",
    inputSchema: {
      estimate_id: z.string().describe("The estimate the deposit belongs to."),
      payment_id: z.string().describe("The deposit payment to receipt."),
      to: z.union([z.string(), z.array(z.string())]).describe("Recipient email address, or a list of them."),
      subject: z.string().optional().describe("Email subject. Wave supplies a default."),
      message: z.string().optional().describe("Body text. Wave supplies a default."),
      attach_pdf: z.boolean().optional().describe("Attach the receipt as a PDF."),
      cc_myself: z.boolean().optional().describe("Send a copy to the business email."),
      from_address: z.string().optional().describe("Reply-to address; must be verified in Wave."),
    },
  },
  async ({ estimate_id, payment_id, to, subject, message, attach_pdf, cc_myself, from_address }) => {
    const recipients = normalizeRecipients(to, "wave_send_estimate_deposit_receipt");
    const input = compact({
      estimateId: estimate_id,
      estimatePaymentId: payment_id,
      to: recipients,
      subject,
      message,
      attachPdf: attach_pdf,
      ccMyself: cc_myself,
      fromAddress: from_address,
    });
    await waveMutate(M_SEND_ESTIMATE_RECEIPT, { input }, "estimateDepositPaymentReceiptSend");
    return ok(`Sent a deposit receipt for estimate \`${estimate_id}\` to ${recipients.join(", ")}.`);
  }
);

// --- Tools: money (bookkeeping) transactions ---
// These write directly to the general ledger. Wave's model is double-entry:
// the anchor is the account money physically moved through, and the line items
// are the categories it is attributed to, which must total the anchor amount.
//
// One asymmetry: Wave can create money transactions but offers no query to
// read them back. There is no `transactions` connection on Business.

const M_CREATE_TRANSACTION = gql(`
mutation CreateMoneyTransaction($input: MoneyTransactionCreateInput!) {
  moneyTransactionCreate(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    transaction { id }
  }
}`);

const M_CREATE_TRANSACTIONS = gql(`
mutation CreateMoneyTransactions($input: MoneyTransactionsCreateInput!) {
  moneyTransactionsCreate(input: $input) {
    didSucceed
    ${INPUT_ERRORS}
    transactions { id }
  }
}`);

const M_CREATE_DEPOSIT = gql(`
mutation CreateMoneyDepositTransaction($input: MoneyDepositTransactionCreateInput!) {
  moneyDepositTransactionCreate(input: $input) { didSucceed ${INPUT_ERRORS} }
}`);

const transactionLineItemsSchema = z
  .array(
    z.object({
      accountId: z.string().describe("Category account this portion is attributed to."),
      amount: z.union([z.string(), z.number()]).describe(`Portion of the total. ${DECIMAL_HINT}`),
      balance: z.string().optional().describe("INCREASE (default), DECREASE, DEBIT, or CREDIT."),
      customerId: z.string().optional().describe("Attribute this line to a customer."),
      description: z.string().optional().describe("Line-level note."),
      taxes: z
        .array(z.object({ salesTaxId: z.string(), amount: z.union([z.string(), z.number()]) }))
        .optional()
        .describe("Sales taxes on this line."),
    })
  )
  .describe("Category allocations. Amounts must total the anchor amount.");

registerWriteTool(
  "wave_create_money_transaction",
  {
    description:
      "Record a bookkeeping transaction: an expense, income, or transfer. Wave is double-entry, so a transaction has two sides. The anchor is the bank account or credit card the money moved through, with direction WITHDRAWAL for money out or DEPOSIT for money in. The line items are the categories it is attributed to, and their amounts must total the anchor amount. A $50 office-supplies expense paid from checking is one anchor (checking, WITHDRAWAL, 50.00) and one line item (Office Supplies, 50.00). Splits just add line items. Wave marks this mutation BETA: it requires a business with classic accounting disabled.",
    inputSchema: {
      anchor_account_id: z.string().describe("Bank or credit card account the money moved through."),
      direction: z.string().describe("WITHDRAWAL for money out, DEPOSIT for money in."),
      amount: z.string().describe(`Total transaction amount. ${DECIMAL_HINT}`),
      date: z.string().describe("Transaction date, YYYY-MM-DD."),
      description: z.string().describe("What the transaction was for."),
      line_items: transactionLineItemsSchema,
      business_id: businessIdSchema,
      external_id: z
        .string()
        .optional()
        .describe("Your own idempotency key. Wave dedupes on it, so reusing a value makes a retry safe."),
      notes: z.string().optional().describe("Internal note on the transaction."),
      response_format: responseFormatSchema,
    },
  },
  async (args) => {
    const resolved = requireBusinessId(args.business_id);
    const lineItems = normalizeTransactionLineItems(args.line_items, "wave_create_money_transaction");
    assertBalanced(args.amount, lineItems, "wave_create_money_transaction");
    const id = externalId("wave-mcp", args.external_id);
    const input = compact({
      businessId: resolved,
      externalId: id,
      date: args.date,
      description: args.description,
      notes: args.notes,
      anchor: {
        accountId: args.anchor_account_id,
        amount: decimalStr(args.amount),
        direction: args.direction.toUpperCase(),
      },
      lineItems,
    });
    const result = await waveMutate(M_CREATE_TRANSACTION, { input }, "moneyTransactionCreate");
    const transaction = result.transaction || {};
    return render(transaction, args.response_format ?? "markdown", () =>
      success(`Recorded a ${args.direction.toUpperCase()} of ${args.amount} on ${args.date}.`, [
        ["Transaction ID", `\`${transaction.id}\``],
        ["Description", args.description],
        ["Line items", lineItems.length],
        ["External ID", id],
      ])
    );
  }
);

registerWriteTool(
  "wave_create_money_transactions",
  {
    description:
      "Record several bookkeeping transactions in one call. Wave applies the batch atomically: if one transaction is rejected, none are recorded. Use this for bulk import rather than looping over wave_create_money_transaction. Wave marks this mutation BETA: it requires a business with classic accounting disabled.",
    inputSchema: {
      transactions: z
        .array(
          z.object({
            date: z.string().describe("Transaction date, YYYY-MM-DD."),
            description: z.string().describe("What the transaction was for."),
            externalId: z.string().optional().describe("Your own idempotency key."),
            notes: z.string().optional().describe("Internal note."),
            anchor: z.object({
              accountId: z.string().describe("Bank or credit card account."),
              amount: z.union([z.string(), z.number()]).describe("Total amount."),
              direction: z.string().describe("WITHDRAWAL or DEPOSIT."),
            }),
            lineItems: transactionLineItemsSchema,
          })
        )
        .describe("The transactions to record."),
      business_id: businessIdSchema,
      response_format: responseFormatSchema,
    },
  },
  async ({ transactions, business_id, response_format = "markdown" }) => {
    const resolved = requireBusinessId(business_id);
    if (!transactions?.length) throw new WaveError("Supply at least one transaction.");

    const prepared = transactions.map((entry, index) => {
      const label = `Transaction ${index + 1}`;
      if (!entry.anchor) {
        throw new WaveError(
          `${label} is missing its anchor. Supply {"accountId": "...", "amount": "...", "direction": "WITHDRAWAL"}.`
        );
      }
      for (const field of ["date", "description"]) {
        if (!entry[field]) throw new WaveError(`${label} is missing '${field}'.`);
      }
      const lineItems = normalizeTransactionLineItems(entry.lineItems ?? entry.line_items, label);
      assertBalanced(entry.anchor.amount, lineItems, label);
      return compact({
        externalId: externalId(`wave-mcp-batch-${index + 1}`, entry.externalId),
        date: entry.date,
        description: entry.description,
        notes: entry.notes,
        anchor: {
          accountId: entry.anchor.accountId,
          amount: decimalStr(entry.anchor.amount),
          direction: String(entry.anchor.direction).toUpperCase(),
        },
        lineItems,
      });
    });

    const result = await waveMutate(
      M_CREATE_TRANSACTIONS,
      { input: { businessId: resolved, transactions: prepared } },
      "moneyTransactionsCreate"
    );
    const created = (result.transactions || []).filter(Boolean);
    return render(created, response_format, () => {
      let body = success(`Recorded ${created.length} transaction(s).`);
      if (created.length) {
        body += `\n\n${table(
          created.map((t, i) => ({ n: i + 1, id: t.id, description: prepared[i].description })),
          [
            ["#", "n"],
            ["Transaction ID", "id"],
            ["Description", "description"],
          ]
        )}`;
      }
      return body;
    });
  }
);

registerWriteTool(
  "wave_create_deposit_transaction",
  {
    description:
      "Record a deposit whose net differs from its gross because of fees. This is the shape of a payment-processor payout: the customer paid $100, the processor kept $3, and $97 reached the bank. deposit_amount is the $97 that landed, line items carry the $100 of income, and fees carry the $3, so gross and net both stay correct. Wave has deprecated the underlying mutation and documents it as not for public use; it still responds today, but prefer wave_create_money_transaction with split line items plus a fees expense line for new work, and move over if this starts failing.",
    inputSchema: {
      deposit_account_id: z.string().describe("Bank account the net amount landed in."),
      deposit_amount: z.string().describe("Net amount deposited, after fees."),
      date: z.string().describe("Deposit date, YYYY-MM-DD."),
      description: z.string().describe("What the deposit was for."),
      line_items: z
        .array(
          z.object({
            accountId: z.string().describe("Income (or other) account for the gross amount."),
            amount: z.union([z.string(), z.number()]).describe("Gross amount before fees."),
            customerId: z.string().optional().describe("Attribute this line to a customer."),
            taxes: z
              .array(
                z.object({
                  abbreviation: z.string().describe("Sales tax abbreviation, e.g. HST."),
                  amount: z.union([z.string(), z.number()]).describe("Tax amount."),
                })
              )
              .optional()
              .describe("Sales taxes on this line. Identified by abbreviation, not ID."),
          })
        )
        .describe("Gross allocations. Must total the deposit amount plus the fees."),
      business_id: businessIdSchema,
      fees: z
        .array(
          z.object({
            accountId: z.string().describe("Usually a payment-processing-fees expense account."),
            amount: z.union([z.string(), z.number()]).describe("Amount withheld."),
          })
        )
        .optional()
        .describe("Amounts withheld by the processor."),
      origin: z.string().default("MANUAL").describe("MANUAL or ZAPIER."),
      external_id: z.string().optional().describe("Your own idempotency key."),
      notes: z.string().optional().describe("Internal note on the transaction."),
      response_format: responseFormatSchema,
    },
  },
  async (args) => {
    const resolved = requireBusinessId(args.business_id);
    if (!args.line_items?.length) throw new WaveError("At least one line item is required.");

    const lineItems = args.line_items.map((item, index) => {
      if (!item.accountId || item.amount == null) {
        throw new WaveError(`Line item ${index + 1} needs both accountId and amount.`);
      }
      const entry = {
        accountId: item.accountId,
        // Wave types this input as Float, unlike Decimal everywhere else.
        amount: Number.parseFloat(item.amount),
        // Wave requires the taxes list to be present even when empty.
        taxes: (item.taxes || []).map((t) => ({
          abbreviation: t.abbreviation,
          amount: Number.parseFloat(t.amount),
        })),
      };
      if (item.customerId) entry.customerId = item.customerId;
      return entry;
    });

    const fees = (args.fees || []).map((fee, index) => {
      if (!fee.accountId || fee.amount == null) {
        throw new WaveError(`Fee ${index + 1} needs both accountId and amount.`);
      }
      return { accountId: fee.accountId, amount: Number.parseFloat(fee.amount) };
    });

    const id = externalId("wave-mcp-deposit", args.external_id);
    const input = compact({
      businessId: resolved,
      externalId: id,
      date: args.date,
      description: args.description,
      notes: args.notes,
      origin: (args.origin ?? "MANUAL").toUpperCase(),
      deposit: { accountId: args.deposit_account_id, amount: Number.parseFloat(args.deposit_amount) },
      lineItems,
      fees: fees.length ? fees : undefined,
    });
    await waveMutate(M_CREATE_DEPOSIT, { input }, "moneyDepositTransactionCreate");

    const feeTotal = fees.reduce((sum, f) => sum + f.amount, 0);
    const gross = lineItems.reduce((sum, l) => sum + l.amount, 0);
    return render({ deposited: args.deposit_amount, gross, fees: feeTotal }, args.response_format ?? "markdown", () =>
      success(`Recorded a deposit of ${args.deposit_amount} on ${args.date}.`, [
        ["Description", args.description],
        ["Gross line items", gross.toFixed(2)],
        ["Fees withheld", feeTotal.toFixed(2)],
        ["External ID", id],
      ]) +
      "\n\nWave's API returns no ID for deposit transactions, so there is nothing to reference later. Find it in the Wave web app under Accounting > Transactions."
    );
  }
);

// --- Tools: convenience wrappers ---
// Shortcuts over wave_create_money_transaction: hand them a receipt and a
// category word like "meals" or "fuel", and they find the matching account
// instead of making you look up an ID first.

// Everyday words mapped onto the vocabulary a chart of accounts actually uses.
const EXPENSE_SYNONYMS = {
  food: ["meals", "restaurant", "dining", "entertainment"],
  gas: ["fuel", "gasoline", "petrol", "diesel", "motor"],
  travel: ["transportation", "transport", "trip", "mileage", "airfare"],
  office: ["supplies", "equipment", "materials", "stationery"],
  car: ["vehicle", "auto", "automobile", "automotive", "motor"],
  phone: ["mobile", "cellular", "telecommunications", "telecom"],
  internet: ["web", "online", "broadband", "wifi", "telecommunications"],
  insurance: ["coverage", "policy", "premium"],
  rent: ["rental", "lease", "leasing", "occupancy"],
  utilities: ["electric", "electricity", "water", "power", "heat"],
  marketing: ["advertising", "promotion", "ads", "publicity"],
  software: ["subscription", "saas", "dues", "computer"],
  training: ["education", "learning", "course", "workshop", "development"],
  legal: ["attorney", "lawyer", "law", "professional"],
  accounting: ["bookkeeping", "tax", "professional", "financial"],
  maintenance: ["repair", "service", "upkeep", "cleaning"],
  bank: ["fees", "charges", "service charge", "interest"],
  shipping: ["postage", "freight", "delivery", "courier"],
};

const INCOME_SYNONYMS = {
  sales: ["revenue", "income", "receipts", "earnings", "product"],
  consulting: ["services", "professional", "advisory", "fees"],
  freelance: ["contract", "project", "services"],
  commission: ["referral", "bonus", "incentive"],
  interest: ["dividend", "investment", "return"],
  rental: ["rent", "lease", "property", "tenant", "leasing"],
  royalty: ["licensing", "intellectual property", "patent"],
  other: ["miscellaneous", "misc", "various", "general"],
};

// Below this, a match is too weak to act on silently.
const MIN_MATCH_CONFIDENCE = 0.55;

/** Similarity of two strings, 0..1, via the normalized Levenshtein distance. */
function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i += 1) {
    const curr = [i];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return 1 - prev[cols - 1] / Math.max(a.length, b.length);
}

/**
 * Score how well one account matches a category word.
 *
 * Returns [score, explanation]. The explanation travels back to the caller so
 * a low-confidence pick is visible rather than silent.
 */
function scoreAccount(category, account, synonyms) {
  const needle = category.toLowerCase().trim();
  const name = (account.name || "").toLowerCase();

  if (needle === name) return [1, `exact name match on '${account.name}'`];
  // A name that opens with the category is a stronger signal than one where it
  // merely appears, so startsWith is checked first and scores higher.
  if (name.startsWith(needle)) return [0.95, `'${account.name}' starts with '${category}'`];
  if (name.includes(needle)) return [0.9, `'${category}' appears in '${account.name}'`];

  let best = 0;
  let why = "";

  const whole = similarity(needle, name);
  if (whole > best) {
    best = whole;
    why = `'${account.name}' is similar to '${category}'`;
  }
  for (const word of name.split(/\s+/)) {
    const wordScore = similarity(needle, word);
    if (wordScore > best) {
      best = wordScore;
      why = `'${word}' in '${account.name}' matches '${category}'`;
    }
  }

  // Synonyms: map the caller's word onto a family of related terms, then look
  // for any of them in the account name.
  for (const [key, related] of Object.entries(synonyms)) {
    const family = [key, ...related];
    if (!family.includes(needle)) continue;
    for (const term of family) {
      if (!name.includes(term)) continue;
      const score = term === key ? 0.85 : 0.8;
      if (score > best) {
        best = score;
        why = `'${category}' relates to '${term}', found in '${account.name}'`;
      }
    }
  }

  return [best, why];
}

function matchAccount(category, accounts, synonyms, kind) {
  if (!accounts.length) {
    throw new WaveError(
      `This business has no active ${kind} accounts, so there is nothing to categorize against. Create one with wave_create_account.`
    );
  }
  const scored = accounts
    .map((account) => {
      const [score, why] = scoreAccount(category, account, synonyms);
      return { account, score, why };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (top.score < MIN_MATCH_CONFIDENCE) {
    const options = accounts.slice(0, 10).map((a) => `'${a.name}'`).join(", ");
    throw new WaveError(
      `No ${kind} account confidently matches '${category}' (best was '${top.account.name}' at ` +
        `${Math.round(top.score * 100)}%). Rather than guess, pick one explicitly and call ` +
        `wave_create_money_transaction. Available ${kind} accounts: ${options}`
    );
  }
  return top;
}

async function activeAccounts(businessId, types) {
  const result = await walkPages(
    Q_LIST_ACCOUNTS,
    { businessId, types, isArchived: false },
    ["business", "accounts"],
    { pageSize: MAX_PAGE_SIZE, fetchAll: true }
  );
  return result.items;
}

/** Resolve the bank or card account money moves through. */
async function resolvePaymentAccount(businessId, requestedName, purpose) {
  const accounts = await activeAccounts(businessId, ["ASSET", "LIABILITY"]);
  const usable = accounts.filter((a) =>
    ["CASH_AND_BANK", "CREDIT_CARD", "LOANS", "MONEY_IN_TRANSIT"].includes(a.subtype?.value)
  );
  if (!usable.length) {
    throw new WaveError(
      `No bank, cash, or credit card account exists in this business, so there is nothing to ${purpose}. ` +
        'Create one with wave_create_account using subtype "CASH_AND_BANK".'
    );
  }
  if (!requestedName) return usable[0];

  const needle = requestedName.toLowerCase().trim();
  const exact = usable.find((a) => (a.name || "").toLowerCase() === needle);
  if (exact) return exact;
  const partial = usable.find((a) => (a.name || "").toLowerCase().includes(needle));
  if (partial) return partial;

  const options = usable.map((a) => `'${a.name}'`).join(", ");
  throw new WaveError(`No account named '${requestedName}' was found. Available accounts: ${options}`);
}

registerWriteTool(
  "wave_create_expense_from_receipt",
  {
    description:
      'Record an expense, matching a category word to an expense account. A shortcut over wave_create_money_transaction for entering a receipt: give it "fuel" or "office supplies" and it finds the account. When nothing matches confidently it says so and lists the options rather than guessing. Wave\'s API cannot attach a vendor to a money transaction, so vendor_name is recorded in the description.',
    inputSchema: {
      amount: z.string().describe(`Total on the receipt. ${DECIMAL_HINT}`),
      date: z.string().describe("Date on the receipt, YYYY-MM-DD."),
      category: z
        .string()
        .default("General Expenses")
        .describe('Category word to match, e.g. "meals", "fuel", "software".'),
      business_id: businessIdSchema,
      vendor_name: z.string().optional().describe("Merchant name, folded into the description."),
      description: z.string().optional().describe("Overrides the generated description."),
      payment_account: z
        .string()
        .optional()
        .describe('Name of the account paid from, e.g. "Business Checking". Defaults to the first bank or card account.'),
      receipt_text: z.string().optional().describe("Raw receipt text, stored in the transaction notes."),
      notes: z.string().optional().describe("Internal note. Takes precedence over receipt_text."),
      response_format: responseFormatSchema,
    },
  },
  async (args) => {
    const resolved = requireBusinessId(args.business_id);
    const category = args.category ?? "General Expenses";
    const expenseAccounts = await activeAccounts(resolved, ["EXPENSE"]);
    const match = matchAccount(category, expenseAccounts, EXPENSE_SYNONYMS, "expense");
    const anchor = await resolvePaymentAccount(resolved, args.payment_account, "pay from");

    const description =
      args.description ?? (args.vendor_name ? `Expense - ${args.vendor_name}` : `Expense - ${category}`);
    const id = externalId("wave-mcp-receipt", null);
    const input = compact({
      businessId: resolved,
      externalId: id,
      date: args.date,
      description,
      notes: args.notes ?? args.receipt_text,
      anchor: { accountId: anchor.id, amount: String(args.amount), direction: "WITHDRAWAL" },
      lineItems: [{ accountId: match.account.id, amount: String(args.amount), balance: "INCREASE" }],
    });
    const result = await waveMutate(M_CREATE_TRANSACTION, { input }, "moneyTransactionCreate");
    const transaction = result.transaction || {};

    return render(transaction, args.response_format ?? "markdown", () => {
      let body = success(`Recorded an expense of ${args.amount} on ${args.date}.`, [
        ["Transaction ID", `\`${transaction.id}\``],
        ["Category", `${match.account.name} (matched ${Math.round(match.score * 100)}%: ${match.why})`],
        ["Paid from", anchor.name],
        ["Description", description],
      ]);
      if (args.vendor_name) {
        body += `\n\nThe vendor '${args.vendor_name}' is recorded in the description; Wave's API cannot link a vendor to a money transaction.`;
      }
      return body;
    });
  }
);

registerWriteTool(
  "wave_create_income_from_payment",
  {
    description:
      "Record income, matching a category word to an income account. A shortcut over wave_create_money_transaction for money received outside the invoicing flow. Naming a customer links the income to them on the line item. To record payment of an existing invoice, use wave_create_invoice_payment instead: this tool creates standalone income and would double-count.",
    inputSchema: {
      amount: z.string().describe(`Amount received. ${DECIMAL_HINT}`),
      date: z.string().describe("Date received, YYYY-MM-DD."),
      income_category: z.string().default("Sales").describe('Category word to match, e.g. "consulting", "rental".'),
      business_id: businessIdSchema,
      customer_name: z.string().optional().describe("Customer who paid. Matched by name and linked if found."),
      payment_description: z.string().optional().describe("What the payment was for."),
      description: z.string().optional().describe("Overrides the generated description."),
      deposit_to_account: z
        .string()
        .optional()
        .describe("Name of the account deposited to. Defaults to the first bank account."),
      notes: z.string().optional().describe("Internal note on the transaction."),
      response_format: responseFormatSchema,
    },
  },
  async (args) => {
    const resolved = requireBusinessId(args.business_id);
    const category = args.income_category ?? "Sales";
    const incomeAccounts = await activeAccounts(resolved, ["INCOME"]);
    const match = matchAccount(category, incomeAccounts, INCOME_SYNONYMS, "income");
    const anchor = await resolvePaymentAccount(resolved, args.deposit_to_account, "deposit into");

    let customerId;
    let customerNote = "";
    if (args.customer_name) {
      const found = await walkPages(
        Q_LIST_CUSTOMERS,
        { businessId: resolved, sort: ["NAME_ASC"] },
        ["business", "customers"],
        { pageSize: MAX_PAGE_SIZE, fetchAll: true }
      );
      const needle = args.customer_name.toLowerCase().trim();
      const customer =
        found.items.find((c) => (c.name || "").toLowerCase() === needle) ??
        found.items.find((c) => (c.name || "").toLowerCase().includes(needle));
      if (customer) {
        customerId = customer.id;
        customerNote = customer.name;
      } else {
        customerNote = `'${args.customer_name}' not found, so the income is not linked to a customer. Create them with wave_create_customer.`;
      }
    }

    const lineItem = compact({
      accountId: match.account.id,
      amount: String(args.amount),
      balance: "INCREASE",
      customerId,
    });
    const description = args.description ?? args.payment_description ?? `Income - ${category}`;
    const id = externalId("wave-mcp-income", null);
    const input = compact({
      businessId: resolved,
      externalId: id,
      date: args.date,
      description,
      notes: args.notes,
      anchor: { accountId: anchor.id, amount: String(args.amount), direction: "DEPOSIT" },
      lineItems: [lineItem],
    });
    const result = await waveMutate(M_CREATE_TRANSACTION, { input }, "moneyTransactionCreate");
    const transaction = result.transaction || {};

    return render(transaction, args.response_format ?? "markdown", () =>
      success(`Recorded income of ${args.amount} on ${args.date}.`, [
        ["Transaction ID", `\`${transaction.id}\``],
        ["Category", `${match.account.name} (matched ${Math.round(match.score * 100)}%: ${match.why})`],
        ["Deposited to", anchor.name],
        ["Customer", customerNote || null],
        ["Description", description],
      ])
    );
  }
);

// --- Resources ---
// Read-only JSON views for grounding context. Everything here is also
// reachable through a tool, so hosts that ignore resources (Codex) lose
// nothing.

function registerResource(uri, name, description, loader) {
  server.registerResource(
    name,
    uri,
    { title: name, description, mimeType: "application/json" },
    async () => ({ contents: [{ uri, mimeType: "application/json", text: await loader() }] })
  );
}

registerResource(
  "wave://businesses",
  "Wave businesses",
  "Every Wave business this access token can reach, with IDs and currencies.",
  async () => {
    const result = await walkPages(Q_LIST_BUSINESSES, {}, ["businesses"], {
      pageSize: MAX_PAGE_SIZE,
      fetchAll: true,
    });
    return jsonText(result.items);
  }
);

registerResource(
  "wave://accounts",
  "Chart of accounts",
  "The default business's chart of accounts, with types, subtypes, and balances.",
  async () => jsonText(await activeAccounts(requireBusinessId(), undefined))
);

registerResource(
  "wave://customers",
  "Customers",
  "The default business's customers, with outstanding and overdue balances.",
  async () => {
    const result = await walkPages(
      Q_LIST_CUSTOMERS,
      { businessId: requireBusinessId(), sort: ["NAME_ASC"] },
      ["business", "customers"],
      { pageSize: MAX_PAGE_SIZE, fetchAll: true }
    );
    return jsonText(result.items);
  }
);

registerResource(
  "wave://vendors",
  "Vendors",
  "The default business's vendors. Read-only: Wave's API has no vendor mutations.",
  async () => {
    const result = await walkPages(Q_LIST_VENDORS, { businessId: requireBusinessId() }, ["business", "vendors"], {
      pageSize: MAX_PAGE_SIZE,
      fetchAll: true,
    });
    return jsonText(result.items);
  }
);

registerResource(
  "wave://products",
  "Products and services",
  "The default business's products. Invoice and estimate line items must reference one.",
  async () => {
    const result = await walkPages(
      Q_LIST_PRODUCTS,
      { businessId: requireBusinessId(), sort: ["NAME_ASC"] },
      ["business", "products"],
      { pageSize: MAX_PAGE_SIZE, fetchAll: true }
    );
    return jsonText(result.items);
  }
);

registerResource(
  "wave://sales-taxes",
  "Sales taxes",
  "The default business's sales taxes, with current rates and rate history.",
  async () => {
    const result = await walkPages(Q_LIST_SALES_TAXES, { businessId: requireBusinessId() }, ["business", "salesTaxes"], {
      pageSize: MAX_PAGE_SIZE,
      fetchAll: true,
    });
    return jsonText(result.items);
  }
);

registerResource(
  "wave://account-taxonomy",
  "Account type taxonomy",
  "Wave's account types and subtypes -- the vocabulary wave_create_account expects.",
  async () => {
    const types = await waveFetch(Q_ACCOUNT_TYPES);
    const subtypes = await waveFetch(Q_ACCOUNT_SUBTYPES);
    return jsonText({
      accountTypes: types.accountTypes || [],
      accountSubtypes: subtypes.accountSubtypes || [],
    });
  }
);

// Health check resource for observability. Probes Wave live on every read, so
// a degraded API shows up immediately.
registerResource(
  "wave://health",
  "Health check",
  "Server health status: live Wave API connectivity and current configuration.",
  async () => {
    let apiStatus = "healthy";
    let apiError = null;
    try {
      await waveFetch(Q_USER);
    } catch (error) {
      apiStatus = "degraded";
      apiError = sanitizeErrorMessage(error.message);
    }
    return jsonText({
      status: apiStatus,
      apiError,
      version: SERVER_VERSION,
      // process is absent under Cloudflare Workers, where uptime is meaningless.
      uptimeSeconds: globalThis.process?.uptime ? Math.floor(globalThis.process.uptime()) : null,
      writesEnabled: writesAllowed(),
      hasCredentials: !!ACCESS_TOKEN,
      defaultBusinessId: sessionBusinessId || null,
      timestamp: new Date().toISOString(),
    });
  }
);

  return {
    server,
    // What is actually exposed over MCP right now.
    listTools: () => [...registeredTools],
    // Every write tool the server knows, whether or not it is currently gated.
    listWriteTools: () => [...toolCatalog.entries()].filter(([, t]) => t.isWrite).map(([name]) => name),
    listHiddenTools: () => [...toolCatalog.keys()].filter((name) => !registeredTools.has(name)),
    toolConfig: (name) => toolCatalog.get(name)?.config,
    writesEnabled: writesAllowed,
    // Pure helpers, exposed so the unit tests can exercise input validation
    // and formatting without standing up a transport or touching Wave.
    __internals: {
      normalizeLineItems,
      stripEstimateItemTaxes,
      normalizeDiscounts,
      normalizeRecipients,
      normalizeTransactionLineItems,
      assertBalanced,
      optionalAddress,
      optionalShipping,
      compact,
      stripUndefined,
      money,
      addressLine,
      table,
      kvBlock,
      listing,
      paginationFooter,
      externalId,
      similarity,
      scoreAccount,
      matchAccount,
      humanizeToolName,
      sanitizeErrorMessage,
      assertWaveApiUrl,
      requireBusinessId,
      waveFetch,
      walkPages,
      EXPENSE_SYNONYMS,
      INCOME_SYNONYMS,
      WaveError,
      WaveAuthError,
      WaveConfigError,
      WaveMutationError,
      WaveValidationError,
      WaveRateLimitError,
      WaveNotFoundError,
      WaveTimeoutError,
      WaveServerError,
      WaveNetworkError,
    },
  };
}

// --- Default stdio instance ---

const localWave = IS_CLOUDFLARE_WORKERS
  ? null
  : createWaveServer({
      getAccessToken: async () => ACCESS_TOKEN ?? null,
      hasCredentials: !!ACCESS_TOKEN,
      defaultBusinessId: DEFAULT_BUSINESS_ID,
      writesEnabled: truthyFlag(runtimeConfig.values.WAVE_ALLOW_WRITES?.value),
      runtime: runtimeConfig,
    });

// --- Exports (Worker and unit tests) ---

export const __testables = {
  FRAGMENTS,
  GRAPHQL_DOCUMENTS,
  gql,
  envNumber,
  truthyFlag,
  extractFromCodexToml,
  extractFromJsonMcpConfig,
  pickRuntimeKeys,
  isDirectRun,
  redactTokens,
  generateTraceId,
  makeLogger,
  // The Wave*Error classes are scoped to createWaveServer and are exposed on
  // its returned `internals`, not here.
};

// --- Start ---

async function main() {
  if (!localWave) return;
  await localWave.server.connect(new StdioServerTransport());
}

/**
 * Was this module executed directly, rather than imported?
 *
 * Importing must not open a stdio transport, which rules out starting
 * unconditionally. But comparing `import.meta.url` to a raw `process.argv[1]`
 * is wrong in the case that matters most: npm installs the bin as a *relative
 * symlink* (`node_modules/.bin/mcp-server-for-wave`), so argv[1] is neither
 * absolute nor the real file, and every npx launch would silently fail to
 * start. Resolve both sides to a real absolute path before comparing.
 */
function isDirectRun() {
  if (IS_CLOUDFLARE_WORKERS) return false;
  if (truthyFlag(globalThis.process?.env?.WAVE_MCP_NO_AUTOSTART)) return false;

  const invoked = globalThis.process?.argv?.[1];
  if (!invoked) return false;

  try {
    return realpathSync(path.resolve(invoked)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A missing or unreadable argv[1] means this was not a direct run.
    return false;
  }
}

if (!IS_CLOUDFLARE_WORKERS) {
  // Without these, an unhandled rejection takes the process down with no
  // usable output, and the MCP client reports only a dead server. Sanitize
  // first: a stack can carry the access token.
  globalThis.process.on("uncaughtException", (error) => {
    console.error(`Uncaught exception: ${redactTokens(error?.stack || error)}`);
    globalThis.process.exit(1);
  });

  globalThis.process.on("unhandledRejection", (reason) => {
    console.error(`Unhandled promise rejection: ${redactTokens(reason?.stack || reason)}`);
    globalThis.process.exit(1);
  });
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(`Fatal error starting MCP Server for Wave: ${redactTokens(error?.message ?? error)}`);
    globalThis.process.exit(1);
  });
}
