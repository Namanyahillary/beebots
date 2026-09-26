// profit-mode: scout snapshots are change-triggered (transitions, not every refresh) and pruned like ghosts.
import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { storeScoutIfChanged } from "../src/engine.js";
import { eligibleSetEqual, sampleExcluded, SCOUT_EXCLUDED_SAMPLE } from "../src/scout.js";
import { NOW } from "./fixtures.js";

const SOL = "SOL-USD_UM_XPERP-310404";
const BTC = "BTC-USD_UM_XPERP-310404";

describe("scout snapshots (insert-on-change only)", () => {
  it("stores the first snapshot, skips duplicates, stores on change", () => {
    const db = new Db(":memory:");
    expect(storeScoutIfChanged(db, NOW, [SOL], [])).toBe(true);
    expect(storeScoutIfChanged(db, NOW + 1, [SOL], [])).toBe(false);
    // Same set in a different order is not a transition (volume-rank flips alone don't log).
    expect(storeScoutIfChanged(db, NOW + 2, [SOL], [])).toBe(false);
    expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM scout_snapshots`).get()).toMatchObject({ n: 1 });
    // A membership change stores a new row.
    expect(storeScoutIfChanged(db, NOW + 3, [SOL, BTC], [])).toBe(true);
    expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM scout_snapshots`).get()).toMatchObject({ n: 2 });
    expect(db.latestScoutSnapshot()).toMatchObject({ ts: NOW + 3, eligible: [SOL, BTC] });
    // Scout path wrote nowhere else.
    for (const t of ["orders", "fills", "decisions", "ghost_decisions"]) {
      const n = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      expect(n.n).toBe(0);
    }
    db.close();
  });

  it("prunes old snapshots and keeps the latest", () => {
    const db = new Db(":memory:");
    db.insertScoutSnapshot({ ts: NOW - 10, eligible: [SOL], excluded: [] });
    db.insertScoutSnapshot({ ts: NOW, eligible: [BTC], excluded: [] });
    db.pruneScoutSnapshots(NOW - 5);
    expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM scout_snapshots`).get()).toMatchObject({ n: 1 });
    expect(db.latestScoutSnapshot()).toMatchObject({ ts: NOW, eligible: [BTC] });
    db.close();
  });

  it("latestScoutSnapshot is null on a fresh (or migrated) DB", () => {
    const db = new Db(":memory:");
    expect(db.latestScoutSnapshot()).toBeNull();
    db.close();
  });
});

describe("eligibleSetEqual", () => {
  it("ignores order but not membership", () => {
    expect(eligibleSetEqual([SOL, BTC], [BTC, SOL])).toBe(true);
    expect(eligibleSetEqual([SOL], [SOL, BTC])).toBe(false);
    expect(eligibleSetEqual([SOL], [BTC])).toBe(false);
    expect(eligibleSetEqual([], [])).toBe(true);
  });
});

describe("sampleExcluded", () => {
  it("keeps the top entries by volume and bounds the size", () => {
    const vols = new Map([[SOL, 50e6], [BTC, 80e6], ["THIN-USD_UM_XPERP-310404", 1e6]]);
    const excluded = [SOL, BTC, "THIN-USD_UM_XPERP-310404"].map((instId) => ({ instId, reasons: ["x"] }));
    const sampled = sampleExcluded(excluded, (id) => vols.get(id) ?? 0);
    expect(sampled.map((e) => e.instId)).toEqual([BTC, SOL, "THIN-USD_UM_XPERP-310404"]);
    const many = Array.from({ length: SCOUT_EXCLUDED_SAMPLE + 5 }, (_, i) => ({ instId: `C${i}`, reasons: ["x"] }));
    expect(sampleExcluded(many, () => 1)).toHaveLength(SCOUT_EXCLUDED_SAMPLE);
  });
});
