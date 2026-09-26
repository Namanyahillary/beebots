import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { freshBee } from "../src/ledger.js";
import { NOW } from "./fixtures.js";

describe("ghost_decisions (never executed)", () => {
  it("inserts and prunes without touching orders/fills/decisions", () => {
    const db = new Db(":memory:");
    const id = db.insertGhostDecision({ bee: "bee1", ts: NOW, choice: "ride", reason: "test", detail: { uplR: 1.5 } });
    expect(id).toBeGreaterThan(0);
    const rows = db.raw.prepare(`SELECT bee, choice, reason, detail FROM ghost_decisions`).all() as Array<{ bee: string; choice: string; reason: string; detail: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bee: "bee1", choice: "ride", reason: "test" });
    expect(JSON.parse(rows[0]!.detail)).toEqual({ uplR: 1.5 });
    // Ghost path wrote nowhere else.
    for (const t of ["orders", "fills", "decisions"]) {
      const n = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      expect(n.n).toBe(0);
    }
    db.pruneGhostDecisions(NOW + 1);
    expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM ghost_decisions`).get()).toMatchObject({ n: 0 });
    db.close();
  });
});

describe("bee_state position migration", () => {
  it("defaults trimmedAtR/beMoved on old rows and preserves set values", () => {
    const db = new Db(":memory:");
    const old = freshBee("bee1", 333, NOW);
    // A row saved before the fields existed (both are optional, so this is still a valid Position).
    old.position = { instId: "SOL-USD_UM_XPERP-310404", coin: "SOL", side: "long", contracts: 10, entryPx: 100, openedAt: NOW, stopPx: 99, riskUsd: 5 };
    db.saveBee(old, NOW);
    expect(db.loadBee("bee1")!.position).toMatchObject({ trimmedAtR: null, beMoved: false });

    const flagged = freshBee("bee1", 333, NOW);
    flagged.position = { ...old.position!, trimmedAtR: 1, beMoved: true };
    db.saveBee(flagged, NOW + 1);
    expect(db.loadBee("bee1")!.position).toMatchObject({ trimmedAtR: 1, beMoved: true });
    db.close();
  });
});

describe("recentEvents reserves room for non-decision events", () => {
  it("fills survive a flood of decision ticks", async () => {
    const { Db } = await import("../src/db.js");
    const db = new Db(":memory:");
    for (let i = 0; i < 410; i++) db.insertEvent(i, "decision", `{"type":"decision","i":${i}}`);
    db.insertEvent(411, "fill", `{"type":"fill","coin":"BTC"}`);
    const rows = db.recentEvents(400);
    expect(rows.length).toBeLessThanOrEqual(450);
    expect(rows.some((j) => j.includes('"fill"'))).toBe(true);
  });
});

describe("decisions.model attribution", () => {
  it("records the reasoning model per decision", async () => {
    const { Db } = await import("../src/db.js");
    const db = new Db(":memory:");
    const base = { bee: "bee1" as const, ts: 1, stateHash: null, stateJson: null, menuJson: "[]", choice: "RIDE", probabilities: null, confidence: null, conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null, action: { kind: "none" }, vetoedBy: null, forcedBy: null, status: "x" };
    db.insertDecision({ ...base, model: "openai/gpt-4o-mini" });
    db.insertDecision({ ...base, ts: 2, model: null });
    const rows = db.raw.prepare(`SELECT model FROM decisions ORDER BY ts`).all() as Array<{ model: string | null }>;
    expect(rows.map((r) => r.model)).toEqual(["openai/gpt-4o-mini", null]);
  });
});
