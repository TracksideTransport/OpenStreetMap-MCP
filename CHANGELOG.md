# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-11-26

### Added
- Opt-in place search: `osm_geocode` and `osm_reverse_geocode` via Nominatim (`OSM_ENABLE_GEOCODING=true`, `OSM_NOMINATIM_URL`), with a 1 request/second limit, caching, an identifying User-Agent, and attribution in results.
- `osm_patch_tags`: add, change, or remove tags on an element without resending its geometry or other tags; no-op when nothing changes, optional `expected_version` guard.

## [0.1.0] - 2026-11-26

### Added
- MCP server (stdio) for the OpenStreetMap API v0.6.
- OAuth 2.0 authorization-code flow with PKCE and a loopback redirect (`osm_login`, `osm_logout`, `osm_whoami`); tokens stored with `0600` permissions.
- Read tools: capabilities, elements (single, multiple, full, history, parents), bounding-box download, changesets (get, search, diff), users.
- Edit tools: create/close changesets, create/update/delete elements, atomic `osmChange` upload, changeset comments.
- Map notes tools: search, bbox listing, create, comment, close, reopen.
- `OSM_ENV=dev` switch for the OSM sandbox server.
- `write_changeset_comments` is now a default OAuth scope (needed by `osm_comment_changeset`).

### Fixed
- Write requests now send `Accept: application/xml`; with JSON, `osm_upload_diff` lost its per-element results (new ids and versions).
- Clarified that changeset comments are only accepted on closed changesets.

[Unreleased]: https://github.com/sohampatwardhan/OpenStreetMap-MCP/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/sohampatwardhan/OpenStreetMap-MCP/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sohampatwardhan/OpenStreetMap-MCP/releases/tag/v0.1.0
