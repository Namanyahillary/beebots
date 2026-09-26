import { describe, expect, it } from "vitest";
import { screenUniverse, type ScoutKnobs } from "../src/scout.js";
import { coin, view } from "./fixtures.js";

const KNOBS: ScoutKnobs = { spreadGateBps: 15, min24hVolUsd: 1_000_000 };

describe("screenUniverse (pure, log-only)", () => {
  it("passes clean coins, ranked by 24h volume", () => {
    const v = view([
      coin("SOL", {}, 100),
      coin("BTC", { vol24hUsd: 50e6 }, 80000),
      coin("ETH", { vol24hUsd: 30e6 }, 2700),
    ]);
    const r = screenUniverse(v, KNOBS);
    expect(r.excluded).toEqual([]);
    expect(r.eligible).toEqual([
      "BTC-USD_UM_XPERP-310404",
      "ETH-USD_UM_XPERP-310404",
      "SOL-USD_UM_XPERP-310404",
    ]);
  });

  it("excludes a wide-spread coin with a spread reason", () => {
    const v = view([coin("BTC", {}, 80000), coin("RAY", { spreadBp: 42 }, 5)]);
    const r = screenUniverse(v, KNOBS);
    expect(r.eligible).toEqual(["BTC-USD_UM_XPERP-310404"]);
    expect(r.excluded).toHaveLength(1);
    expect(r.excluded[0]!.instId).toBe("RAY-USD_UM_XPERP-310404");
    expect(r.excluded[0]!.reasons.some((x) => x.includes("spread"))).toBe(true);
  });

  it("excludes coins with missing data, naming each failed screen", () => {
    const v = view([
      coin("BTC", {}, 80000),
      coin("NEWC", { fundingPct: null, fundingZ: null }, 1),
      coin("FRESH", { ret24hPct: null, ret7dPct: null }, 2),
      coin("THIN", { vol24hUsd: 100_000 }, 3),
    ]);
    const r = screenUniverse(v, KNOBS);
    expect(r.eligible).toEqual(["BTC-USD_UM_XPERP-310404"]);
    const byId = new Map(r.excluded.map((e) => [e.instId, e.reasons]));
    expect(byId.get("NEWC-USD_UM_XPERP-310404")!.some((x) => x.includes("funding"))).toBe(true);
    expect(byId.get("FRESH-USD_UM_XPERP-310404")!.some((x) => x.includes("trend"))).toBe(true);
    expect(byId.get("THIN-USD_UM_XPERP-310404")!.some((x) => x.includes("vol"))).toBe(true);
  });

  it("is pure: does not mutate the view and stacks all reasons on one coin", () => {
    const bad = coin("BAD", { spreadBp: 99, vol24hUsd: 10, fundingPct: null, fundingZ: null, ret24hPct: null });
    const v = view([bad]);
    const before = JSON.stringify([...v.stats.values()]);
    const r = screenUniverse(v, KNOBS);
    expect(r.eligible).toEqual([]);
    expect(r.excluded).toHaveLength(1);
    expect(r.excluded[0]!.reasons).toHaveLength(4);
    expect(JSON.stringify([...v.stats.values()])).toBe(before);
  });
});
