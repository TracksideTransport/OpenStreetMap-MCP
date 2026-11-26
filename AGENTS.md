# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo. `CLAUDE.md` points here.

## What this is
An MCP server (stdio) that reads and edits OpenStreetMap data through the [OSM API v0.6](https://wiki.openstreetmap.org/wiki/API_v0.6), authenticating with OAuth 2.0 (authorization code + PKCE). TypeScript, ESM, Node >= 20.

## Layout
- `src/index.ts` – stdio entrypoint (bin).
- `src/server.ts` – builds the `McpServer`, registers tool groups.
- `src/config.ts` – env-driven config (`OSM_ENV`, `OSM_CLIENT_ID`, ...).
- `src/auth.ts` – PKCE, loopback listener, token storage/revocation.
- `src/osm.ts` – HTTP client, XML builders/parsers, error mapping.
- `src/tools/{auth,read,edit,notes}.ts` – tool definitions; `util.ts` has shared helpers.
- `test/` – vitest: unit, mock-HTTP client tests, real stdio smoke test.

## Commands
```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # emits dist/
npm run dev         # run server from source over stdio
```
Run typecheck and tests before every commit.

## Conventions
- MCP SDK is `@modelcontextprotocol/server` v2: `server.registerTool(name, { description, inputSchema: z.object(...), annotations }, handler)`, with `zod/v4`. Check the current docs (Context7) before changing SDK usage.
- Reads use the API's `.json` endpoints; writes send XML built in `src/osm.ts`.
- Wrap every handler in `safe()` so failures return `isError` results instead of throwing.
- Never write to stdout (it is the MCP transport); log to stderr only.
- Write tools must set accurate `annotations` (`WRITE` / `DESTRUCTIVE`) and mention that edits are public.
- Tool names are prefixed `osm_`. Adding or renaming a tool: update README and CHANGELOG.
- Never commit tokens. Tokens live in `~/.config/openstreetmap-mcp/`.
- Do not run tests that write to the production OSM API. Use `OSM_ENV=dev` (sandbox) for any live write testing.

## Workflow
- **Track work in GitHub issues.** Every feature, bugfix, or task starts as an issue (use the templates). Plan in the issue body; link related issues (sub-issue, blocked-by, relates-to) only when the relationship is real.
- Branch from `main` as `feat/<issue>-slug`, `fix/<issue>-slug`, or `chore/<issue>-slug`. Open a PR whose body contains `Closes #<n>`.
- Keep `CHANGELOG.md` updated under `## [Unreleased]` for user-visible changes.
- Releases: bump version in `package.json` and `src/server.ts`, move Unreleased notes under the new version, tag `vX.Y.Z`; the Release workflow publishes to npm via trusted publishing (OIDC, no token) and creates the GitHub release. Both steps are skipped if they already exist.
