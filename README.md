# OpenStreetMap MCP

[![CI](https://github.com/sohampatwardhan/OpenStreetMap-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/sohampatwardhan/OpenStreetMap-MCP/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/openstreetmap-mcp)](https://www.npmjs.com/package/openstreetmap-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI assistants **read and edit OpenStreetMap** through the [OSM API v0.6](https://wiki.openstreetmap.org/wiki/API_v0.6), authenticating with **OAuth 2.0** (authorization code + PKCE).

> ⚠️ Edits are public, permanent and attributed to your OSM account. Practise on the [sandbox server](https://master.apis.dev.openstreetmap.org) (`OSM_ENV=dev`) and follow the [OSM editing guidelines](https://wiki.openstreetmap.org/wiki/Editing_Standards_%26_Conventions). Don't run bulk or automated edits without following the [automated edits code of conduct](https://wiki.openstreetmap.org/wiki/Automated_Edits_code_of_conduct).

## Quick start

Reading works with no setup. Editing needs an OAuth app.

### 1. Register an OAuth 2 application (for editing)
On [openstreetmap.org/oauth2/applications](https://www.openstreetmap.org/oauth2/applications) (or the sandbox) create an app:
- **Redirect URI:** `http://127.0.0.1:8787/callback`
- **Confidential application:** leave **unchecked** (public client using PKCE, no secret needed)
- **Permissions:** `read_prefs`, `write_api`, `write_notes` (add others if you set `OSM_SCOPES`)

Copy the **Client ID**.

### 2. Add to your MCP client

```json
{
  "mcpServers": {
    "openstreetmap": {
      "command": "npx",
      "args": ["-y", "openstreetmap-mcp"],
      "env": { "OSM_CLIENT_ID": "<your client id>" }
    }
  }
}
```

Claude Code: `claude mcp add openstreetmap -e OSM_CLIENT_ID=<id> -- npx -y openstreetmap-mcp`

### 3. Log in
Ask the assistant to call `osm_login`. It returns a URL; open it, approve, and the token is stored in `~/.config/openstreetmap-mcp/` (mode 0600). Confirm with `osm_whoami`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OSM_CLIENT_ID` | – | OAuth 2 client ID (needed for `osm_login`) |
| `OSM_CLIENT_SECRET` | – | Only for confidential apps |
| `OSM_ACCESS_TOKEN` | – | Use a pre-made token instead of the login flow |
| `OSM_ENV` | `production` | `dev` targets `master.apis.dev.openstreetmap.org` |
| `OSM_SCOPES` | `read_prefs write_api write_notes` | Space/comma separated OAuth scopes |
| `OSM_REDIRECT_PORT` | `8787` | Loopback port; must match the registered redirect URI |
| `OSM_API_BASE` / `OSM_WEB_BASE` | per env | Override hosts |
| `OSM_USER_AGENT` | `openstreetmap-mcp/…` | Sent on every request (OSM requires one) |
| `OSM_CONFIG_DIR` | `~/.config/openstreetmap-mcp` | Token storage |

## Tools

**Auth:** `osm_login`, `osm_logout`, `osm_whoami`

**Read (no login needed):** `osm_capabilities`, `osm_get_element`, `osm_get_elements`, `osm_get_element_full`, `osm_element_history`, `osm_element_parents`, `osm_get_bbox`, `osm_get_changeset`, `osm_get_changeset_diff`, `osm_search_changesets`, `osm_get_user`

**Edit (login required):** `osm_create_changeset`, `osm_update_changeset_tags`, `osm_close_changeset`, `osm_comment_changeset`, `osm_create_element`, `osm_update_element`, `osm_delete_element`, `osm_upload_diff`

**Map notes:** read — `osm_get_notes_in_bbox`, `osm_search_notes`, `osm_get_note`; write — `osm_create_note`, `osm_comment_note`, `osm_close_note`, `osm_reopen_note`

### Typical edit flow
`osm_login` → `osm_create_changeset` → `osm_get_element` (current version) → `osm_update_element` (full replace, so send all tags) → `osm_close_changeset`.
For many related changes use `osm_upload_diff`, which applies creates/modifies/deletes atomically and lets new elements reference each other via negative ids.

## Development

```bash
npm install
npm run typecheck && npm test
npm run dev        # stdio server from source
```
See [AGENTS.md](AGENTS.md) for architecture and workflow, and [CONTRIBUTING.md](CONTRIBUTING.md). Work is tracked in [GitHub issues](https://github.com/sohampatwardhan/OpenStreetMap-MCP/issues).

## License
[MIT](LICENSE). OpenStreetMap data is © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright).
