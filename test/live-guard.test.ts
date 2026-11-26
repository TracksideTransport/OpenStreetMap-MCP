import { describe, expect, it } from "vitest";
import { assertSandbox, liveEnv } from "./helpers/live.js";

describe("live-test sandbox guard", () => {
  it("allows the sandbox and localhost", () => {
    expect(() => assertSandbox("https://master.apis.dev.openstreetmap.org")).not.toThrow();
    expect(() => assertSandbox("http://127.0.0.1:3000")).not.toThrow();
    expect(() => assertSandbox("http://localhost:3000")).not.toThrow();
  });

  it("refuses production and lookalike hosts", () => {
    expect(() => assertSandbox("https://api.openstreetmap.org")).toThrow(/Refusing/);
    expect(() => assertSandbox("https://www.openstreetmap.org")).toThrow(/Refusing/);
    expect(() => assertSandbox("https://master.apis.dev.openstreetmap.org.evil.example")).toThrow(/Refusing/);
    expect(() => assertSandbox("not a url")).toThrow(/Refusing/);
  });

  it("forces the dev environment even if production is requested, and rejects a production override", () => {
    expect(liveEnv({ OSM_ENV: "production" }).OSM_ENV).toBe("dev");
    expect(() => liveEnv({ OSM_API_BASE: "https://api.openstreetmap.org" })).toThrow(/Refusing/);
  });
});
