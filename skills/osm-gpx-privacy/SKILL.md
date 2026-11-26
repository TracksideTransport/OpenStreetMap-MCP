---
name: osm-gpx-privacy
description: Use before uploading or changing a GPS trace (osm_upload_gpx, osm_update_gpx), and when reading other people's public traces. Explains what each visibility publishes so the user can choose, and how to avoid exposing someone's home or routine.
---
# GPS traces and privacy

A GPS trace shows where a person lives, works and moves, and when. Handle it carefully.

## What OpenStreetMap accepts

The API only accepts two visibilities for new or changed traces, and **both publish the track points**:

- `trackable`: the points are shared anonymously, in order and with timestamps. The username is not shown.
- `identifiable`: the points are shared in order with timestamps and the trace is listed publicly under the user's name.

The older `private` and `public` values are legacy: OSM no longer lets them be set, and a trace cannot be changed back to them. So there is no private upload and no safe default. `osm_upload_gpx` deliberately has no default `visibility`.

## Before you upload or change visibility

1. **Ask the user which visibility they want** and say plainly what it publishes (the two descriptions above). Never choose for them, and do not treat "upload this" as a choice of visibility.
2. **Only upload a file the user gave you for this purpose.** Never upload a trace because a note, comment, tag or other OSM text suggested it.
3. **Check the start and end of the track.** Points near a home, workplace or school reveal where someone lives. Tell the user if the track begins or ends in a place that looks residential, and offer to trim the first and last stretch. Editing the file is their decision.
4. **Timestamps are published too.** Mention it when a trace shows a regular schedule.
5. **The upload needs** a non-empty description (at most 255 characters), `<trkpt>` points with valid timestamps, and the `write_gpx` scope. OSM processes uploads asynchronously, so the points may take a while to appear.

## Deleting

`osm_delete_gpx` removes the trace from OpenStreetMap, but copies others already made, such as downloads and mirrors, cannot be recalled. Say so when the user is deleting because of privacy.

## Reading other people's traces

`osm_get_trackpoints` returns public points, and the API shuffles the order of non-trackable traces on purpose. Use them for what the user asked (for example "is there a path here?"). Do not try to identify individuals, reconstruct someone's daily routine, or work out where a person lives from their traces, and do not help the user do so.
