# Contributing

1. Find or open an [issue](https://github.com/TracksideTransport/OpenStreetMap-MCP/issues/new/choose) first; bugs, features and tasks are planned there.
2. Branch from `main`, make focused changes with tests.
3. `npm run typecheck && npm test` must pass.
4. Add a line under `## [Unreleased]` in `CHANGELOG.md` for user-visible changes.
5. Open a PR with `Closes #<issue>` in the body.

Please never test writes against the production OSM API; use the [sandbox](https://master.apis.dev.openstreetmap.org) with `OSM_ENV=dev`. See [AGENTS.md](AGENTS.md) for architecture and conventions.
