#!/usr/bin/env node

/**
 * Pack the package, install it, and start it through its bin symlink.
 *
 * This exists because of a bug that every other check missed. npm installs the
 * bin as a *relative symlink* (`node_modules/.bin/mcp-server-for-wave`), so
 * `process.argv[1]` is neither absolute nor the real file. An autostart guard
 * comparing `import.meta.url` to a raw argv[1] therefore never matched, and
 * the server silently did nothing under `npx` -- the way essentially every
 * user launches it. Running `node index.js` directly, as the other smoke test
 * does, works fine and hides it completely.
 *
 * So: exercise the artifact the way a user gets it, not the way a developer
 * runs it.
 */

import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wave-mcp-packed-"));
const STARTUP_BUDGET_MS = 15000;

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

let failed = false;

try {
  console.log(`Packing into ${workDir} ...`);
  const packOutput = run("npm", ["pack", "--silent", "--pack-destination", workDir], { cwd: projectRoot });
  const tarball = path.join(workDir, packOutput.trim().split("\n").pop().trim());
  if (!fs.existsSync(tarball)) throw new Error(`npm pack did not produce ${tarball}`);
  console.log(`Packed ${path.basename(tarball)}`);

  fs.writeFileSync(path.join(workDir, "package.json"), JSON.stringify({ name: "packed-smoke", private: true }, null, 2));
  console.log("Installing the tarball ...");
  run("npm", ["install", "--silent", "--no-audit", "--no-fund", tarball], { cwd: workDir });

  // Both bin names the package declares must work.
  for (const binName of ["mcp-server-for-wave", "wave-mcp-server"]) {
    const binPath = path.join(workDir, "node_modules", ".bin", binName);
    if (!fs.existsSync(binPath)) throw new Error(`bin ${binName} was not installed`);
    const stat = fs.lstatSync(binPath);
    console.log(`\n${binName}: ${stat.isSymbolicLink() ? "symlink" : "file"}`);
    await probeBin(workDir, binName);
  }

  console.log("\nPacked install starts and responds over stdio.");
} catch (error) {
  console.error(`\nFAILED: ${error.message}`);
  failed = true;
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);

/** Launch the installed bin the way a client would, and complete a handshake. */
async function probeBin(cwd, binName) {
  // Deliberately relative, matching how npm and npx invoke it.
  const relativeBin = path.join("node_modules", ".bin", binName);

  const child = spawn(process.execPath, [relativeBin], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      WAVE_ACCESS_TOKEN: "packed-smoke-token",
      WAVE_DISABLE_AGENT_CONFIG_FALLBACK: "1",
      WAVE_ALLOW_WRITES: "1",
      // Must NOT be set: this test is precisely about autostart working.
      WAVE_MCP_NO_AUTOSTART: "",
    },
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
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
      setTimeout(
        () =>
          reject(
            new Error(
              `${binName}: ${method} produced no response within ${STARTUP_BUDGET_MS}ms. ` +
                `The bin likely did not autostart. stderr: ${stderr.trim() || "(empty)"}`
            )
          ),
        STARTUP_BUDGET_MS
      );
    });

  try {
    const init = await send(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "packed-smoke", version: "1" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tools = (await send(2, "tools/list")).result.tools;

    console.log(`  serverInfo: ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);
    console.log(`  tools:      ${tools.length}`);
    if (tools.length === 0) throw new Error(`${binName} advertised no tools`);
  } finally {
    child.stdin.end();
    child.kill();
  }
}
