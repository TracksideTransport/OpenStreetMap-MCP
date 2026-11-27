import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectClient, startOsmMock, type Answer } from "./helpers/mcp.js";

/** Public text (#30): comments and notes are shown to the user, editable, and never sent without their yes. */
let mock: Awaited<ReturnType<typeof startOsmMock>>;
beforeAll(async () => {
  mock = await startOsmMock();
});
afterAll(() => mock.close());
beforeEach(() => {
  mock.hits.length = 0;
  mock.bodies.length = 0;
});
const connect = (answer: Answer | ((r: any) => Answer) | undefined, env: Record<string, string> = {}) => connectClient(mock.base, answer, env);
const post = (text: string, confirm = true): Answer => ({ action: "accept", content: { text, confirm } });
const lastBodyText = () => new URLSearchParams(mock.bodies.at(-1)).get("text");

describe("changeset comments", () => {
  it("shows the model's text, and sends what the user submits", async () => {
    const t = await connect(post("My own words."));
    const r = await t.call("osm_comment_changeset", { id: 5, text: "Composed by the model." });
    expect(r.isError).toBe(false);
    expect(t.asked[0].schema.properties.text.default).toBe("Composed by the model.");
    expect(t.asked[0].message).toMatch(/Comment on changeset 5 on the real OpenStreetMap/);
    expect(t.asked[0].message).toMatch(/chatbot can be removed by OSM moderators/);
    expect(mock.hits).toEqual(["POST /api/0.6/changeset/5/comment"]);
    expect(lastBodyText()).toBe("My own words.");
    await t.close();
  });

  it.each([
    ["decline", { action: "decline" }],
    ["cancel", { action: "cancel" }],
    ["accept with the box unticked", post("x", false)],
    ["accept with the text cleared", post("   ")],
  ] as [string, Answer][])("sends nothing when the user does not post it (%s)", async (_n, answer) => {
    const t = await connect(answer);
    const r = await t.call("osm_comment_changeset", { id: 5, text: "hello" });
    expect(r.json().cancelled).toBe(true);
    expect(mock.hits).toEqual([]);
    await t.close();
  });

  it("keeps the old behaviour when the client cannot ask", async () => {
    const t = await connect(undefined);
    await t.call("osm_comment_changeset", { id: 5, text: "as written" });
    expect(lastBodyText()).toBe("as written");
    await t.close();
  });

  it("OSM_CONFIRM_WRITES=off skips the review", async () => {
    const t = await connect(post("ignored"), { OSM_CONFIRM_WRITES: "off" });
    await t.call("osm_comment_changeset", { id: 5, text: "as written" });
    expect(t.asked).toHaveLength(0);
    expect(lastBodyText()).toBe("as written");
    await t.close();
  });
});

describe("notes", () => {
  it("creates a note with the user's edited text", async () => {
    const t = await connect(post("User text"));
    await t.call("osm_create_note", { lat: 1, lon: 2, text: "Model text" });
    expect(t.asked[0].message).toMatch(/Create a map note at 1, 2/);
    expect(mock.hits).toHaveLength(1);
    expect(new URL(mock.hits[0].split(" ")[1], "http://x").searchParams.get("text")).toBe("User text");
    await t.close();
  });

  it("comments on, closes and reopens notes only after a yes", async () => {
    const t = await connect(post("fine"));
    for (const [tool, args] of [["osm_comment_note", { id: 7, text: "hi" }], ["osm_close_note", { id: 7 }], ["osm_reopen_note", { id: 7, text: "back" }]] as const) {
      expect((await t.call(tool, args)).isError).toBe(false);
    }
    expect(mock.hits.map((h) => h.split("?")[0])).toEqual(["POST /api/0.6/notes/7/comment.json", "POST /api/0.6/notes/7/close.json", "POST /api/0.6/notes/7/reopen.json"]);
    await t.close();
  });

  it("closing a note may carry no text at all", async () => {
    const t = await connect({ action: "accept", content: { text: "", confirm: true } });
    await t.call("osm_close_note", { id: 7 });
    expect(mock.hits).toHaveLength(1);
    expect(new URL(mock.hits[0].split(" ")[1], "http://x").searchParams.has("text")).toBe(false);
    await t.close();
  });

  it.each([["decline", { action: "decline" }], ["unticked", post("x", false)]] as [string, Answer][])("posts nothing on %s", async (_n, answer) => {
    const t = await connect(answer);
    for (const [tool, args] of [["osm_create_note", { lat: 1, lon: 2, text: "t" }], ["osm_comment_note", { id: 7, text: "t" }], ["osm_close_note", { id: 7, text: "t" }], ["osm_reopen_note", { id: 7 }]] as const) {
      expect((await t.call(tool, args)).json().cancelled).toBe(true);
    }
    expect(mock.hits).toEqual([]);
    await t.close();
  });
});
