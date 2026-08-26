#!/usr/bin/env node

/**
 * Propagate package.json's version and package name into every plugin manifest.
 *
 * Five hosts each want their own manifest, so a hand-bumped release drifts
 * almost immediately. `npm version` runs this and stages the results.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = readJson("package.json");
const { version, name: packageName } = packageJson;

const pluginName = "wave-mcp-server";
const packageInstallTarget = `${packageName}@latest`;

const pluginManifestPaths = [
  ".claude-plugin/plugin.json",
  "codex/.codex-plugin/plugin.json",
  ".hermes-plugin/plugin.json",
  ".antigravity-plugin/plugin.json",
];

const marketplacePaths = [
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  ".hermes-plugin/marketplace.json",
  ".antigravity-plugin/marketplace.json",
];

const mcpConfigPaths = [
  ".mcp.json",
  "codex/.codex-plugin/mcp.json",
  ".hermes-plugin/mcp.json",
  ".antigravity-plugin/mcp_config.json",
];

for (const manifestPath of pluginManifestPaths) {
  updateJson(manifestPath, (data) => {
    data.version = version;
  });
}

for (const marketplacePath of marketplacePaths) {
  updateJson(marketplacePath, (data) => {
    for (const plugin of data.plugins ?? []) {
      if (plugin.name === pluginName) plugin.version = version;
    }
  });
}

for (const mcpConfigPath of mcpConfigPaths) {
  updateJson(mcpConfigPath, (data) => {
    setPackageInstallTarget(findMcpServer(data));
  });
}

// The server version reported in the MCP handshake must match the package, or
// clients advertise a version that was never released.
updateSourceVersion();

console.log(`Synced plugin metadata to version ${version}.`);

function findMcpServer(data) {
  return data.mcpServers?.[pluginName] ?? data[pluginName];
}

function setPackageInstallTarget(server) {
  if (!server || !Array.isArray(server.args)) return;
  const index = server.args.findIndex((arg) => typeof arg === "string" && /^@oliverames\/.+@latest$/.test(arg));
  if (index >= 0) server.args[index] = packageInstallTarget;
}

function updateSourceVersion() {
  const indexPath = path.join(projectRoot, "index.js");
  const source = fs.readFileSync(indexPath, "utf8");
  const updated = source.replace(/const SERVER_VERSION = "[^"]*";/, `const SERVER_VERSION = "${version}";`);
  if (updated !== source) fs.writeFileSync(indexPath, updated);

  // The hosted connector reports its own serverInfo during the MCP handshake;
  // a stale value makes clients advertise a version that was never released.
  const brandAssetsPath = path.join(projectRoot, "worker", "src", "brand-assets.js");
  const brandAssets = fs.readFileSync(brandAssetsPath, "utf8");
  const updatedBrandAssets = brandAssets.replace(
    /(export const REMOTE_SERVER_INFO = \{\s*name: "wave_mcp",\s*version: ")[^"]*(")/,
    `$1${version}$2`
  );
  if (updatedBrandAssets === brandAssets) {
    throw new Error(`Could not update REMOTE_SERVER_INFO in ${brandAssetsPath}; expected its version literal.`);
  }
  fs.writeFileSync(brandAssetsPath, updatedBrandAssets);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

function updateJson(relativePath, update) {
  const fullPath = path.join(projectRoot, relativePath);
  const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  update(data);
  fs.writeFileSync(fullPath, `${JSON.stringify(data, null, 2)}\n`);
}
