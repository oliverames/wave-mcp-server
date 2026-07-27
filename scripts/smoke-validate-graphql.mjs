#!/usr/bin/env node

/**
 * Schema-check every GraphQL document against the live Wave API.
 *
 * Wave validates a document and coerces its variables *before* it checks
 * authentication, so an unauthenticated request tells the two apart:
 *
 *   UNAUTHENTICATED            -> document and variables are valid
 *   GRAPHQL_VALIDATION_FAILED  -> the document is wrong
 *   BAD_USER_INPUT             -> a variable is the wrong type
 *
 * That makes the whole surface verifiable in CI with no credentials. Variables
 * are synthesized from Wave's own introspected schema, so every required input
 * field gets a type-correct placeholder.
 */

import process from "node:process";

const ENDPOINT = "https://gql.waveapps.com/graphql/public";
const REQUEST_SPACING_MS = 120; // stay well clear of Wave's rate limit

const INTROSPECTION = `
query IntrospectionQuery {
  __schema {
    types {
      kind
      name
      inputFields { name type { ...TypeRef } }
      enumValues(includeDeprecated: true) { name }
    }
  }
}
fragment TypeRef on __Type {
  kind
  name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
}`;

const SCALAR_SAMPLES = {
  ID: "1",
  String: "x",
  Int: 1,
  Float: 1.0,
  Boolean: true,
  Decimal: "1.00",
  Date: "2026-01-01",
  DateTime: "2026-01-01T00:00:00Z",
  URL: "https://example.com",
  JSON: {},
  HexColorCode: "#000000",
};

async function post(body) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function loadSchema() {
  const result = await post({ query: INTROSPECTION });
  if (result.errors) {
    throw new Error(`Introspection failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  return new Map(result.data.__schema.types.map((t) => [t.name, t]));
}

/** Parse a variable type from a GraphQL document header, e.g. "[InvoiceSort!]!". */
function parseType(text) {
  const trimmed = text.trim();
  if (trimmed.endsWith("!")) return { kind: "NON_NULL", ofType: parseType(trimmed.slice(0, -1)) };
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return { kind: "LIST", ofType: parseType(trimmed.slice(1, -1)) };
  }
  return { kind: "NAMED", name: trimmed };
}

function sampleFor(types, typeRef, depth = 0) {
  if (typeRef.kind === "NON_NULL") return sampleFor(types, typeRef.ofType, depth);
  if (typeRef.kind === "LIST") return [sampleFor(types, typeRef.ofType, depth + 1)];

  const definition = types.get(typeRef.name);
  if (definition?.kind === "ENUM") return definition.enumValues[0].name;
  if (definition?.kind === "INPUT_OBJECT") {
    if (depth > 6) return {};
    const value = {};
    for (const field of definition.inputFields ?? []) {
      // Only required fields, to keep payloads minimal and unambiguous.
      if (field.type.kind === "NON_NULL") value[field.name] = sampleFor(types, field.type, depth + 1);
    }
    return value;
  }
  return SCALAR_SAMPLES[typeRef.name] ?? "x";
}

function variablesFor(types, document) {
  const header = document.split("{")[0];
  const variables = {};
  for (const match of header.matchAll(/\$(\w+)\s*:\s*([[\]\w!]+)/g)) {
    variables[match[1]] = sampleFor(types, parseType(match[2]));
  }
  return variables;
}

function operationName(document) {
  return document.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1] ?? "(anonymous)";
}

async function main() {
  // Importing the server registers every document as a side effect.
  process.env.WAVE_MCP_NO_AUTOSTART = "1";
  process.env.WAVE_DISABLE_AGENT_CONFIG_FALLBACK = "1";
  const module = await import("../index.js");
  module.createWaveServer({ getAccessToken: async () => null, hasCredentials: false, writesEnabled: true });

  // The factory runs once at import for the stdio instance and once above, so
  // the registry holds duplicates.
  const documents = [...new Set(module.__testables.GRAPHQL_DOCUMENTS)];
  console.log(`Validating ${documents.length} GraphQL documents against ${ENDPOINT}\n`);

  const types = await loadSchema();
  const failures = [];

  for (const document of documents) {
    const name = operationName(document);
    const variables = variablesFor(types, document);
    let body;
    try {
      body = await post({ query: document, variables });
    } catch (error) {
      console.log(`  ERROR   ${name}: ${error.message}`);
      failures.push({ name, detail: error.message });
      continue;
    }

    const errors = body.errors ?? [];
    const codes = new Set(errors.map((e) => e?.extensions?.code).filter(Boolean));
    const onlyAuth = errors.length === 0 || (codes.size === 1 && codes.has("UNAUTHENTICATED"));

    if (onlyAuth) {
      console.log(`  ok      ${name}`);
    } else {
      const detail = `${[...codes].join(",")} ${errors.map((e) => e.message).join("; ")}`;
      console.log(`  FAIL    ${name}\n            ${detail}`);
      failures.push({ name, detail });
    }
    await new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS));
  }

  console.log(`\n${documents.length - failures.length}/${documents.length} documents valid`);
  if (failures.length) {
    console.error("\nFailures:");
    for (const failure of failures) console.error(`  ${failure.name}: ${failure.detail}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
