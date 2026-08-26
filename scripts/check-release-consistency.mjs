#!/usr/bin/env node

/**
 * Fail the build when anything about a release disagrees with package.json.
 *
 * Version strings live in eight files across five hosts plus the server
 * handshake. Catching drift here is cheaper than shipping a plugin manifest
 * that advertises a version npm never published.
 *
 * Pass --registry to additionally check whether this version is already on
 * npm, which prevents a duplicate publish.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = readJson("package.json");
const { version, name: packageName } = packageJson;
const pluginName = "wave-mcp-server";

const problems = [];

// 1. Plugin manifests carry the package version.
for (const manifestPath of [
  ".claude-plugin/plugin.json",
  "codex/.codex-plugin/plugin.json",
  ".hermes-plugin/plugin.json",
  ".antigravity-plugin/plugin.json",
]) {
  const manifest = readJson(manifestPath);
  if (manifest.version !== version) {
    problems.push(`${manifestPath}: version ${manifest.version} != package.json ${version}`);
  }
}

// 2. Marketplace entries carry the package version.
for (const marketplacePath of [
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  ".hermes-plugin/marketplace.json",
  ".antigravity-plugin/marketplace.json",
]) {
  const marketplace = readJson(marketplacePath);
  const plugin = (marketplace.plugins ?? []).find((p) => p.name === pluginName);
  if (!plugin) {
    problems.push(`${marketplacePath}: no plugin entry named ${pluginName}`);
  } else if (plugin.version !== version) {
    problems.push(`${marketplacePath}: plugin version ${plugin.version} != package.json ${version}`);
  }
}

// 3. MCP configs install the right package.
for (const mcpConfigPath of [
  ".mcp.json",
  "codex/.codex-plugin/mcp.json",
  ".hermes-plugin/mcp.json",
  ".antigravity-plugin/mcp_config.json",
]) {
  const config = readJson(mcpConfigPath);
  const server = config.mcpServers?.[pluginName] ?? config[pluginName];
  if (!server) {
    problems.push(`${mcpConfigPath}: no server entry named ${pluginName}`);
    continue;
  }
  const target = (server.args ?? []).find((arg) => typeof arg === "string" && arg.startsWith("@oliverames/"));
  if (target !== `${packageName}@latest`) {
    problems.push(`${mcpConfigPath}: installs ${target}, expected ${packageName}@latest`);
  }
}

// 4. The handshake version matches the package.
const source = fs.readFileSync(path.join(projectRoot, "index.js"), "utf8");
const declared = source.match(/const SERVER_VERSION = "([^"]*)";/)?.[1];
if (declared !== version) {
  problems.push(`index.js: SERVER_VERSION ${declared} != package.json ${version}`);
}

// 5. The hosted connector's handshake version matches too.
const brandAssets = fs.readFileSync(path.join(projectRoot, "worker", "src", "brand-assets.js"), "utf8");
const remoteVersion = brandAssets.match(/REMOTE_SERVER_INFO = \{\s*name: "wave_mcp",\s*version: "([^"]*)"/)?.[1];
if (remoteVersion !== version) {
  problems.push(`worker/src/brand-assets.js: REMOTE_SERVER_INFO version ${remoteVersion} != package.json ${version}`);
}

// 6. Files listed for publish actually exist.
for (const entry of packageJson.files ?? []) {
  const target = path.join(projectRoot, entry.replace(/\/$/, ""));
  if (!fs.existsSync(target)) {
    problems.push(`package.json files: "${entry}" does not exist`);
  }
}

if (problems.length) {
  console.error("Release consistency check failed:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nRun `npm run sync:plugin` to propagate the version, then re-check.");
  process.exit(1);
}

console.log(`Release consistency OK for ${packageName}@${version}.`);

if (process.argv.includes("--registry")) {
  await checkRegistry();
}

async function checkRegistry() {
  const url = `https://registry.npmjs.org/${packageName.replace("/", "%2F")}`;
  let published;
  try {
    const response = await fetch(url);
    if (response.status === 404) {
      console.log(`${packageName} is not on npm yet; ${version} would be the first publish.`);
      return;
    }
    published = await response.json();
  } catch (error) {
    console.error(`Could not reach the npm registry: ${error.message}`);
    process.exit(1);
  }

  const versions = Object.keys(published.versions ?? {});
  if (versions.includes(version)) {
    console.error(`${packageName}@${version} is already published. Bump the version before releasing.`);
    process.exit(1);
  }
  console.log(`${packageName}@${version} is not yet published (latest is ${published["dist-tags"]?.latest ?? "none"}).`);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf8"));
}
