const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const SCOPE_TEXT: Record<string, string> = {
  read_prefs: "read your OSM preferences",
  write_prefs: "change your OSM preferences",
  write_api: "edit the map as you",
  write_changeset_comments: "comment on changesets as you",
  write_notes: "create and comment on map notes as you",
  read_gpx: "read your private GPS traces",
  write_gpx: "upload and change your GPS traces",
  write_diary: "write diary entries as you",
};

const shell = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1f2328}h1{font-size:1.3rem}code{background:#eef;padding:.1rem .3rem;border-radius:3px}
.card{border:1px solid #d1d9e0;border-radius:8px;padding:1.2rem}ul{padding-left:1.2rem}.row{display:flex;gap:.6rem;margin-top:1.2rem}button{font:inherit;padding:.5rem 1rem;border-radius:6px;border:1px solid #d1d9e0;cursor:pointer}
button.primary{background:#1a7f37;color:#fff;border-color:#1a7f37}.warn{color:#8a4600;font-size:.9rem}</style></head><body>${body}</body></html>`;

export function consentPage(o: { txnId: string; clientName: string; redirectOrigin: string; scopes: string[]; serverUrl: string }): string {
  const items = o.scopes.map((s) => `<li>${esc(SCOPE_TEXT[s] ?? s)} <code>${esc(s)}</code></li>`).join("");
  return shell(
    "Authorize OpenStreetMap MCP",
    `<h1>Authorize access to OpenStreetMap</h1><div class="card">
<p><strong>${esc(o.clientName)}</strong> wants to connect to the OpenStreetMap MCP server at <code>${esc(o.serverUrl)}</code> and use your OSM account.</p>
<p class="warn">The application name is chosen by the application itself. After approval it will return to <code>${esc(o.redirectOrigin)}</code>.</p>
<p>Next you will sign in to OpenStreetMap, which will ask to let this server:</p><ul>${items}</ul>
<p>Edits made through it are public and attributed to your account.</p>
<form method="post" action="/authorize/consent"><input type="hidden" name="txn" value="${esc(o.txnId)}">
<div class="row"><button class="primary" name="action" value="approve">Continue to OpenStreetMap</button><button name="action" value="deny">Cancel</button></div></form></div>`,
  );
}

export function errorPage(message: string): string {
  return shell("Authorization error", `<h1>Authorization error</h1><div class="card"><p>${esc(message)}</p><p>Close this tab and start again from your MCP client.</p></div>`);
}
