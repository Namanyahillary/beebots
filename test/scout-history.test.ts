// Scout history: direction-context enrichment at store time, set-change gating
// (proximity wiggles alone never log), newest-first history with legacy parse.
import { describe, expect, it } from "vitest";
import { Db, parseScoutEligible } from "../src/db.js";
import { storeScoutIfChanged } from "../src/engine.js";
import { enrichEligible, toTriggerPctFor, trendSignFor } from "../src/scout.js";
import { coin, trend, view, NOW } from "./fixtures.js";

const SOL = "SOL-USD_UM_XPERP-310404";
const BTC = "BTC-USD_UM_XPERP-310404";

describe("scout direction enrichment", () => {
  it("computes trigger proximity pct (negative = through)", () => {
    // trigger 105, mid 100 -> +5% still to rise.
    expect(toTriggerPctFor(coin("SOL", { breakout: { dayOpen: 100, prevRange: 10, trigger: 105 } }, 100))).toBeCloseTo(5, 9);
    // mid 110 through a 105 trigger -> negative.
    expect(toTriggerPctFor(coin("SOL", { breakout: { dayOpen: 100, prevRange: 10, trigger: 105 } }, 110))).toBeCloseTo(-4.5454545, 6);
    expect(toTriggerPctFor(coin("SOL", {}, 100))).toBeNull();
    expect(toTriggerPctFor(coin("SOL", { breakout: null }, 100))).toBeNull();
    expect(toTriggerPctFor(coin("SOL", { breakout: { dayOpen: 100, prevRange: 10, trigger: 105 }, mid: 0 }, 100))).toBeNull();
  });

  it("reads the trend score sign, null without trend data", () => {
    expect(trendSignFor(coin("A", { trend: trend({ score: 5 }) }))).toBe(1);
    expect(trendSignFor(coin("A", { trend: trend({ score: -3 }) }))).toBe(-1);
    expect(trendSignFor(coin("A", { trend: trend({ score: 0 }) }))).toBe(0);
    expect(trendSignFor(coin("A", {}, 100))).toBeNull();
  });

  it("enriches eligible ids from the live view, nulls where data is absent", () => {
    const v = view([
      coin("SOL", { breakout: { dayOpen: 100, prevRange: 10, trigger: 105 }, trend: trend({ score: 4 }) }, 100),
      coin("BTC", {}, 80000),
    ]);
    const out = enrichEligible([SOL, BTC], v);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ instId: SOL, trendSign: 1 });
    expect(out[0]!.toTriggerPct).toBeCloseTo(5, 9);
    expect(out[1]).toEqual({ instId: BTC, toTriggerPct: null, trendSign: null });
    // Unknown coin: nulls, never throws.
    expect(enrichEligible(["NOPE-USD_UM_XPERP-310404"], v)).toEqual([
      { instId: "NOPE-USD_UM_XPERP-310404", toTriggerPct: null, trendSign: null },
    ]);
  });
});

describe("store-on-change gating with enriched entries", () => {
  it("proximity wiggles alone do not store; set changes do", () => {
    const db = new Db(":memory:");
    const v1 = view([coin("SOL", { breakout: { dayOpen: 100, prevRange: 10, trigger: 105 }, trend: trend({ score: 2 }) }, 100)]);
    expect(storeScoutIfChanged(db, NOW, enrichEligible([SOL], v1), [])).toBe(true);
    // Same set, moved 2% closer: not a transition.
    const v2 = view([coin("SOL", { breakout: { dayOpen: 100, prevRange: 10, trigger: 105 }, trend: trend({ score: 2 }) }, 103)]);
    expect(storeScoutIfChanged(db, NOW + 1, enrichEligible([SOL], v2), [])).toBe(false);
    // Same set, trend sign flipped: still not a transition (sets only).
    const v3 = view([coin("SOL", { breakout: { dayOpen: 100, prevRange: 10, trigger: 105 }, trend: trend({ score: -2 }) }, 103)]);
    expect(storeScoutIfChanged(db, NOW + 2, enrichEligible([SOL], v3), [])).toBe(false);
    expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM scout_snapshots`).get()).toMatchObject({ n: 1 });
    // Membership change stores.
    expect(storeScoutIfChanged(db, NOW + 3, enrichEligible([SOL, BTC], view([coin("SOL", {}, 100), coin("BTC", {}, 80000)])), [])).toBe(true);
    expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM scout_snapshots`).get()).toMatchObject({ n: 2 });
    db.close();
  });

  it("still accepts legacy string lists", () => {
    const db = new Db(":memory:");
    expect(storeScoutIfChanged(db, NOW, [SOL], [])).toBe(true);
    expect(storeScoutIfChanged(db, NOW + 1, [SOL], [])).toBe(false);
    expect(db.latestScoutSnapshot()).toMatchObject({ eligible: [{ instId: SOL, toTriggerPct: null, trendSign: null }] });
    db.close();
  });
});

describe("scoutHistory", () => {
  it("returns newest-first and parses legacy string rows", () => {
    const db = new Db(":memory:");
    db.insertScoutSnapshot({ ts: NOW, eligible: [{ instId: SOL, toTriggerPct: 1.5, trendSign: 1 }], excluded: [] });
    db.insertScoutSnapshot({ ts: NOW + 1, eligible: [{ instId: BTC, toTriggerPct: null, trendSign: null }], excluded: [] });
    // Legacy row, written before the enrichment (plain strings).
    db.raw.prepare(`INSERT INTO scout_snapshots (ts, eligible, excluded) VALUES (?,?,?)`).run(NOW + 2, JSON.stringify([SOL]), JSON.stringify([]));
    const rows = db.scoutHistory(20);
    expect(rows.map((r) => r.ts)).toEqual([NOW + 2, NOW + 1, NOW]);
    expect(rows[0]!.eligible).toEqual([{ instId: SOL, toTriggerPct: null, trendSign: null }]);
    expect(rows[2]!.eligible).toEqual([{ instId: SOL, toTriggerPct: 1.5, trendSign: 1 }]);
    expect(db.scoutHistory(2)).toHaveLength(2);
    db.close();
  });

  it("parseScoutEligible drops malformed entries instead of throwing", () => {
    expect(parseScoutEligible("not json")).toEqual([]);
    expect(parseScoutEligible(JSON.stringify({}))).toEqual([]);
    expect(parseScoutEligible(JSON.stringify([SOL, { instId: BTC, toTriggerPct: 2, trendSign: -1 }, 42, { nope: 1 }]))).toEqual([
      { instId: SOL, toTriggerPct: null, trendSign: null },
      { instId: BTC, toTriggerPct: 2, trendSign: -1 },
    ]);
  });
});
