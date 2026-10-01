import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { Alerts } from "../src/alerts.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Jev } from "../src/jev.js";
import { testConfig } from "./fixtures.js";
import { bee, coin, NOW, view } from "./fixtures.js";

const DEC = {
  stateHash: "h", stateJson: "{}", menuJson: "[]", probabilities: null, confidence: null,
  conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
  jevCached: false, model: null, action: { kind: "none" } as const, vetoedBy: null, status: "t",
};

describe("closeAttribution (closed R by entry source)", () => {
  function dbWithFills() {
    const db = new Db(":memory:");
    const dec = (bee: string, over = {}) => db.insertDecision({ bee: bee as "bee1", ts: NOW, choice: "X", forcedBy: null, ...DEC, ...over });
    let seq = 0;
    const ord = (bee: string, did: number, reduceOnly: boolean, purpose: string) =>
      db.insertOrder({ decisionId: did, bee: bee as "bee1", ts: NOW, clOrdId: `c${++seq}${purpose}`, instId: "BTC-X", side: "sell", contracts: 1, reduceOnly, purpose });
    const fill = (bee: string, oid: number, realised: number, fee: number, entry: number | null) =>
      db.insertFill({ orderId: oid, bee: bee as "bee1", ts: NOW, instId: "BTC-X", side: "sell", contracts: 1, px: 100, notionalUsd: 100, feeUsd: fee, realisedUsd: realised, entryDecisionId: entry });
    // jev-fresh entry, closed twice (trim + stop)
    const fresh = dec("bee1", { choice: "APE_BTC", inputTokens: 500 });
    fill("bee1", ord("bee1", fresh, false, "open"), 0, 0.3, null);
    fill("bee1", ord("bee1", 999, true, "trim"), 1.25, 0.15, fresh);
    fill("bee1", ord("bee1", 999, true, "stop"), -0.1, 0.15, fresh);
    // forced entry, stopped out
    const forced = dec("bee1", { choice: "APE_ETH", forcedBy: "max_flat", inputTokens: 400 });
    fill("bee1", ord("bee1", forced, false, "open"), 0, 0.3, null);
    fill("bee1", ord("bee1", 999, true, "stop"), -5, 0.3, forced);
    // cached answer entry, scratched
    const cached = dec("bee1", { choice: "RIDE", jevCached: true });
    fill("bee1", ord("bee1", cached, false, "open"), 0, 0.2, null);
    fill("bee1", ord("bee1", 999, true, "take_profit"), 0, 0.1, cached);
    // pre-attribution close (no entry link)
    fill("bee1", ord("bee1", 999, true, "stop"), -2, 0.2, null);
    return db;
  }
  it("groups realised P&L by what opened the position", () => {
    const rows = dbWithFills().closeAttribution();
    const by = new Map(rows.map((r) => [r.source, r]));
    expect(by.get("jev-fresh")).toMatchObject({ bee: "bee1", fills: 2, pnlUsd: 1.15 });
    expect(by.get("jev-fresh")!.feesUsd).toBeCloseTo(0.3, 5);
    expect(by.get("forced:max_flat")).toMatchObject({ fills: 1, pnlUsd: -5 });
    expect(by.get("jev-cached")).toMatchObject({ fills: 1, pnlUsd: 0 });
    expect(by.get("unknown")).toMatchObject({ fills: 1, pnlUsd: -2 });
  });
});

describe("engine stamps entryDecisionId on opens and close fills", () => {
  it("a close fill points back at the open decision", async () => {
    const cfg = testConfig({ SCALPY_MAX_TRADES_PER_DAY: "80" });
    const db = new Db(":memory:");
    const bus = new EventBus(db);
    const btc = coin("BTC", { micro: { hiN: 99.8, loN: 98, volRatio: 1.5 } }, 100);
    const V = view([btc]);
    const feed = { view: () => V, lastRefreshAt: NOW } as never;
    const jev = new Jev({
      apiKey: "k", model: "m", timeoutMs: 2000, dailyUsdCap: 5, usdPerMTok: 0.042,
      client: { async systemOne(): Promise<never> { throw new Error("never"); } },
      now: () => NOW,
    });
    const exec = new SimExecutor(() => ({ tickers: V.tickers, instruments: V.instruments }), 0.0005, () => NOW);
    const engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts: new Alerts(undefined), now: () => NOW });
    // Even hour (NOW) → bee5 holds first pick on the single setup.
    engine.bees["bee5"] = { ...bee("scalpy"), id: "bee5" };
    type E = {
      decide(id: string, now: number): Promise<void>;
      order(id: string, decisionId: number, instId: string, side: "buy" | "sell", contracts: number, reduceOnly: boolean, purpose: string): Promise<boolean>;
    };
    const e = engine as unknown as E;
    const feed2 = { view: () => V, lastRefreshAt: NOW } as never;
    (engine as unknown as { d: { feed: unknown } }).d.feed = feed2;
    (engine as unknown as { now: () => number }).now = () => NOW;
    await e.decide("bee5", NOW);
    const pos = engine.bees["bee5"]!.position;
    expect(pos?.coin).toBe("BTC");
    const openDid = pos!.entryDecisionId;
    expect(openDid).toBeGreaterThan(0);
    // Close it all out under a fresh decision id.
    const closeDid = db.insertDecision({ bee: "bee5", ts: NOW, choice: "test", forcedBy: null, ...DEC });
    await e.order("bee5", closeDid, pos!.instId, "sell", pos!.contracts, true, "test_close");
    expect(engine.bees["bee5"]!.position).toBeNull();
    const fills = db.raw.prepare(`SELECT realised_usd AS r, entry_decision_id AS e FROM fills ORDER BY id`).all() as Array<{ r: number; e: number | null }>;
    const closes = fills.filter((f) => f.e !== null);
    expect(closes.length).toBeGreaterThan(0);
    expect(closes.every((f) => f.e === openDid)).toBe(true);
    const rows = db.closeAttribution();
    expect(rows.some((r) => r.bee === "bee5" && r.source === "rule")).toBe(true);
  });
});
