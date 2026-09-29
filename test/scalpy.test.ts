import { describe, expect, it } from "vitest";
import { microLevels } from "../src/market/data.js";
import type { Candle } from "../src/market/types.js";
import { takeProfitSignal } from "../src/risk.js";
import { MICRO_MAX_CHASE_BPS, MICRO_MIN_VOL_RATIO, microSetup, pickScalp, scalpy, SCALPY_TIME_STOP_MIN, thrustState } from "../src/bees/scalpy.js";
import { bee, coin, ctx, NOW, position, testConfig, view } from "./fixtures.js";

const candle = (h: number, l: number, vol: number, confirmed = true): Candle => ({ ts: 1, o: l, h, l, c: (h + l) / 2, volUsd: vol, confirmed });

describe("microLevels (15m Donchian + 24h volume median)", () => {
  it("takes the high/low over the last 20 confirmed bars, volume vs the 96-bar median", () => {
    const bars: Candle[] = [];
    for (let i = 0; i < 100; i++) bars.push(candle(100 + (i % 5), 99, 10));
    bars.push(candle(120, 119, 30)); // latest confirmed bar: hot volume, outside the channel window
    const m = microLevels(bars)!;
    expect(m.hiN).toBe(104);
    expect(m.loN).toBe(99);
    expect(m.volRatio).toBeCloseTo(3, 5);
  });
  it("ignores the forming (unconfirmed) bar for the channel", () => {
    const bars: Candle[] = [];
    for (let i = 0; i < 25; i++) bars.push(candle(100, 99, 10));
    bars.push(candle(150, 140, 500, false)); // forming spike: must not move the channel
    const m = microLevels(bars)!;
    expect(m.hiN).toBe(100);
  });
  it("null until 21 confirmed bars exist", () => {
    const bars: Candle[] = [];
    for (let i = 0; i < 20; i++) bars.push(candle(100, 99, 10));
    expect(microLevels(bars)).toBeNull();
  });
});

describe("microSetup (strict micro-long)", () => {
  const thru = (px: number, hiN: number, volRatio = 1.5) => coin("BTC", { micro: { hiN, loN: hiN - 2, volRatio } }, px);
  it("fires through the micro-high with volume", () => {
    expect(microSetup(thru(100, 99.8))).toMatchObject({ coin: "BTC" });
  });
  it("silent below the micro-high", () => {
    expect(microSetup(thru(99.7, 99.8))).toBeNull();
  });
  it(`silent under ${MICRO_MIN_VOL_RATIO}x median volume`, () => {
    expect(microSetup(thru(100, 99.8, 1.1))).toBeNull();
  });
  it(`chase guard: +${MICRO_MAX_CHASE_BPS}bp past the line is a missed break`, () => {
    const chased = thru(100.4, 99.8); // +0.60% = 60bp past
    expect(microSetup(chased)).toBeNull();
    const edge = thru(100.09, 99.8); // +0.29% = 29bp, inside
    expect(microSetup(edge)).not.toBeNull();
  });
  it("null without micro data", () => {
    expect(microSetup(coin("BTC", {}, 100))).toBeNull();
    expect(microSetup(coin("BTC", { micro: { hiN: 99, loN: 98, volRatio: null, formingHigh: null } }, 100))).toBeNull();
  });
});

describe("thrustState (wick-exhaustion tag, attribution only)", () => {
  const base = { hiN: 100, loN: 98, volRatio: 1.5 };
  it("fresh: no forming spike, or spike held", () => {
    expect(thrustState(coin("BTC", { micro: { ...base, formingHigh: null } }, 100.1))).toBeNull();
    expect(thrustState(coin("BTC", {}, 100.1))).toBeNull();
    // Spiked +10bp, still holding near the high: not exhausted.
    const held = thrustState(coin("BTC", { micro: { ...base, formingHigh: 100.1 } }, 100.09))!;
    expect(held.exhausted).toBe(false);
    expect(held.spikedBp).toBeCloseTo(10, 5);
  });
  it("exhausted: spiked ≥30bp and retraced >50% of the thrust", () => {
    // High printed +50bp over, touch sagged to +15bp: retraced 70%.
    const t = thrustState(coin("BTC", { micro: { ...base, formingHigh: 100.5 } }, 100.15))!;
    expect(t.spikedBp).toBeCloseTo(50, 5);
    expect(t.retracedFrac).toBeCloseTo(0.7, 5);
    expect(t.exhausted).toBe(true);
  });
  it("big spike mostly held is not exhausted", () => {
    const t = thrustState(coin("BTC", { micro: { ...base, formingHigh: 100.5 } }, 100.4))!;
    expect(t.retracedFrac).toBeCloseTo(0.2, 5);
    expect(t.exhausted).toBe(false);
  });
  it("menu labels the exhausted entry _XHT and takes it anyway (tag, not veto)", () => {
    // Odd UTC hour → Dash holds first pick.
    const odd = NOW + 3_600_000;
    const v = view([coin("BTC", { micro: { ...base, formingHigh: 100.5, volRatio: 1.5 } }, 100.15)]);
    const m = scalpy.menu(ctx("scalpy", bee("scalpy"), v, testConfig(), odd));
    expect(Object.keys(m)).toEqual(["SCALP_BTC_XHT"]);
    expect(m.SCALP_BTC_XHT!.intent).toMatchObject({ kind: "open", side: "long" });
    expect(m.SCALP_BTC_XHT!.desc).toContain("wick");
    const fresh = view([coin("ETH", { micro: { ...base, formingHigh: 100.1, volRatio: 1.5 } }, 100.09)]);
    expect(Object.keys(scalpy.menu(ctx("scalpy", bee("scalpy"), fresh, testConfig(), odd)))).toEqual(["SCALP_ETH"]);
  });
});

describe("scalpy menu (one setup, or nothing)", () => {
  const wide = { micro: { hiN: 99.8, loN: 98, volRatio: 1.5 } };
  it("flat with a trigger offers exactly one SCALP_<coin>, strict", () => {
    // Odd UTC hour → Dash holds first pick.
    const c = ctx("scalpy", bee("scalpy"), view([coin("BTC", wide, 100)]), testConfig(), NOW + 3_600_000);
    const m = scalpy.menu(c);
    expect(Object.keys(m)).toEqual(["SCALP_BTC"]);
    expect(m.SCALP_BTC!.intent).toMatchObject({ kind: "open", side: "long", setup: "strict" });
  });
  it("Dash and Zip split by rotating rank: never mirror, neither stuck with leftovers", () => {
    const v = view([
      coin("BTC", { micro: { hiN: 99.8, loN: 98, volRatio: 1.5 } }, 100), // +20bp
      coin("ETH", { micro: { hiN: 99.9, loN: 98, volRatio: 1.5 } }, 100), // +10bp
      coin("HYPE", { micro: { hiN: 99.95, loN: 98, volRatio: 9 } }, 100), // +5bp → freshest
      coin("SOL", { micro: { hiN: 99.9, loN: 98, volRatio: 9 } , spreadBp: 50 }, 100),
    ]);
    // NOW is 12:00 UTC (even hour → Zip first): Zip HYPE, Dash ETH.
    expect(Object.keys(scalpy.menu(ctx("scalpy", bee("bee5"), v)))).toEqual(["SCALP_HYPE"]);
    expect(Object.keys(scalpy.menu(ctx("scalpy", bee("scalpy"), v)))).toEqual(["SCALP_ETH"]);
    // Odd hour flips first pick: Dash HYPE, Zip ETH.
    const odd = NOW + 3_600_000;
    expect(Object.keys(scalpy.menu(ctx("scalpy", bee("bee5"), v, testConfig(), odd)))).toEqual(["SCALP_ETH"]);
    expect(Object.keys(scalpy.menu(ctx("scalpy", bee("scalpy"), v, testConfig(), odd)))).toEqual(["SCALP_HYPE"]);
    expect(pickScalp(ctx("scalpy", bee("scalpy"), v))?.coin).toBe("HYPE");
  });
  it("Zip fresh-only variant: skips exhausted thrusts, yields on deterministic collision", () => {
    // Gaps: HYPE +5bp (exhausted), ETH +10bp (fresh), BTC +20bp (fresh).
    const v = view([
      coin("BTC", { micro: { hiN: 99.8, loN: 98, volRatio: 1.5 } }, 100),
      coin("ETH", { micro: { hiN: 99.9, loN: 98, volRatio: 1.5 } }, 100),
      coin("HYPE", { micro: { hiN: 99.95, loN: 98, volRatio: 9, formingHigh: 100.5 } }, 100),
    ]);
    // NOW is an even hour (Zip first): Zip's fresh pool is [ETH, BTC], rank 0 = ETH;
    // Dash's full rank 1 = ETH too → collision → Zip yields, Dash takes ETH.
    expect(Object.keys(scalpy.menu(ctx("scalpy", bee("scalpy"), v)))).toEqual(["SCALP_ETH"]);
    expect(Object.keys(scalpy.menu(ctx("scalpy", bee("bee5"), v)))).toEqual([]);
    // Odd hour (Dash first): Dash rank 0 = HYPE_XHT, Zip fresh pool rank 1 = BTC.
    const odd = NOW + 3_600_000;
    expect(Object.keys(scalpy.menu(ctx("scalpy", bee("scalpy"), v, testConfig(), odd)))).toEqual(["SCALP_HYPE_XHT"]);
    expect(Object.keys(scalpy.menu(ctx("scalpy", bee("bee5"), v, testConfig(), odd)))).toEqual(["SCALP_BTC"]);
  });
  it("flat with no trigger = empty menu (nothing to ask Jev)", () => {
    const m = scalpy.menu(ctx("scalpy", bee("scalpy"), view([coin("BTC", wide, 99)])));
    expect(Object.keys(m)).toEqual([]);
  });
  it("positioned = empty menu (stop, ladder and time stop fire in code)", () => {
    const s = coin("BTC", wide, 100);
    const b = bee("scalpy", { position: position(s), flatSince: null });
    expect(Object.keys(scalpy.menu(ctx("scalpy", b, view([s]))))).toEqual([]);
  });
  it("waits for its setup: never forced, strict only, Jev never asked", () => {
    expect(scalpy.neverForce).toBe(true);
    expect(scalpy.requiresStrictSetup).toBe(true);
    expect(scalpy.ruleDriven).toBe(true);
    expect(scalpy.forcedEntry(ctx("scalpy", bee("scalpy"), view([coin("BTC", wide, 100)])))).toBeNull();
  });
  it("universe is the whole gated list with micro data inside the spread gate", () => {
    const v = view([
      coin("BTC", wide, 100),
      coin("HYPE", wide, 100),
      coin("SOL", { ...wide, spreadBp: 50 }, 100),
      coin("DOGE", {}, 1),
    ]);
    expect(scalpy.universe(ctx("scalpy", bee("scalpy"), v))).toEqual(["BTC-USD_UM_XPERP-310404", "HYPE-USD_UM_XPERP-310404"]);
  });
});

describe("scalpy sizing (0.5% risk, $5 fee-wall floor)", () => {
  const s = coin("BTC", { micro: { hiN: 99.8, loN: 98, volRatio: 1.5 }, atr14Pct: 2 }, 100);
  const open = (equity: number) => {
    const b = bee("scalpy");
    b.equityUsd = equity;
    return scalpy.sizeFrac({ kind: "open", instId: s.instId, side: "long", sizeFrac: 1, setup: "strict" }, 2, ctx("scalpy", b, view([s])));
  };
  it("floors dollar risk at $5 so the +1R target clears fees", () => {
    // $400 book, 1.5% stop distance: 0.5% risk would be $2 → floored to $5.
    // max = min(2*400*0.97, 700) = 700; frac = 5 / (0.015*700) ≈ 0.476.
    expect(open(400)).toBeCloseTo(0.476, 3);
  });
  it("0.5% rules above the floor", () => {
    // $2000 book: risk $10 → frac = 10 / (0.015*700) ≈ 0.952.
    expect(open(2000)).toBeCloseTo(0.952, 3);
  });
  it("hard stop at 0.75x ATR(15m)", () => {
    expect(scalpy.stopFor(s.instId, "long", 100, ctx("scalpy", bee("scalpy"), view([s])))).toBeCloseTo(98.5, 5);
  });
});

describe("scalpy exits (ladder + BE + 45m time stop)", () => {
  const pol = scalpy.takeProfit!;
  const mk = (over = {}) => ({ instId: "x", coin: "X", side: "long" as const, contracts: 100, entryPx: 100, openedAt: 0, stopPx: null, riskUsd: 10, trimmedAtR: null, beMoved: false, lastLadderR: null, ...over });
  it("BE at +0.3R without waiting for a trim", () => {
    const sig = takeProfitSignal(mk(), 0.3, pol)!;
    expect(sig.moveStopToBe).toBe(true);
    expect(sig.trim).toBeUndefined();
  });
  it("trim half at +0.4R, close the rest at +0.8R (= $3 on $5 risk)", () => {
    expect(takeProfitSignal(mk(), 0.4, pol)?.trim).toEqual({ fraction: 0.5 });
    expect(takeProfitSignal(mk({ trimmedAtR: 0.4, beMoved: true }), 0.8, pol)?.trim).toEqual({ fraction: 1.0, ladder: true });
  });
  it("time stop is 45 minutes", () => {
    expect(scalpy.timeStopMinutes!(ctx("scalpy", bee("scalpy"), view([])))).toBe(SCALPY_TIME_STOP_MIN);
    expect(SCALPY_TIME_STOP_MIN).toBe(45);
  });
});

describe("scalpy status (idle lines, no Jev spend)", () => {
  const wide = { micro: { hiN: 99.8, loN: 98, volRatio: 1.5 } };
  it("flat status names the nearest micro-high; detail carries the watched price", () => {
    const c = ctx("scalpy", bee("scalpy"), view([coin("BTC", wide, 99)]));
    expect(scalpy.idleStatus!(c)).toBe("BTC is 0.81% from its micro-high");
    expect(scalpy.idleDetail!(c)).toMatchObject({ label: "Micro-break", coin: "BTC", midPx: 99 });
  });
  it("positioned status names the ride; no proximity bar while holding", () => {
    const s = coin("BTC", wide, 100);
    const b = bee("scalpy", { position: position(s), flatSince: null, uplUsd: 4 });
    b.position!.riskUsd = 10;
    const c = { ...ctx("scalpy", b, view([s])), uplR: 0.4 };
    expect(scalpy.idleStatus!(c)).toContain("riding SCALP_BTC");
    expect(scalpy.idleDetail!(c)).toBeNull();
  });
});

describe("ruleDriven decide: the code takes the setup, Jev is never called", () => {
  async function scalpyHarness(px: number, slot: "bee4" | "bee5" = "bee4", now = NOW) {
    const { Db } = await import("../src/db.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Engine } = await import("../src/engine.js");
    const { Jev } = await import("../src/jev.js");
    const { Alerts } = await import("../src/alerts.js");
    // The live style is retired (cap 0); the harness lifts it to test the frozen mechanics.
    const cfg = testConfig({ SCALPY_MAX_TRADES_PER_DAY: "80" });
    const db = new Db(":memory:");
    const bus = new EventBus(db);
    const btc = coin("BTC", { micro: { hiN: 99.8, loN: 98, volRatio: 1.5 } }, px);
    const V = view([btc]);
    const feed = { view: () => V, lastRefreshAt: now } as never;
    const jev = new Jev({
      apiKey: "k", model: "m", timeoutMs: 2000, dailyUsdCap: 5, usdPerMTok: 0.042,
      client: { async systemOne(): Promise<never> { throw new Error("Jev must never be asked for a rule-driven bee"); } },
      now: () => now,
    });
    const exec = new SimExecutor(() => ({ tickers: V.tickers, instruments: V.instruments }), 0.0005, () => now);
    const engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts: new Alerts(undefined), now: () => now });
    engine.bees[slot] = { ...bee("scalpy"), id: slot };
    type E = { decide(id: string, now: number): Promise<void>; jevMade: Record<string, number>; last: Record<string, { status: string; choice: string | null }> };
    const e = engine as unknown as E;
    return { decide: (t: number) => e.decide(slot, t), made: () => e.jevMade[slot] ?? 0, status: () => e.last[slot]?.status ?? "", choice: () => e.last[slot]?.choice ?? null, engine, jev };
  }
  it("opens SCALP_BTC with zero Jev calls", async () => {
    // Odd UTC hour → bee4 holds first pick on the single setup.
    const odd = NOW + 3_600_000;
    const { decide, made, status, choice, engine } = await scalpyHarness(100, "bee4", odd);
    await decide(odd);
    expect(made()).toBe(0);
    expect(engine.bees["bee4"]!.position?.coin).toBe("BTC");
    expect(status()).toContain("SCALP_BTC");
    expect(choice()).toBe("SCALP_BTC"); // takes record their setup (Setups scoreboard counts picks)
  });
  it("flat with no trigger: zero Jev calls, status watches the micro-high", async () => {
    const { decide, made, status, engine } = await scalpyHarness(99);
    await decide(NOW);
    expect(made()).toBe(0);
    expect(engine.bees["bee4"]!.position).toBeNull();
    expect(status()).toContain("micro-high");
  });
  it("bee5 (Zip) trades the same playbook on its own book", async () => {
    const { decide, made, status, engine } = await scalpyHarness(100, "bee5");
    await decide(NOW);
    expect(made()).toBe(0);
    expect(engine.bees["bee5"]!.position?.coin).toBe("BTC");
    expect(status()).toContain("SCALP_BTC");
  });
  it("a tripped Jev spend cap does not veto rule-driven bees (they spend $0)", async () => {
    const odd = NOW + 3_600_000;
    const h = await scalpyHarness(100, "bee4", odd);
    Object.defineProperty(h.jev, "capTripped", { value: true, configurable: true });
    await h.decide(odd);
    expect(h.made()).toBe(0);
    expect(h.engine.bees["bee4"]!.position?.coin).toBe("BTC");
    expect(h.status()).not.toMatch(/daily cap/);
  });
});
