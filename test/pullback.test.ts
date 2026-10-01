import { describe, expect, it } from "vitest";
import { takeProfitSignal } from "../src/risk.js";
import { pullback, PULLBACK_TIME_STOP_MIN, pullbackSetup, rankPullbacks } from "../src/bees/pullback.js";
import { bee, coin, ctx, NOW, position, testConfig, trend, view } from "./fixtures.js";

const uptrend = { ret7dPct: 12, ret1hPct: -0.3, fundingZ: 0.5 };
const downtrend = { ret7dPct: -12, ret1hPct: 0.3, fundingZ: -0.5 };

describe("pullbackSetup (mild dip inside established trend, never extremes)", () => {
  it("longs the dip: +8% week, RSI 30-42, inside lower band slice, uncrowded", () => {
    expect(pullbackSetup(coin("BTC", { ...uptrend, rsi14: 36, pctB: 0.1 }))).toMatchObject({ coin: "BTC", side: "long" });
  });
  it("shorts the rally fade: -8% week, RSI 58-70, upper band slice, uncrowded", () => {
    expect(pullbackSetup(coin("BTC", { ...downtrend, rsi14: 64, pctB: 0.9 }))).toMatchObject({ coin: "BTC", side: "short" });
  });
  it("no trend, no trade (both directions)", () => {
    expect(pullbackSetup(coin("BTC", { rsi14: 36, pctB: 0.1, ret7dPct: 5, ret1hPct: 0, fundingZ: 0 }))).toBeNull();
    expect(pullbackSetup(coin("BTC", { rsi14: 64, pctB: 0.9, ret7dPct: -5, ret1hPct: 0, fundingZ: 0 }))).toBeNull();
  });
  it("RSI outside the dip window is not a dip (too cold = Echo's territory, too warm = strength)", () => {
    expect(pullbackSetup(coin("BTC", { ...uptrend, rsi14: 25, pctB: 0.1 }))).toBeNull();
    expect(pullbackSetup(coin("BTC", { ...uptrend, rsi14: 50, pctB: 0.1 }))).toBeNull();
  });
  it("outside the band slice is not a dip (Echo's territory)", () => {
    expect(pullbackSetup(coin("BTC", { ...uptrend, rsi14: 36, pctB: 0.5 }))).toBeNull();
    expect(pullbackSetup(coin("BTC", { ...uptrend, rsi14: 36, pctB: -0.1 }))).toBeNull();
  });
  it("crowded funding vetoes (mirror of Rook: this style needs UNCROWDED)", () => {
    expect(pullbackSetup(coin("BTC", { ...uptrend, rsi14: 36, pctB: 0.1, fundingZ: 1.5 }))).toBeNull();
    expect(pullbackSetup(coin("BTC", { ...downtrend, rsi14: 64, pctB: 0.9, fundingZ: -1.5 }))).toBeNull();
  });
  it("mid-dump/mid-pump on the 1h is a knife, not a dip", () => {
    expect(pullbackSetup(coin("BTC", { ...uptrend, rsi14: 36, pctB: 0.1, ret1hPct: -2 }))).toBeNull();
    expect(pullbackSetup(coin("BTC", { ...downtrend, rsi14: 64, pctB: 0.9, ret1hPct: 2 }))).toBeNull();
  });
  it("trend.confirm knocks out weak alignment where present", () => {
    const weak = coin("BTC", { ...uptrend, rsi14: 36, pctB: 0.1, trend: trend({ score: 1 }) }, 100);
    expect(pullbackSetup(weak)).toBeNull();
    const strong = coin("BTC", { ...uptrend, rsi14: 36, pctB: 0.1, trend: trend({ score: 5 }) }, 100);
    expect(pullbackSetup(strong)).toMatchObject({ side: "long" });
  });
  it("null without 7d/1h data", () => {
    expect(pullbackSetup(coin("BTC", { rsi14: 36, pctB: 0.1, ret7dPct: null, ret1hPct: 0 }))).toBeNull();
    expect(pullbackSetup(coin("BTC", {}, 100))).toBeNull();
  });
});

describe("pullback menu (strongest trend-dip, or nothing)", () => {
  it("flat with a dip offers one PULLBACK_LONG_<coin>, strict", () => {
    const m = pullback.menu(ctx("pullback", bee("pullback"), view([coin("BTC", { ...uptrend, rsi14: 36, pctB: 0.1 }, 100)])));
    expect(Object.keys(m)).toEqual(["PULLBACK_LONG_BTC"]);
    expect(m.PULLBACK_LONG_BTC!.intent).toMatchObject({ kind: "open", side: "long", setup: "strict" });
  });
  it("strongest |7d| wins across sides", () => {
    const v = view([
      coin("BTC", { ...uptrend, rsi14: 36, pctB: 0.1 }, 100), // |12|
      coin("ETH", { ...downtrend, ret7dPct: -20, rsi14: 64, pctB: 0.9 }, 100), // |20| → wins
    ]);
    expect(Object.keys(pullback.menu(ctx("pullback", bee("pullback"), v)))).toEqual(["PULLBACK_SHORT_ETH"]);
    expect(rankPullbacks(ctx("pullback", bee("pullback"), v)).map((f) => f.coin)).toEqual(["ETH", "BTC"]);
  });
  it("flat with no dip = empty menu; positioned = empty menu", () => {
    expect(Object.keys(pullback.menu(ctx("pullback", bee("pullback"), view([coin("BTC", { rsi14: 50, pctB: 0.5, ret7dPct: 3, ret1hPct: 0 }, 100)]))))).toEqual([]);
    const s = coin("BTC", { ...uptrend, rsi14: 36, pctB: 0.1 }, 100);
    const b = bee("pullback", { position: position(s), flatSince: null });
    expect(Object.keys(pullback.menu(ctx("pullback", b, view([s]))))).toEqual([]);
  });
  it("waits for dips: never forced, strict only, Jev never asked", () => {
    expect(pullback.neverForce).toBe(true);
    expect(pullback.requiresStrictSetup).toBe(true);
    expect(pullback.ruleDriven).toBe(true);
    expect(pullback.forcedEntry(ctx("pullback", bee("pullback"), view([])))).toBeNull();
  });
});

describe("pullback sizing (1% risk, 80bp stop floor, no dollar floor)", () => {
  const s = coin("BTC", { ...uptrend, rsi14: 36, pctB: 0.1, atr14Pct: 2 }, 100);
  const size = (equity: number) => {
    const b = bee("pullback");
    b.equityUsd = equity;
    return pullback.sizeFrac({ kind: "open", instId: s.instId, side: "long", sizeFrac: 1, setup: "strict" }, 2, ctx("pullback", b, view([s])));
  };
  it("risks 1% with no floor", () => {
    // $333 book, 4% stop distance (2 x 2% ATR): risk $3.33.
    // max = min(2*333*0.97, 700) = 646.02; frac = 3.33/(0.04*646.02) ≈ 0.129.
    expect(size(333)).toBeCloseTo(0.129, 3);
  });
  it("stop honors the 80bp floor even when ATR is tiny", () => {
    const calm = coin("BTC", { ...uptrend, rsi14: 36, pctB: 0.1, atr14Pct: 0.1 }, 100);
    const c = ctx("pullback", bee("pullback"), view([calm]));
    // 2 x 0.1% ATR = 0.2% < 80bp floor → stop a full 0.8% away.
    expect(pullback.stopFor(calm.instId, "long", 100, c)).toBeCloseTo(99.2, 5);
    expect(pullback.stopFor(calm.instId, "short", 100, c)).toBeCloseTo(100.8, 5);
  });
  it("wide ATR uses 2x ATR", () => {
    const c = ctx("pullback", bee("pullback"), view([s]));
    expect(pullback.stopFor(s.instId, "long", 100, c)).toBeCloseTo(96, 5);
  });
});

describe("pullback exits (single +2R, BE +1R, 12h time stop)", () => {
  const pol = pullback.takeProfit!;
  const mk = (over = {}) => ({ instId: "x", coin: "X", side: "long" as const, contracts: 100, entryPx: 100, openedAt: 0, stopPx: null, riskUsd: 10, trimmedAtR: null, beMoved: false, lastLadderR: null, ...over });
  it("BE at +1R without waiting for a trim", () => {
    const sig = takeProfitSignal(mk(), 1, pol)!;
    expect(sig.moveStopToBe).toBe(true);
    expect(sig.trim).toBeUndefined();
  });
  it("single full exit at +2R", () => {
    expect(takeProfitSignal(mk(), 2, pol)?.trim).toEqual({ fraction: 1.0 });
  });
  it("time stop is 12 hours", () => {
    expect(pullback.timeStopMinutes!(ctx("pullback", bee("pullback"), view([])))).toBe(PULLBACK_TIME_STOP_MIN);
    expect(PULLBACK_TIME_STOP_MIN).toBe(720);
  });
});

describe("ruleDriven decide: Ash takes the dip with zero Jev calls", () => {
  async function pullbackHarness() {
    const { Db } = await import("../src/db.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Engine } = await import("../src/engine.js");
    const { Jev } = await import("../src/jev.js");
    const { Alerts } = await import("../src/alerts.js");
    const cfg = testConfig();
    const db = new Db(":memory:");
    const bus = new EventBus(db);
    const btc = coin("BTC", { ...uptrend, rsi14: 36, pctB: 0.1 }, 100);
    const V = view([btc]);
    const feed = { view: () => V, lastRefreshAt: NOW } as never;
    const jev = new Jev({
      apiKey: "k", model: "m", timeoutMs: 2000, dailyUsdCap: 5, usdPerMTok: 0.042,
      client: { async systemOne(): Promise<never> { throw new Error("Jev must never be asked for a rule-driven bee"); } },
      now: () => NOW,
    });
    const exec = new SimExecutor(() => ({ tickers: V.tickers, instruments: V.instruments }), 0.0005, () => NOW);
    const engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts: new Alerts(undefined), now: () => NOW });
    engine.bees["bee4"] = { ...bee("pullback"), id: "bee4" };
    type E = { decide(id: string, now: number): Promise<void>; jevMade: Record<string, number>; last: Record<string, { status: string; choice: string | null }> };
    const e = engine as unknown as E;
    return { decide: (t: number) => e.decide("bee4", t), made: () => e.jevMade["bee4"] ?? 0, status: () => e.last["bee4"]?.status ?? "", choice: () => e.last["bee4"]?.choice ?? null, engine };
  }
  it("opens PULLBACK_LONG_BTC with zero Jev calls", async () => {
    const { decide, made, status, choice, engine } = await pullbackHarness();
    await decide(NOW);
    expect(made()).toBe(0);
    expect(engine.bees["bee4"]!.position).toMatchObject({ coin: "BTC", side: "long" });
    expect(status()).toContain("PULLBACK_LONG_BTC");
    expect(choice()).toBe("PULLBACK_LONG_BTC");
  });
});
