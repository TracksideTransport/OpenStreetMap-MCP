import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectClient, startOsmMock, type Answer } from "./helpers/mcp.js";

/** Elicitation (#16): risky or public writes ask the user first, and decline/cancel never reach OSM. */
let mock: Awaited<ReturnType<typeof startOsmMock>>;
let hits: string[];
beforeAll(async () => {
  mock = await startOsmMock();
  hits = mock.hits;
});
afterAll(() => mock.close());
beforeEach(() => {
  hits.length = 0;
});
const connect = (answer: Answer | undefined, env: Record<string, string> = {}) => connectClient(mock.base, answer, env);

const del = { changeset_id: 5, element: { type: "node", id: 1, version: 1, lat: 1, lon: 2 } };
const diffWithDelete = { changeset_id: 5, delete: [{ type: "node", id: 1, version: 1, lat: 1, lon: 2 }], modify: [{ type: "node", id: 2, version: 1, lat: 1, lon: 2 }] };
const gpx = { gpx: "<gpx><trk><trkseg><trkpt lat='1' lon='2'><time>2020-01-01T00:00:00Z</time></trkpt></trkseg></trk></gpx>", description: "A walk", visibility: "trackable" };

describe("confirmations through MCP elicitation", () => {
  it("deletes only after the user confirms, and says what will be deleted", async () => {
    const t = await connect({ action: "accept", content: { confirm: true } });
    const r = await t.call("osm_delete_element", del);
    expect(r.isError).toBe(false);
    expect(hits).toEqual(["DELETE /api/0.6/node/1"]);
    expect(t.asked[0].message).toMatch(/Delete node 1 \(version 1\)/);
    expect(t.asked[0].message).toMatch(/real OpenStreetMap/);
    await t.close();
  });

  it.each([
    ["decline", { action: "decline" }],
    ["cancel", { action: "cancel" }],
    ["accept with the box unticked", { action: "accept", content: { confirm: false } }],
  ] as [string, Answer][])("makes no request when the user does not confirm (%s)", async (_n, answer) => {
    const t = await connect(answer);
    for (const [tool, args] of [["osm_delete_element", del], ["osm_upload_diff", diffWithDelete], ["osm_delete_gpx", { id: 9 }]] as const) {
      const r = await t.call(tool, args);
      expect(r.isError).toBe(false);
      expect(JSON.parse(r.text).cancelled).toBe(true);
    }
    expect(hits).toEqual([]);
    await t.close();
  });

  it("asks about an osmChange upload only when it deletes, with counts", async () => {
    const t = await connect({ action: "accept", content: { confirm: true } });
    await t.call("osm_upload_diff", { changeset_id: 5, modify: [{ type: "node", id: 2, version: 1, lat: 1, lon: 2 }] });
    expect(t.asked).toHaveLength(0);
    await t.call("osm_upload_diff", diffWithDelete);
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0].message).toMatch(/0 create, 1 modify, 1 DELETE/);
    await t.close();
  });

  it("lets the user choose GPX visibility; their choice beats the model's", async () => {
    const t = await connect({ action: "accept", content: { visibility: "identifiable" } });
    const r = await t.call("osm_upload_gpx", gpx);
    expect(JSON.parse(r.text).visibility).toBe("identifiable");
    expect(hits).toEqual(["POST /api/0.6/gpx identifiable"]);
    expect(t.asked[0].schema.properties.visibility.enum).toEqual(["trackable", "identifiable"]);
    expect(t.asked[0].schema.properties.visibility.default).toBe("trackable");
    await t.close();
  });

  it("uploads nothing when the GPX visibility prompt is declined", async () => {
    const t = await connect({ action: "decline" });
    const r = await t.call("osm_upload_gpx", gpx);
    expect(JSON.parse(r.text).cancelled).toBe(true);
    expect(hits).toEqual([]);
    await t.close();
  });

  it("falls back to the old behaviour when the client cannot elicit", async () => {
    const t = await connect(undefined);
    expect((await t.call("osm_delete_element", del)).isError).toBe(false);
    expect(hits).toEqual(["DELETE /api/0.6/node/1"]);
    await t.close();
  });

  it("OSM_CONFIRM_WRITES=off skips the prompt even when the client can elicit", async () => {
    const t = await connect({ action: "decline" }, { OSM_CONFIRM_WRITES: "off" });
    expect((await t.call("osm_delete_element", del)).isError).toBe(false);
    expect(t.asked).toHaveLength(0);
    expect(hits).toEqual(["DELETE /api/0.6/node/1"]);
    await t.close();
  });

  it("does not prompt for ordinary small edits", async () => {
    const t = await connect({ action: "decline" });
    await t.call("osm_create_changeset", { comment: "x" });
    expect(t.asked).toHaveLength(0);
    await t.close();
  });
});
