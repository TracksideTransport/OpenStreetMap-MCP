import { describe, expect, it } from "vitest";
import { filterAndPage, parseTagFilter, type MapElement } from "../src/bbox.js";
import { MAX_CHARS, fitJson, ok } from "../src/tools/util.js";

const box = { min_lon: 0, min_lat: 0, max_lon: 1, max_lat: 1 };
const node = (id: number, lat: number, lon: number, tags?: Record<string, string>): MapElement => ({ type: "node", id, lat, lon, version: 3, timestamp: "2020-01-01T00:00:00Z", changeset: 9, uid: 1, user: "u", ...(tags ? { tags } : {}) });
const way = (id: number, nodes: number[], tags?: Record<string, string>): MapElement => ({ type: "way", id, nodes, version: 1, ...(tags ? { tags } : {}) });
const rel = (id: number, tags?: Record<string, string>): MapElement => ({ type: "relation", id, members: [{ type: "way", ref: 1, role: "" }], ...(tags ? { tags } : {}) });

const sample: MapElement[] = [
  node(1, 0.5, 0.5, { railway: "subway_entrance", ref: "A" }),
  node(2, 0.6, 0.6),
  node(3, 5, 5), // far outside, pulled in by a way
  node(4, 0.7, 0.7, { highway: "elevator" }),
  way(10, [1, 2, 3], { highway: "footway" }),
  rel(20, { public_transport: "stop_area" }),
];

describe("parseTagFilter", () => {
  it("handles key, key=value and wildcard forms", () => {
    expect(parseTagFilter("railway")).toEqual({ key: "railway" });
    expect(parseTagFilter("railway=subway_entrance")).toEqual({ key: "railway", value: "subway_entrance" });
    expect(parseTagFilter("railway=*")).toEqual({ key: "railway", value: undefined });
    expect(parseTagFilter("a=b=c")).toEqual({ key: "a", value: "b=c" });
  });
});

describe("filterAndPage", () => {
  const q = { offset: 0, limit: 100 };
  const ids = (r: ReturnType<typeof filterAndPage>) => r.elements.map((e) => `${e.type}${e.id}`);

  it("returns everything when unfiltered", () => {
    const r = filterAndPage(sample, q);
    expect(r).toMatchObject({ total_matching: 6, returned: 6, next_offset: null, offset: 0 });
  });

  it("filters by type", () => {
    expect(ids(filterAndPage(sample, { ...q, types: ["way", "relation"] }))).toEqual(["way10", "relation20"]);
  });

  it("filters by tag (OR across filters, exact value or any value)", () => {
    expect(ids(filterAndPage(sample, { ...q, tagFilters: ["railway=subway_entrance", "highway=elevator"] }))).toEqual(["node1", "node4"]);
    expect(ids(filterAndPage(sample, { ...q, tagFilters: ["highway"] }))).toEqual(["node4", "way10"]);
    expect(ids(filterAndPage(sample, { ...q, tagFilters: ["railway=other"] }))).toEqual([]);
  });

  it("drops untagged elements on request", () => {
    expect(ids(filterAndPage(sample, { ...q, taggedOnly: true }))).toEqual(["node1", "node4", "way10", "relation20"]);
  });

  it("drops far-away nodes but keeps ways and relations", () => {
    expect(ids(filterAndPage(sample, { ...q, insideOnly: box }))).toEqual(["node1", "node2", "node4", "way10", "relation20"]);
  });

  it("compact keeps only the useful fields", () => {
    const r = filterAndPage(sample, { ...q, compact: true, types: ["node"], taggedOnly: true });
    expect(r.elements[0]).toEqual({ type: "node", id: 1, lat: 0.5, lon: 0.5, tags: { railway: "subway_entrance", ref: "A" } });
    expect(r.elements[0]).not.toHaveProperty("user");
    expect(filterAndPage(sample, { ...q, compact: true, types: ["way"] }).elements[0]).toEqual({ type: "way", id: 10, nodes: [1, 2, 3], tags: { highway: "footway" } });
  });

  it("pages by limit and walking next_offset reproduces the full filtered list exactly", () => {
    const many = Array.from({ length: 95 }, (_, i) => node(i + 1, 0.5, 0.5, { n: String(i) }));
    const seen: number[] = [];
    let offset = 0;
    for (let guard = 0; guard < 50; guard++) {
      const r = filterAndPage(many, { offset, limit: 20 });
      seen.push(...r.elements.map((e) => e.id));
      if (r.next_offset === null) break;
      expect(r.next_offset).toBe(offset + r.returned);
      offset = r.next_offset;
    }
    expect(seen).toEqual(many.map((e) => e.id));
  });

  it("stops a page at the size budget without ever splitting an element, and always returns at least one", () => {
    const fat = Array.from({ length: 10 }, (_, i) => node(i + 1, 0.5, 0.5, { blob: "x".repeat(1000) }));
    const r = filterAndPage(fat, { offset: 0, limit: 100, budgetChars: 3500 });
    expect(r.returned).toBe(3);
    expect(r.next_offset).toBe(3);
    const huge = filterAndPage([node(1, 0.5, 0.5, { blob: "y".repeat(10_000) })], { offset: 0, limit: 10, budgetChars: 100 });
    expect(huge.returned).toBe(1);
    expect(huge.next_offset).toBeNull();
  });

  it("an offset past the end returns an empty last page", () => {
    expect(filterAndPage(sample, { offset: 99, limit: 10 })).toMatchObject({ returned: 0, next_offset: null, total_matching: 6 });
  });
});

describe("fitJson / ok", () => {
  const big = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, text: "z".repeat(200) }));

  it("leaves small results pretty-printed and unchanged", () => {
    expect(fitJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("switches to compact JSON when that is enough", () => {
    const data = { items: Array.from({ length: 4000 }, (_, i) => ({ id: i })) };
    expect(JSON.stringify(data, null, 2).length).toBeGreaterThan(MAX_CHARS);
    const out = fitJson(data);
    expect(out.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(JSON.parse(out)).toEqual(data);
  });

  it("drops whole items from the largest array, stays valid JSON and says what it did", () => {
    const data = { version: "0.6", elements: big(2000), small: [1, 2, 3] };
    const out = fitJson(data);
    expect(out.length).toBeLessThanOrEqual(MAX_CHARS);
    const parsed = JSON.parse(out);
    expect(parsed.version).toBe("0.6");
    expect(parsed.small).toEqual([1, 2, 3]);
    expect(parsed.elements.length).toBeGreaterThan(100);
    expect(parsed.elements.length).toBeLessThan(2000);
    expect(parsed.elements.every((e: any) => e.text.length === 200)).toBe(true); // no element is cut in half
    expect(parsed.truncated.fields[0]).toMatchObject({ field: "elements", kept: parsed.elements.length, total: 2000 });
  });

  it("handles a top-level array and several large arrays", () => {
    const a = JSON.parse(fitJson(big(2000)));
    expect(a.items.length).toBeLessThan(2000);
    const b = JSON.parse(fitJson({ x: big(1000), y: big(1000) }));
    expect(JSON.stringify(b).length).toBeLessThanOrEqual(MAX_CHARS);
    expect(b.truncated.fields.map((f: any) => f.field).sort()).toEqual(["x", "y"]);
  });

  it("falls back to a clear JSON error when nothing can be trimmed", () => {
    const out = fitJson({ blob: "q".repeat(100_000) });
    expect(out.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(JSON.parse(out).error).toMatch(/too large/);
  });

  it("ok() returns valid JSON text for big objects and keeps plain strings as text", () => {
    const text = ok({ elements: big(2000) }).content[0].text;
    expect(() => JSON.parse(text)).not.toThrow();
    expect(ok("hello").content[0].text).toBe("hello");
    expect(ok("w".repeat(70_000)).content[0].text).toMatch(/truncated 10000 chars/);
  });
});
