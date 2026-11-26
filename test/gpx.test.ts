import { describe, expect, it } from "vitest";
import { summarizeGpx } from "../src/gpx.js";
import { buildGpxMetadataXml, pickGpxFile } from "../src/tools/gpx.js";

const GPX = `<?xml version="1.0"?><gpx version="1.0" xmlns="http://www.topografix.com/GPX/1/0">
<trk><name>A</name><desc>first</desc><url>/user/x/traces/1</url><trkseg>
<trkpt lat="1" lon="10"><ele>5.5</ele><time>2020-01-01T10:00:00Z</time></trkpt>
<trkpt lat="3" lon="12"><time>2020-01-01T09:00:00Z</time></trkpt>
</trkseg><trkseg><trkpt lat="2" lon="11"/></trkseg></trk>
<trk><name>B</name><trkseg><trkpt lat="-1" lon="-1"/></trkseg></trk>
<wpt lat="0" lon="0"/></gpx>`;

describe("summarizeGpx", () => {
  it("summarizes tracks, bbox and time range across segments", () => {
    const s = summarizeGpx(GPX);
    expect(s.total_points).toBe(4);
    expect(s.waypoints).toBe(1);
    expect(s.tracks).toHaveLength(2);
    expect(s.tracks[0]).toMatchObject({ name: "A", description: "first", url: "/user/x/traces/1", point_count: 3, first_time: "2020-01-01T09:00:00Z", last_time: "2020-01-01T10:00:00Z", bbox: { min_lon: 10, min_lat: 1, max_lon: 12, max_lat: 3 } });
    expect(s.tracks[0].points).toBeUndefined();
  });

  it("returns points only on request and caps them across tracks", () => {
    const s = summarizeGpx(GPX, { includePoints: true, maxPoints: 2 });
    expect(s.points_returned).toBe(2);
    expect(s.points_truncated).toBe(true);
    expect(s.tracks[0].points).toEqual([{ lat: 1, lon: 10, ele: 5.5, time: "2020-01-01T10:00:00Z" }, { lat: 3, lon: 12, time: "2020-01-01T09:00:00Z" }]);
    expect(s.tracks[1].points).toEqual([]);
  });

  it("handles a single point (not an array in XML) and empty documents", () => {
    expect(summarizeGpx('<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>').total_points).toBe(1);
    expect(summarizeGpx("<gpx/>").tracks).toEqual([]);
  });

  it("rejects non-GPX input", () => {
    expect(() => summarizeGpx("<osm/>")).toThrow(/Not a GPX/);
    expect(() => summarizeGpx("garbage")).toThrow(/Not a GPX/);
  });
});

describe("gpx metadata helpers", () => {
  it("builds escaped update XML", () => {
    expect(buildGpxMetadataXml({ id: 9, name: "a&b.gpx", visibility: "trackable", description: 'x < "y"', tags: ["t1", "a&b"] })).toBe(
      '<osm><gpx_file id="9" name="a&amp;b.gpx" visibility="trackable"><description>x &lt; &quot;y&quot;</description><tag>t1</tag><tag>a&amp;b</tag></gpx_file></osm>',
    );
  });
  it("picks the trace out of the real JSON shapes (and the older documented ones)", () => {
    expect(pickGpxFile({ trace: { id: 0 } })).toEqual({ id: 0 });
    expect(pickGpxFile({ traces: [{ id: 4 }] })).toEqual({ id: 4 });
    expect(pickGpxFile({ gpx_file: { id: 1 } })).toEqual({ id: 1 });
    expect(pickGpxFile({ gpx_files: [{ id: 2 }] })).toEqual({ id: 2 });
    expect(pickGpxFile({ id: 3 })).toEqual({ id: 3 });
  });
});
