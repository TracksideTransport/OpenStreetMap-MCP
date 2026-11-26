---
name: osm-find-a-place
description: Use when the user names a place or address and you need coordinates or a bounding box for OpenStreetMap tools such as osm_get_bbox, osm_get_notes_in_bbox or osm_get_trackpoints. Covers geocoding, choosing a box small enough for the API, and the Nominatim usage rules.
---
# From a place name to a bounding box

The OSM API itself cannot look up place names. These tools need coordinates:
`osm_get_bbox`, `osm_get_notes_in_bbox`, `osm_get_trackpoints` (a bounding box) and `osm_create_note` (a single point).

## 1. Get coordinates

- If `osm_geocode` is available, use it. It exists only when the server was started with `OSM_ENABLE_GEOCODING=true`.
- If it is not available, ask the user for coordinates or a bounding box. Do not guess coordinates from memory. You can tell the user that geocoding can be switched on with `OSM_ENABLE_GEOCODING=true`.
- For "what is at this point?", use `osm_reverse_geocode` with one coordinate.

## 2. Pick the right result

`osm_geocode` returns several candidates with `display_name`, `lat`, `lon`, `osm_type`, `osm_id` and a `bbox`. If more than one is plausible ("Springfield"), show the user the top few and ask which one. Do not silently pick one. Restrict the search with `country_codes` or a `viewbox` when the user gave context.

To work on the exact object, pass `osm_type` and `osm_id` to `osm_get_element` (or `osm_get_element_full` for a way or relation) instead of downloading an area.

## 3. Make the box small enough

- `osm_get_bbox`: the area limit is in square degrees (width times height, at most 0.25 by default; `osm_capabilities` reports it) and the response is capped at 50,000 nodes. A city-sized `bbox` from the geocoder is usually too big, and even a legal box in a dense city can return too many nodes.
- `osm_get_trackpoints`: width and height must each be at most 0.25 degrees.
- Start around the point rather than using the geocoder's box. About 0.002 degrees each way from the centre is roughly 200 metres in latitude (1 degree of latitude is about 111 km; a degree of longitude is shorter by the cosine of the latitude). Widen only if the user needs more.
- If a call fails with "too many nodes" or "area too large", shrink the box. Do not split a big area into a grid of requests.

## 4. Nominatim rules (shared public service)

The geocoder uses the public Nominatim service, which has very little capacity. Follow its usage policy:

- One lookup per thing the user asked for. No loops, no grids of reverse lookups, no bulk or batch geocoding, no autocomplete-style repeated searches.
- Do not scrape results or call it for data you could get from `osm_get_bbox`.
- Results are © OpenStreetMap contributors (ODbL); keep the attribution that comes back when you show them.
- If a call returns a rate-limit error (HTTP 429), stop and tell the user. Do not retry in a loop.
