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
- `src/nominatim.ts` – Nominatim client (opt-in geocoding; enforces 1 req/s, caches, per the Nominatim usage policy).
- `src/confirm.ts` – `askUser` / `confirmWrite` over MCP elicitation; skips (never throws) when the client cannot ask.
- `src/guard.ts` – per-session bulk-edit guard (`WriteGuard`), used by the edit tools; see `OSM_GUARD_*`.
- `src/patch.ts` – tag-patch logic behind `osm_patch_tags`.
- `skills/` – Agent Skills served as `skill://` resources (one folder per skill, `SKILL.md` + optional references); `src/skills.ts` loads them once at startup and `createServer` attaches them. Shipped in the npm package via `files`.
- `src/gpx.ts` – GPX summarizer (keeps thousands of points out of the model's context).
- `src/http/` – `--http` transport: `app.ts` (Express wiring, per-request server bound to the caller's OSM token), `proxy.ts` (the OAuth authorization server in front of OSM), `store.ts` (bounded TTL maps), `page.ts` (consent page).
- `src/tools/{auth,read,edit,notes,gpx,prefs,geocode}.ts` – tool definitions; `util.ts` has shared helpers.
- `test/` – vitest: unit, mock-HTTP client tests, real stdio smoke test. `test/helpers/server.ts` spawns the real server over stdio; `test/live/` holds the opt-in sandbox tests (separate `vitest.live.config.ts`, excluded from `npm test` and CI).

## Commands
```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # emits dist/
npm run test:live   # opt-in: real writes against the OSM SANDBOX (needs a dev token; skipped otherwise)
npm run dev         # run server from source over stdio
```
Run typecheck and tests before every commit.

## Conventions
- MCP SDK is `@modelcontextprotocol/server` v2: `server.registerTool(name, { description, inputSchema: z.object(...), annotations }, handler)`, with `zod/v4`. Check the current docs (Context7) before changing SDK usage.
- Reads use the API's `.json` endpoints; writes send XML built in `src/osm.ts`.
- Tool results go through `ok()` (via `safe()`), which keeps them within 60,000 characters **and valid JSON** by dropping whole array items. Never slice serialized JSON text. A tool that can return big data should offer filters and paging instead (see `osm_get_bbox`).
- Wrap every handler in `safe()` so failures return `isError` results instead of throwing.
- Never write to stdout (it is the MCP transport); log to stderr only.
- Write tools must set accurate `annotations` (`WRITE` / `DESTRUCTIVE`) and mention that edits are public.
- Tool names are prefixed `osm_`. Adding or renaming a tool: update README and CHANGELOG.
- Geocoding hits a shared public service: keep it opt-in, keep the rate limit and caching, never add autocomplete, bulk, or grid querying, and do not run live Nominatim calls in tests (use the mock server).
- The HTTP OAuth proxy is security-sensitive: keep PKCE S256 mandatory, exact redirect-URI matching, the consent step and its CSRF cookie, single-use codes, hashed token storage, and the rule that a code/token is never redirected to an unvalidated URI. Any change there needs a negative test in `test/http.test.ts`.
- Any user-supplied string placed in a URL path must be a number or an enum, or be percent-encoded **and** rejected if it is only dots (dot-segment normalization).
- Skills are instructions the model will follow, so review them as carefully as code. Keep them procedural, link to the OSM wiki instead of copying tag lists, and never build skill text from OSM free text (notes, comments, tags): that would turn untrusted content into instructions. A skill folder name must equal its `name`; `test/skills.test.ts` enforces frontmatter validity, the reviewed skill list, and that every `osm_*` tool a skill mentions exists. Adding a skill means updating that list, the README table and the CHANGELOG. The SDK's skills `attach` is experimental, hence the `~2.4.0` pin.
- Never commit tokens. Tokens live in `~/.config/openstreetmap-mcp/`.
- Do not run tests that write to the production OSM API. Live write testing goes through `npm run test:live` against the sandbox only; `test/helpers/live.ts` enforces this and must not be loosened.

## Workflow
- **Track work in GitHub issues.** Every feature, bugfix, or task starts as an issue (use the templates). Plan in the issue body; link related issues (sub-issue, blocked-by, relates-to) only when the relationship is real.
- Branch from `main` as `feat/<issue>-slug`, `fix/<issue>-slug`, or `chore/<issue>-slug`. Open a PR whose body contains `Closes #<n>`.
- Keep `CHANGELOG.md` updated under `## [Unreleased]` for user-visible changes.
- Releases: bump the version in `package.json` (the server reads it at runtime via `src/version.ts`, so there is nothing else to keep in sync), move Unreleased notes under the new version, tag `vX.Y.Z`; the Release workflow publishes to npm via trusted publishing (OIDC, no token) and creates the GitHub release. Both steps are skipped if they already exist.
