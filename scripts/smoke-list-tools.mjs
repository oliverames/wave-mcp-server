#!/usr/bin/env node

/**
 * Launch the server over stdio exactly as an MCP client would, and report what
 * it advertises.
 *
 * This is the check that "the module imports" cannot make: it proves the
 * process starts, speaks JSON-RPC on stdout, and enumerates its tools and
 * resources. It needs no Wave credentials.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entryPoint = path.join(projectRoot, "index.js");

// Codex CLI kills a server that has not completed initialize in this long.
const CODEX_STARTUP_BUDGET_MS = 10000;

async function probe({ allowWrites }) {
  const child = spawn(process.execPath, [entryPoint], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "ignore"],
    env: {
      ...process.env,
      WAVE_ACCESS_TOKEN: process.env.WAVE_ACCESS_TOKEN || "smoke-test-token",
      WAVE_ALLOW_WRITES: allowWrites ? "1" : "",
      // Read only what this probe sets, not the developer's real agent config.
      WAVE_DISABLE_AGENT_CONFIG_FALLBACK: "1",
    },
  });

  let buffer = "";
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  const send = (id, method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => reject(new Error(`${method} timed out`)), CODEX_STARTUP_BUDGET_MS);
    });

  const started = Date.now();
  const init = await send(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-list-tools", version: "1" },
  });
  const startupMs = Date.now() - started;

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const tools = (await send(2, "tools/list")).result.tools;
  const resources = (await send(3, "resources/list")).result.resources;

  child.stdin.end();
  child.kill();

  return { init: init.result, tools, resources, startupMs };
}

const readOnly = await probe({ allowWrites: false });
const readWrite = await probe({ allowWrites: true });

console.log(`server:       ${readOnly.init.serverInfo.name} v${readOnly.init.serverInfo.version}`);
console.log(`instructions: ${readOnly.init.instructions ? "present" : "MISSING"}`);
console.log(`startup:      ${readOnly.startupMs}ms (Codex allows ${CODEX_STARTUP_BUDGET_MS}ms)`);
console.log(`resources:    ${readOnly.resources.length}`);
console.log(`tools:        ${readOnly.tools.length} read-only, ${readWrite.tools.length} with WAVE_ALLOW_WRITES=1`);

const problems = [];
if (!readOnly.init.instructions) problems.push("initialize returned no instructions field (Codex reads it)");
if (readOnly.startupMs > CODEX_STARTUP_BUDGET_MS) problems.push(`startup ${readOnly.startupMs}ms exceeds Codex's budget`);
if (readWrite.tools.length <= readOnly.tools.length) problems.push("WAVE_ALLOW_WRITES did not register any extra tools");

// Nothing that changes or sends data may appear without the opt-in.
const readOnlyNames = new Set(readOnly.tools.map((t) => t.name));
for (const gated of ["wave_delete_invoice", "wave_send_invoice", "wave_delete_customer", "wave_create_invoice"]) {
  if (readOnlyNames.has(gated)) problems.push(`${gated} is registered without WAVE_ALLOW_WRITES`);
}

for (const tool of readWrite.tools) {
  if (!tool.name.startsWith("wave_")) problems.push(`${tool.name} lacks the wave_ prefix`);
  if (!tool.description) problems.push(`${tool.name} has no description`);
  if (!tool.annotations?.title) problems.push(`${tool.name} has no annotation title`);
}

if (problems.length) {
  console.error("\nProblems:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("\nAll checks passed.");
