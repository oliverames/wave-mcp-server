// Server-rendered pages for the hosted connector.
//
// All content is built here from trusted constants and escaped values; no
// user-supplied string reaches the HTML unescaped.

import { DISCLAIMER } from "./brand-assets.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #16202c; --muted: #5c6b7a; --bg: #f6f8fb; --card: #fff; --accent: #1f6fd0; --line: #dde4ec; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8eef5; --muted: #9fb0c2; --bg: #0f1620; --card: #16202c; --accent: #63a4f0; --line: #26374a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2.5rem 1.25rem; background: var(--bg); color: var(--fg);
         font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 34rem; margin: 0 auto; background: var(--card); border: 1px solid var(--line);
         border-radius: 14px; padding: 2rem; }
  h1 { margin: 0 0 .5rem; font-size: 1.5rem; }
  h2 { font-size: 1.05rem; margin: 1.75rem 0 .5rem; }
  p, li { color: var(--fg); }
  .muted { color: var(--muted); font-size: .9rem; }
  ul { padding-left: 1.15rem; }
  button { background: var(--accent); color: #fff; border: 0; border-radius: 8px;
           padding: .7rem 1.15rem; font-size: 1rem; cursor: pointer; }
  button.secondary { background: transparent; color: var(--muted); border: 1px solid var(--line); }
  label { display: flex; gap: .6rem; align-items: flex-start; margin: 1rem 0; }
  input[type=text] { width: 100%; padding: .6rem .7rem; border: 1px solid var(--line);
                     border-radius: 8px; background: var(--bg); color: var(--fg); }
  code { background: var(--bg); border: 1px solid var(--line); border-radius: 5px; padding: .1rem .35rem; font-size: .85em; }
  footer { max-width: 34rem; margin: 1.25rem auto 0; }
</style>
</head>
<body>
<main>${body}</main>
<footer class="muted">${escapeHtml(DISCLAIMER)}</footer>
</body>
</html>`;
}

export function landingPage(baseUrl) {
  const url = escapeHtml(baseUrl ?? "");
  return `
<h1>Wave MCP connector</h1>
<p>A hosted Model Context Protocol server for Wave Accounting. Add it to an MCP
client that supports remote connectors and authorize it against your own Wave
account.</p>
<h2>Endpoint</h2>
<p><code>${url}/mcp</code></p>
<h2>What it can do</h2>
<ul>
  <li>Read invoices, estimates, customers, vendors, products, sales taxes, and the chart of accounts.</li>
  <li>With write access enabled: create and send invoices and estimates, record payments, and post bookkeeping transactions.</li>
</ul>
<p class="muted">Write access is opt-in during authorization. A read-only
connection requests read scopes only, so it cannot be escalated later.</p>
<p><a href="/privacy">Privacy</a> &middot; <a href="/delete">Delete a connection</a> &middot;
<a href="https://github.com/oliverames/wave-mcp-server#readme">Documentation</a></p>`;
}

export function consentPage({ clientName, payload, signature }) {
  return `
<h1>Connect Wave</h1>
<p><strong>${escapeHtml(clientName)}</strong> is asking to connect to your Wave
Accounting data through this connector.</p>
<form method="post" action="/authorize">
  <input type="hidden" name="payload" value="${escapeHtml(payload)}">
  <input type="hidden" name="signature" value="${escapeHtml(signature)}">
  <h2>Access level</h2>
  <label>
    <input type="checkbox" name="allow_writes" value="1">
    <span>Allow this connection to change data: create and send invoices and
    estimates, record payments, and post transactions. Leave unchecked for
    read-only access.</span>
  </label>
  <p class="muted">Sending an invoice or estimate emails your customer. Only
  enable writes for a client you trust to act on your behalf.</p>
  <p>
    <button type="submit">Continue to Wave</button>
    <button type="submit" class="secondary" formaction="/" formmethod="get">Cancel</button>
  </p>
</form>`;
}

export function privacyPage() {
  return `
<h1>Privacy</h1>
<h2>What is stored</h2>
<ul>
  <li>Your Wave user ID.</li>
  <li>Your Wave OAuth access and refresh tokens, encrypted at the application
      layer before they reach storage.</li>
  <li>Whether you granted write access.</li>
</ul>
<h2>What is not stored</h2>
<ul>
  <li>Your Wave password. This connector never sees it.</li>
  <li>Your accounting data. Invoices, customers, and transactions are fetched
      from Wave for a request and returned to your MCP client; nothing is
      retained afterwards.</li>
  <li>Analytics, tracking, or request logs containing your business data.</li>
</ul>
<h2>Deleting your data</h2>
<p>Use <a href="/delete">delete a connection</a> to remove the stored tokens,
then revoke the application in your Wave account settings.</p>`;
}

export function deletePage(csrf) {
  return `
<h1>Delete a connection</h1>
<p>This removes the stored Wave tokens for one user. Your accounting data in
Wave is untouched.</p>
<p class="muted">Your Wave user ID is shown by the <code>wave_auth_status</code>
tool in any connected client.</p>
<form method="post" action="/delete">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <p><input type="text" name="wave_user_id" placeholder="Wave user ID" required></p>
  <p><button type="submit">Delete stored tokens</button></p>
</form>`;
}

export function messagePage(title, message) {
  return `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">Back</a></p>`;
}
