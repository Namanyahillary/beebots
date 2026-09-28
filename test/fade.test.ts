import { describe, expect, it } from "vitest";
import { takeProfitSignal } from "../src/risk.js";
import { fade, FADE_MIN_EXT_PCT, FADE_MIN_FUNDING_Z, FADE_TIME_STOP_MIN, fadeSetup, rankFades } from "../src/bees/fade.js";
import { bee, coin, ctx, NOW, position, testConfig, view } from "./fixtures.js";

describe("fadeSetup (crowded positioning only, never strength)", () => {
  it("shorts crowded longs: fundingZ ≥ +2 into a +8% day", () => {
    expect(fadeSetup(coin("BTC", { fundingZ: 2.5, ret24hPct: 12 }))).toMatchObject({ coin: "BTC", side: "short" });
  });
  it("longs washed-out shorts: fundingZ ≤ -2 into a -8% washout", () => {
    expect(fadeSetup(coin("BTC", { fundingZ: -2.3, ret24hPct: -10 }))).toMatchObject({ coin: "BTC", side: "long" });
  });
  it("extreme funding WITHOUT extension is strength, not exhaustion — no fade", () => {
    expect(fadeSetup(coin("BTC", { fundingZ: 3.0, ret24hPct: 4 }))).toBeNull();
    expect(fadeSetup(coin("BTC", { fundingZ: -3.0, ret24hPct: -4 }))).toBeNull();
  });
  it("extension WITHOUT crowding is momentum, not exhaustion — no fade", () => {
    expect(fadeSetup(coin("BTC", { fundingZ: 1.5, ret24hPct: 15 }))).toBeNull();
    expect(fadeSetup(coin("BTC", { fundingZ: -1.5, ret24hPct: -15 }))).toBeNull();
  });
  it("never fades the prevailing crowd sideways (wrong-sign combos)", () => {
    // Crowded longs into a SELLoff is deleveraging, not exhaustion.
    expect(fadeSetup(coin("BTC", { fundingZ: 2.5, ret24hPct: -9 }))).toBeNull();
    expect(fadeSetup(coin("BTC", { fundingZ: -2.5, ret24hPct: 9 }))).toBeNull();
  });
  it("null without funding or 24h data (never trades blind, never touches OI)", () => {
    expect(fadeSetup(coin("BTC", { fundingZ: null, ret24hPct: 12 }))).toBeNull();
    expect(fadeSetup(coin("BTC", { fundingZ: 2.5, ret24hPct: null }))).toBeNull();
    expect(fadeSetup(coin("BTC", {}, 100))).toBeNull();
  });
  it("boundary bars hold: exactly ±2.0 and ±8% qualify", () => {
    expect(fadeSetup(coin("BTC", { fundingZ: FADE_MIN_FUNDING_Z, ret24hPct: FADE_MIN_EXT_PCT }))?.side).toBe("short");
    expect(fadeSetup(coin("BTC", { fundingZ: -FADE_MIN_FUNDING_Z, ret24hPct: -FADE_MIN_EXT_PCT }))?.side).toBe("long");
    expect(fadeSetup(coin("BTC", { fundingZ: 1.99, ret24hPct: 20 }))).toBeNull();
  });
});

describe("fade menu (most crowded setup, or nothing)", () => {
  const crowd = { fundingZ: 2.8, ret24hPct: 14 };
  const calmer = { fundingZ: 2.1, ret24hPct: 9 };
  it("flat with a crowd offers one FADE_<SIDE>_<coin>, strict", () => {
    const m = fade.menu(ctx("fade", bee("fade"), view([coin("BTC", crowd, 100)])));
    expect(Object.keys(m)).toEqual(["FADE_SHORT_BTC"]);
    expect(m.FADE_SHORT_BTC!.intent).toMatchObject({ kind: "open", side: "short", setup: "strict" });
    const l = fade.menu(ctx("fade", bee("fade"), view([coin("BTC", { fundingZ: -2.8, ret24hPct: -14 }, 100)])));
    expect(Object.keys(l)).toEqual(["FADE_LONG_BTC"]);
  });
  it("most crowded (|funding z|) wins when several qualify", () => {
    const v = view([coin("BTC", calmer, 100), coin("ETH", crowd, 100)]);
    expect(Object.keys(fade.menu(ctx("fade", bee("fade"), v)))).toEqual(["FADE_SHORT_ETH"]);
    expect(rankFades(ctx("fade", bee("fade"), v)).map((f) => f.coin)).toEqual(["ETH", "BTC"]);
  });
  it("flat with no crowd = empty menu (nothing to ask Jev)", () => {
    expect(Object.keys(fade.menu(ctx("fade", bee("fade"), view([coin("BTC", { fundingZ: 0.5, ret24hPct: 3 }, 100)]))))).toEqual([]);
  });
  it("positioned = empty menu (stop, ladder and time stop fire in code)", () => {
    const s = coin("BTC", crowd, 100);
    const b = bee("fade", { position: position(s, { side: "short" }), flatSince: null });
    expect(Object.keys(fade.menu(ctx("fade", b, view([s]))))).toEqual([]);
  });
  it("waits for extremes: never forced, strict only, Jev never asked", () => {
    expect(fade.neverForce).toBe(true);
    expect(fade.requiresStrictSetup).toBe(true);
    expect(fade.ruleDriven).toBe(true);
    expect(fade.forcedEntry(ctx("fade", bee("fade"), view([coin("BTC", crowd, 100)])))).toBeNull();
  });
});

describe("fade sizing (1% risk, wide 2x ATR stop, no dollar floor)", () => {
  const s = coin("BTC", { fundingZ: 2.8, ret24hPct: 14, atr14Pct: 2 }, 100);
  const size = (equity: number) => {
    const b = bee("fade");
    b.equityUsd = equity;
    return fade.sizeFrac({ kind: "open", instId: s.instId, side: "short", sizeFrac: 1, setup: "strict" }, 2, ctx("fade", b, view([s])));
  };
  it("risks 1% with no $5 floor (rare wide stops, not high-frequency)", () => {
    // $333 book, 4% stop distance (2 x 2% ATR): risk $3.33.
    // max = min(2*333*0.97, 700) = 645.9; frac = 3.33/(0.04*645.9) ≈ 0.129.
    expect(size(333)).toBeCloseTo(0.129, 3);
    // Small book proves no floor: $100 book risks $1, not $5.
    // max = min(194, 700) = 194; frac = 1/(0.04*194) ≈ 0.129.
    expect(size(100)).toBeCloseTo(0.129, 3);
  });
  it("hard stop at 2x ATR(15m)", () => {
    expect(fade.stopFor(s.instId, "short", 100, ctx("fade", bee("fade"), view([s])))).toBeCloseTo(104, 5);
    expect(fade.stopFor(s.instId, "long", 100, ctx("fade", bee("fade"), view([s])))).toBeCloseTo(96, 5);
  });
});

describe("fade exits (trim +1R, out +2R, BE +0.75R, 6h time stop)", () => {
  const pol = fade.takeProfit!;
  const mk = (over = {}) => ({ instId: "x", coin: "X", side: "short" as const, contracts: 100, entryPx: 100, openedAt: 0, stopPx: null, riskUsd: 10, trimmedAtR: null, beMoved: false, lastLadderR: null, ...over });
  it("BE at +0.75R without waiting for a trim", () => {
    const sig = takeProfitSignal(mk(), 0.75, pol)!;
    expect(sig.moveStopToBe).toBe(true);
    expect(sig.trim).toBeUndefined();
  });
  it("trim half at +1R, close the rest at +2R", () => {
    expect(takeProfitSignal(mk(), 1, pol)?.trim).toEqual({ fraction: 0.5 });
    expect(takeProfitSignal(mk({ trimmedAtR: 1, beMoved: true }), 2, pol)?.trim).toEqual({ fraction: 1.0, ladder: true });
  });
  it("time stop is 6 hours", () => {
    expect(fade.timeStopMinutes!(ctx("fade", bee("fade"), view([])))).toBe(FADE_TIME_STOP_MIN);
    expect(FADE_TIME_STOP_MIN).toBe(360);
  });
});

describe("fade status (idle lines, no Jev spend)", () => {
  it("flat status names the nearest crowd and what is missing", () => {
    const c = ctx("fade", bee("fade"), view([coin("BTC", { fundingZ: 0.5, ret24hPct: 3 }, 99)]));
    expect(fade.idleStatus!(c)).toBe("BTC: funding not crowded yet");
    expect(fade.idleDetail!(c)).toMatchObject({ label: "Watching the crowd", coin: "BTC", midPx: 99 });
  });
  it("positioned status names the fade; no proximity bar while holding", () => {
    const s = coin("BTC", { fundingZ: 2.8, ret24hPct: 14 }, 100);
    const b = bee("fade", { position: position(s, { side: "short" }), flatSince: null, uplUsd: 5 });
    b.position!.riskUsd = 10;
    const c = { ...ctx("fade", b, view([s])), uplR: 0.5 };
    expect(fade.idleStatus!(c)).toContain("fading BTC short");
    expect(fade.idleDetail!(c)).toBeNull();
  });
});

describe("ruleDriven decide: Rook takes the fade with zero Jev calls", () => {
  async function fadeHarness() {
    const { Db } = await import("../src/db.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Engine } = await import("../src/engine.js");
    const { Jev } = await import("../src/jev.js");
    const { Alerts } = await import("../src/alerts.js");
    const cfg = testConfig();
    const db = new Db(":memory:");
    const bus = new EventBus(db);
    const btc = coin("BTC", { fundingZ: 2.8, ret24hPct: 14 }, 100);
    const V = view([btc]);
    const feed = { view: () => V, lastRefreshAt: NOW } as never;
    const jev = new Jev({
      apiKey: "k", model: "m", timeoutMs: 2000, dailyUsdCap: 5, usdPerMTok: 0.042,
      client: { async systemOne(): Promise<never> { throw new Error("Jev must never be asked for a rule-driven bee"); } },
      now: () => NOW,
    });
    const exec = new SimExecutor(() => ({ tickers: V.tickers, instruments: V.instruments }), 0.0005, () => NOW);
    const engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts: new Alerts(undefined), now: () => NOW });
    engine.bees["bee6"] = { ...bee("fade"), id: "bee6" };
    type E = { decide(id: string, now: number): Promise<void>; jevMade: Record<string, number>; last: Record<string, { status: string }> };
    const e = engine as unknown as E;
    return { decide: (t: number) => e.decide("bee6", t), made: () => e.jevMade["bee6"] ?? 0, status: () => e.last["bee6"]?.status ?? "", engine };
  }
  it("shorts the crowded long with zero Jev calls", async () => {
    const { decide, made, status, engine } = await fadeHarness();
    await decide(NOW);
    expect(made()).toBe(0);
    expect(engine.bees["bee6"]!.position).toMatchObject({ coin: "BTC", side: "short" });
    expect(status()).toContain("FADE_SHORT_BTC");
  });
});
