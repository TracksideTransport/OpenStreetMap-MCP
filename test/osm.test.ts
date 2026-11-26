import { describe, expect, it } from "vitest";
import { buildChangesetXml, buildElementXml, buildOsmChangeXml, parseDiffResult } from "../src/osm.js";

describe("xml builders", () => {
  it("builds a node with tags", () => {
    const xml = buildElementXml({ type: "node", lat: 1.5, lon: -2.5, tags: { amenity: "cafe", name: "A & B" } }, 42);
    expect(xml).toContain('<node changeset="42" lat="1.5" lon="-2.5">');
    expect(xml).toContain('<tag k="amenity" v="cafe"/>');
    expect(xml).toContain("A &amp; B");
  });

  it("builds a way with node refs and an update with id/version", () => {
    const xml = buildElementXml({ type: "way", id: 7, version: 3, nodes: [1, 2, 3], tags: { highway: "path" } }, 9);
    expect(xml).toContain('<way id="7" version="3" changeset="9">');
    expect(xml.match(/<nd ref=/g)).toHaveLength(3);
  });

  it("builds a relation with members", () => {
    const xml = buildElementXml({ type: "relation", members: [{ type: "way", ref: 5, role: "outer" }], tags: { type: "multipolygon" } }, 1);
    expect(xml).toContain('<member type="way" ref="5" role="outer"/>');
  });

  it("builds changeset tags", () => {
    expect(buildChangesetXml({ comment: "hi" })).toBe('<osm><changeset><tag k="comment" v="hi"/></changeset></osm>');
  });

  it("builds osmChange with create/modify/delete sections", () => {
    const xml = buildOsmChangeXml(
      {
        create: [{ type: "node", id: -1, lat: 0, lon: 0 }, { type: "node", id: -2, lat: 1, lon: 1 }, { type: "way", id: -3, nodes: [-1, -2] }],
        modify: [{ type: "node", id: 10, version: 2, lat: 3, lon: 4, tags: { a: "b" } }],
        delete: [{ type: "node", id: 11, version: 1, lat: 0, lon: 0 }],
      },
      5,
    );
    expect(xml).toContain('<osmChange version="0.6" generator="openstreetmap-mcp">');
    expect(xml).toMatch(/<create><node [^>]*id="-1"[^>]*\/><node [^>]*id="-2"[^>]*\/><way /);
    expect(xml).toContain("<modify>");
    expect(xml).toContain("<delete>");
    expect(xml.match(/changeset="5"/g)).toHaveLength(5);
  });

  it("parses diffResult", () => {
    const res = parseDiffResult('<diffResult><node old_id="-1" new_id="100" new_version="1"/><way old_id="9" new_id="9" new_version="4"/><node old_id="11"/></diffResult>');
    expect(res).toEqual([
      { type: "node", old_id: -1, new_id: 100, new_version: 1 },
      { type: "node", old_id: 11, new_id: undefined, new_version: undefined },
      { type: "way", old_id: 9, new_id: 9, new_version: 4 },
    ]);
  });
});
