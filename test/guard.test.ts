import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectClient, startOsmMock, type Answer } from "./helpers/mcp.js";

/** Session write guard (#27): bulk-looking sessions get a confirmation and a pointer at the code of conduct. */
let mock: Awaited<ReturnType<typeof startOsmMock>>;
beforeAll(async () => {
  mock = await startOsmMock();
});
afterAll(() => mock.close());
beforeEach(() => {
  mock.hits.length = 0;
});
const connect = (answer: Answer | ((r: any) => Answer) | undefined, env: Record<string, string> = {}) => connectClient(mock.base, answer, env);
const yes: Answer = { action: "accept", content: { confirm: true } };
const node = (id: number) => ({ type: "node", id, version: 1, lat: 1, lon: 2 });
const diff = (n: number) => ({ changeset_id: 5, modify: Array.from({ length: n }, (_, i) => node(i + 1)) });
const creates = () => mock.hits.filter((h) => h === "PUT /api/0.6/changeset/create").length;

describe("write guard", () => {
  it("lets one changeset with a few edits through without asking", async () => {
    const t = await connect({ action: "decline" });
    await t.call("osm_create_changeset", { comment: "one" });
    await t.call("osm_upload_diff", diff(10));
    expect(t.asked).toHaveLength(0);
    expect(mock.hits).toHaveLength(2);
    await t.close();
  });

  it("asks before a second changeset, with counts and the code of conduct", async () => {
    const t = await connect(yes);
    await t.call("osm_create_changeset", { comment: "one" });
    await t.call("osm_upload_diff", diff(3));
    await t.call("osm_create_changeset", { comment: "two" });
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0].message).toMatch(/opened 1 changeset\(s\) and written 3 element\(s\)/);
    expect(t.asked[0].message).toMatch(/open a new changeset \("two"\)/);
    expect(t.asked[0].message).toContain("wiki.openstreetmap.org/wiki/Automated_Edits_code_of_conduct");
    expect(creates()).toBe(2);
    await t.close();
  });

  it.each([
    ["decline", { action: "decline" }],
    ["cancel", { action: "cancel" }],
    ["accept without ticking", { action: "accept", content: { confirm: false } }],
  ] as [string, Answer][])("makes no request when the user says no (%s)", async (_n, answer) => {
    const t = await connect(answer);
    await t.call("osm_create_changeset", { comment: "one" });
    const r = await t.call("osm_create_changeset", { comment: "two" });
    expect(r.json().cancelled).toBe(true);
    expect(creates()).toBe(1);
    await t.close();
  });

  it("asks once a session passes 50 elements, even inside one changeset", async () => {
    const t = await connect(yes);
    await t.call("osm_upload_diff", diff(50));
    expect(t.asked).toHaveLength(0);
    await t.call("osm_upload_diff", diff(1));
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0].message).toMatch(/upload 1 element change\(s\) in one diff/);
    await t.close();
  });

  it("does not ask again until the element count has doubled after a yes", async () => {
    const t = await connect(yes);
    await t.call("osm_upload_diff", diff(51)); // 51 > 50: asked, now allowed up to 102
    await t.call("osm_upload_diff", diff(40)); // 91
    expect(t.asked).toHaveLength(1);
    await t.call("osm_upload_diff", diff(20)); // 111 > 102: asked again
    expect(t.asked).toHaveLength(2);
    await t.close();
  });

  it("refuses, naming the settings, when the client cannot ask", async () => {
    const t = await connect(undefined);
    await t.call("osm_create_changeset", { comment: "one" });
    const r = await t.call("osm_create_changeset", { comment: "two" });
    expect(r.json().refused).toBe(true);
    expect(r.json().message).toMatch(/OSM_GUARD_ELEMENTS/);
    expect(r.json().message).toMatch(/Automated_Edits_code_of_conduct/);
    expect(creates()).toBe(1);
    await t.close();
  });

  it("accepts a proposal link", async () => {
    const t = await connect({ action: "accept", content: { confirm: true, proposal_url: "https://community.openstreetmap.org/t/some-proposal/1" } });
    await t.call("osm_create_changeset", { comment: "one" });
    expect((await t.call("osm_create_changeset", { comment: "two" })).isError).toBe(false);
    expect(creates()).toBe(2);
    await t.close();
  });

  it.each(["javascript:alert(1)", "not a url", "ftp://example.com/x"])("rejects a proposal link that is not http(s): %s", async (link) => {
    const t = await connect({ action: "accept", content: { confirm: true, proposal_url: link } });
    await t.call("osm_create_changeset", { comment: "one" });
    const r = await t.call("osm_create_changeset", { comment: "two" });
    expect(r.json().cancelled).toBe(true);
    expect(creates()).toBe(1);
    await t.close();
  });

  it("counts calls that run in parallel together", async () => {
    const t = await connect(undefined);
    const [a, b] = await Promise.all([t.call("osm_create_changeset", { comment: "a" }), t.call("osm_create_changeset", { comment: "b" })]);
    expect([a, b].filter((r) => r.json().refused).length).toBe(1);
    expect(creates()).toBe(1);
    await t.close();
  });

  it("does not count a write that failed, so a retry is not penalised", async () => {
    const t = await connect(undefined);
    const bad = await t.call("osm_create_changeset", { comment: "x".repeat(300) }); // rejected by the tool schema before any write
    expect(bad.isError).toBe(true);
    expect((await t.call("osm_create_changeset", { comment: "ok" })).isError).toBe(false);
    expect(creates()).toBe(1);
    await t.close();
  });

  it.each([
    ["limits set to 0", { OSM_GUARD_ELEMENTS: "0", OSM_GUARD_CHANGESETS: "0" }],
    ["OSM_CONFIRM_WRITES=off", { OSM_CONFIRM_WRITES: "off" }],
    ["the dev sandbox default", { OSM_ENV: "dev" }],
  ])("is off with %s", async (_n, env) => {
    const t = await connect(undefined, env);
    await t.call("osm_create_changeset", { comment: "one" });
    await t.call("osm_create_changeset", { comment: "two" });
    await t.call("osm_upload_diff", diff(200));
    expect(creates()).toBe(2);
    await t.close();
  });

  it("limits can be raised with the environment", async () => {
    const t = await connect({ action: "decline" }, { OSM_GUARD_CHANGESETS: "5", OSM_GUARD_ELEMENTS: "500" });
    for (let i = 0; i < 5; i++) await t.call("osm_create_changeset", { comment: `c${i}` });
    await t.call("osm_upload_diff", diff(400));
    expect(t.asked).toHaveLength(0);
    await t.close();
  });
});
