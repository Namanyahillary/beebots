import { describe, expect, it } from "vitest";
import { takeProfitSignal } from "../src/risk.js";
import { bounce, BOUNCE_TIME_STOP_MIN, rankBounces } from "../src/bees/bounce.js";
import { bee, coin, ctx, NOW, position, testConfig, view } from "./fixtures.js";

describe("bounce setups (strict statistical extremes, reused Z1 logic)", () => {
  it("longs the stretched selloff: RSI under 30 AND outside the lower band", () => {
    const m = bounce.menu(ctx("bounce", bee("bounce"), view([coin("BTC", { rsi14: 25, pctB: -0.2 }, 100)])));
    expect(Object.keys(m)).toEqual(["BOUNCE_LONG_BTC"]);
    expect(m.BOUNCE_LONG_BTC!.intent).toMatchObject({ kind: "open", side: "long", setup: "strict" });
  });
  it("shorts the stretched rally: RSI over 70 AND above the upper band", () => {
    const m = bounce.menu(ctx("bounce", bee("bounce"), view([coin("BTC", { rsi14: 75, pctB: 1.2 }, 100)])));
    expect(Object.keys(m)).toEqual(["BOUNCE_SHORT_BTC"]);
  });
  it("half a setup is no setup (both gates must hold)", () => {
    expect(Object.keys(bounce.menu(ctx("bounce", bee("bounce"), view([coin("BTC", { rsi14: 25, pctB: 0.3 }, 100)]))))).toEqual([]);
    expect(Object.keys(bounce.menu(ctx("bounce", bee("bounce"), view([coin("BTC", { rsi14: 40, pctB: -0.2 }, 100)]))))).toEqual([]);
  });
  it("never longs into crowded longs (funding veto rides along from Z1)", () => {
    const v = view([coin("BTC", { rsi14: 25, pctB: -0.2, fundingZ: 1.6 }, 100)]);
    expect(Object.keys(bounce.menu(ctx("bounce", bee("bounce"), v)))).toEqual([]);
  });
  it("most stretched ranks first", () => {
    const v = view([
      coin("BTC", { rsi14: 28, pctB: -0.1 }, 100),
      coin("ETH", { rsi14: 20, pctB: -0.5 }, 100),
    ]);
    expect(rankBounces(ctx("bounce", bee("bounce"), v)).map((f) => f.coin)).toEqual(["ETH", "BTC"]);
    expect(Object.keys(bounce.menu(ctx("bounce", bee("bounce"), v)))).toEqual(["BOUNCE_LONG_ETH"]);
  });
  it("flat with no stretch = empty menu; positioned = empty menu", () => {
    expect(Object.keys(bounce.menu(ctx("bounce", bee("bounce"), view([coin("BTC", { rsi14: 50, pctB: 0.5 }, 100)]))))).toEqual([]);
    const s = coin("BTC", { rsi14: 25, pctB: -0.2 }, 100);
    const b = bee("bounce", { position: position(s), flatSince: null });
    expect(Object.keys(bounce.menu(ctx("bounce", b, view([s]))))).toEqual([]);
  });
  it("waits for extremes: never forced, strict only, Jev never asked", () => {
    expect(bounce.neverForce).toBe(true);
    expect(bounce.requiresStrictSetup).toBe(true);
    expect(bounce.ruleDriven).toBe(true);
    expect(bounce.forcedEntry(ctx("bounce", bee("bounce"), view([])))).toBeNull();
  });
});

describe("bounce sizing (1% risk, no dollar floor)", () => {
  const s = coin("BTC", { rsi14: 25, pctB: -0.2, atr14Pct: 2 }, 100);
  const size = (equity: number) => {
    const b = bee("bounce");
    b.equityUsd = equity;
    return bounce.sizeFrac({ kind: "open", instId: s.instId, side: "long", sizeFrac: 1, setup: "strict" }, 2, ctx("bounce", b, view([s])));
  };
  it("risks 1% with no floor", () => {
    // $333 book, 3% stop distance (1.5 x 2% ATR): risk $3.33.
    // max = min(2*333*0.97, 700) = 645.9; frac = 3.33/(0.03*645.9) ≈ 0.172.
    expect(size(333)).toBeCloseTo(0.172, 3);
  });
  it("hard stop at 1.5x ATR(15m)", () => {
    expect(bounce.stopFor(s.instId, "long", 100, ctx("bounce", bee("bounce"), view([s])))).toBeCloseTo(97, 5);
    expect(bounce.stopFor(s.instId, "short", 100, ctx("bounce", bee("bounce"), view([s])))).toBeCloseTo(103, 5);
  });
});

describe("bounce exits (trim +1R, out +2R, BE +0.75R, 8h time stop)", () => {
  const pol = bounce.takeProfit!;
  const mk = (over = {}) => ({ instId: "x", coin: "X", side: "long" as const, contracts: 100, entryPx: 100, openedAt: 0, stopPx: null, riskUsd: 10, trimmedAtR: null, beMoved: false, lastLadderR: null, ...over });
  it("BE at +0.75R without waiting for a trim", () => {
    const sig = takeProfitSignal(mk(), 0.75, pol)!;
    expect(sig.moveStopToBe).toBe(true);
    expect(sig.trim).toBeUndefined();
  });
  it("trim half at +1R, close the rest at +2R", () => {
    expect(takeProfitSignal(mk(), 1, pol)?.trim).toEqual({ fraction: 0.5 });
    expect(takeProfitSignal(mk({ trimmedAtR: 1, beMoved: true }), 2, pol)?.trim).toEqual({ fraction: 1.0, ladder: true });
  });
  it("time stop is 8 hours", () => {
    expect(bounce.timeStopMinutes!(ctx("bounce", bee("bounce"), view([])))).toBe(BOUNCE_TIME_STOP_MIN);
    expect(BOUNCE_TIME_STOP_MIN).toBe(480);
  });
});

describe("bounce status (idle lines, no Jev spend)", () => {
  it("flat status names the nearest stretch", () => {
    const c = ctx("bounce", bee("bounce"), view([coin("BTC", { rsi14: 45, pctB: 0.5 }, 99)]));
    expect(bounce.idleStatus!(c)).toBe("BTC: RSI 45 (long trigger < 30)");
    expect(bounce.idleDetail!(c)).toMatchObject({ label: "Waiting for the snap-back", coin: "BTC", midPx: 99 });
  });
});

describe("ruleDriven decide: Echo takes the revert with zero Jev calls", () => {
  async function bounceHarness() {
    const { Db } = await import("../src/db.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Engine } = await import("../src/engine.js");
    const { Jev } = await import("../src/jev.js");
    const { Alerts } = await import("../src/alerts.js");
    const cfg = testConfig();
    const db = new Db(":memory:");
    const bus = new EventBus(db);
    const btc = coin("BTC", { rsi14: 25, pctB: -0.2 }, 100);
    const V = view([btc]);
    const feed = { view: () => V, lastRefreshAt: NOW } as never;
    const jev = new Jev({
      apiKey: "k", model: "m", timeoutMs: 2000, dailyUsdCap: 5, usdPerMTok: 0.042,
      client: { async systemOne(): Promise<never> { throw new Error("Jev must never be asked for a rule-driven bee"); } },
      now: () => NOW,
    });
    const exec = new SimExecutor(() => ({ tickers: V.tickers, instruments: V.instruments }), 0.0005, () => NOW);
    const engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts: new Alerts(undefined), now: () => NOW });
    engine.bees["bee7"] = { ...bee("bounce"), id: "bee7" };
    type E = { decide(id: string, now: number): Promise<void>; jevMade: Record<string, number>; last: Record<string, { status: string; choice: string | null }> };
    const e = engine as unknown as E;
    return { decide: (t: number) => e.decide("bee7", t), made: () => e.jevMade["bee7"] ?? 0, status: () => e.last["bee7"]?.status ?? "", choice: () => e.last["bee7"]?.choice ?? null, engine };
  }
  it("longs the stretched selloff with zero Jev calls", async () => {
    const { decide, made, status, choice, engine } = await bounceHarness();
    await decide(NOW);
    expect(made()).toBe(0);
    expect(engine.bees["bee7"]!.position).toMatchObject({ coin: "BTC", side: "long" });
    expect(status()).toContain("BOUNCE_LONG_BTC");
    expect(choice()).toBe("BOUNCE_LONG_BTC");
  });
});
