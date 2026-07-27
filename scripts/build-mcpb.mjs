#!/usr/bin/env node

/**
 * Build an MCPB bundle: a single .mcpb file a desktop MCP host can install
 * without npm or a terminal.
 *
 * The bundle is a zip carrying a manifest, the server, and its production
 * dependencies. User configuration (the Wave token, the default business,
 * the write opt-in) is declared in the manifest so the host can prompt for it
 * and inject the values at launch, which keeps credentials out of the bundle.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(projectRoot, "dist");
const stageDir = path.join(distDir, "mcpb-stage");

const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const { version } = packageJson;
const outputPath = path.join(distDir, `wave-mcp-server-${version}.mcpb`);

const manifest = {
  manifest_version: "0.2",
  name: "wave-mcp-server",
  display_name: "Wave",
  version,
  description: packageJson.description,
  long_description:
    "Covers Wave Accounting's public GraphQL API in full: invoices and payments, estimates and deposits, " +
    "customers, vendors, products, sales taxes, the chart of accounts, and double-entry bookkeeping " +
    "transactions. Tools that change or send data stay hidden until you enable them.",
  author: { name: "Oliver Ames", email: "oliverames@gmail.com", url: "https://github.com/oliverames" },
  homepage: "https://github.com/oliverames/wave-mcp-server#readme",
  documentation: "https://github.com/oliverames/wave-mcp-server#readme",
  support: "https://github.com/oliverames/wave-mcp-server/issues",
  icon: "icon.png",
  license: "MIT",
  keywords: packageJson.keywords,
  server: {
    type: "node",
    entry_point: "index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/index.js"],
      env: {
        WAVE_ACCESS_TOKEN: "${user_config.access_token}",
        WAVE_BUSINESS_ID: "${user_config.business_id}",
        WAVE_ALLOW_WRITES: "${user_config.allow_writes}",
        // A bundle has no agent config file to read; the host injects values.
        WAVE_DISABLE_AGENT_CONFIG_FALLBACK: "1",
      },
    },
  },
  user_config: {
    access_token: {
      type: "string",
      title: "Wave access token",
      description: "OAuth2 access token from https://developer.waveapps.com/",
      sensitive: true,
      required: true,
    },
    business_id: {
      type: "string",
      title: "Default business ID",
      description: "Optional. Lets tools omit business_id. Find it with wave_list_businesses.",
      required: false,
    },
    allow_writes: {
      type: "string",
      title: "Enable write tools",
      description:
        'Set to 1 to enable tools that create, change, delete, or email records. Left empty, the server is read-only.',
      required: false,
      default: "",
    },
  },
  compatibility: {
    claude_desktop: ">=0.10.0",
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: ">=18.0.0" },
  },
};

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

fs.writeFileSync(path.join(stageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
fs.copyFileSync(path.join(projectRoot, "index.js"), path.join(stageDir, "index.js"));
fs.copyFileSync(path.join(projectRoot, "package.json"), path.join(stageDir, "package.json"));
fs.copyFileSync(path.join(projectRoot, "package-lock.json"), path.join(stageDir, "package-lock.json"));
fs.copyFileSync(path.join(projectRoot, "assets", "icon.png"), path.join(stageDir, "icon.png"));
fs.copyFileSync(path.join(projectRoot, "LICENSE"), path.join(stageDir, "LICENSE"));
fs.copyFileSync(path.join(projectRoot, "README.md"), path.join(stageDir, "README.md"));

// Production dependencies only: a bundle ships what it needs to run, and dev
// tooling would multiply its size for no benefit.
console.log("Installing production dependencies into the bundle...");
run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: stageDir });

fs.rmSync(outputPath, { force: true });
console.log(`Packing ${path.relative(projectRoot, outputPath)}...`);
run("zip", ["-qr", outputPath, "."], { cwd: stageDir });

fs.rmSync(stageDir, { recursive: true, force: true });

const sizeMb = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
console.log(`Built ${path.relative(projectRoot, outputPath)} (${sizeMb} MB)`);

if (!fs.existsSync(outputPath)) {
  console.error("Bundle was not produced.");
  process.exit(1);
}
