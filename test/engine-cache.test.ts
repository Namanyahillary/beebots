// profit-mode: Jev answer reuse, ghost benchmark, TP/BE math, aggregate monitor.
import { describe, expect, it } from "vitest";
import { breezy } from "../src/bees/breezy.js";
import type { Menu } from "../src/bees/types.js";
import {
  aggregateExposure,
  breakevenStopPx,
  cacheReusable,
  ghostPick,
  menuHashFor,
  posKeyFor,
  stateHashFor,
  topIdFor,
  type CacheNow,
  type JevCacheEntry,
} from "../src/engine.js";
import { bee, coin, ctx, NOW, position, testConfig, trend, view } from "./fixtures.js";

const SOL = coin("SOL");
const BTC = coin("BTC", { trend: trend({ score: 5 }) }, 80000);
const V = view([SOL, BTC]);

function entry(over: Partial<JevCacheEntry> = {}): JevCacheEntry {
  return {
    choice: "HOLD_WINNER",
    conviction: 2,
    convictionRaw: 2.1,
    prob: 0.8,
    confidence: 0.8,
    probabilities: { HOLD_WINNER: 0.8 },
    menuHash: "m",
    stateHash: "s",
    topId: "t",
    posKey: "flat",
    cap: null,
    stale: false,
    askedAtTick: 10,
    ...over,
  };
}

const cur = (over: Partial<CacheNow> = {}): CacheNow => ({
  menuHash: "m",
  stateHash: "s",
  topId: "t",
  posKey: "flat",
  cap: null,
  stale: false,
  ...over,
});

describe("menuHashFor", () => {
  const menu = (label: string): Menu => ({ [label]: { desc: null, intent: { kind: "open", instId: SOL.instId, side: "long", sizeFrac: 0.5, setup: "strict" } } });
  it("is stable under key order", () => {
    const a: Menu = { ...menu("A"), ...menu("B") };
    const b: Menu = { ...menu("B"), ...menu("A") };
    expect(menuHashFor(a)).toBe(menuHashFor(b));
  });
  it("changes when an intent kind, target or setup changes", () => {
    const base = menuHashFor(menu("A"));
    const switched: Menu = { A: { desc: null, intent: { kind: "switch", instId: SOL.instId, side: "long", sizeFrac: 0.5, setup: "strict" } } };
    const loose: Menu = { A: { desc: null, intent: { kind: "open", instId: SOL.instId, side: "long", sizeFrac: 0.5, setup: "loose" } } };
    const other: Menu = { A: { desc: null, intent: { kind: "open", instId: BTC.instId, side: "long", sizeFrac: 0.5, setup: "strict" } } };
    expect(menuHashFor(switched)).not.toBe(base);
    expect(menuHashFor(loose)).not.toBe(base);
    expect(menuHashFor(other)).not.toBe(base);
  });
});

describe("stateHashFor", () => {
  it("ignores mid AND uplR/mark moves, reacts to score, cap and position changes", () => {
    const b = bee("breezy");
    const base = stateHashFor(ctx("breezy", b, V));
    const moved = view([coin("SOL", {}, 105), BTC]);
    expect(stateHashFor(ctx("breezy", b, moved))).toBe(base);
    const scored = view([coin("SOL", { trend: trend({ score: 9 }) }), BTC]);
    expect(stateHashFor(ctx("breezy", b, scored))).not.toBe(base);
    const capped = bee("breezy", { cap: "trade_cap", tradesToday: 3 });
    expect(stateHashFor(ctx("breezy", capped, V))).not.toBe(base);
    const pos = bee("breezy", { position: position(SOL), flatSince: null });
    expect(stateHashFor(ctx("breezy", pos, V))).not.toBe(base);
  });
  it("uplR moves never bust the cache: uplR-driven actions (stops, TP/BE) run on live values in code", () => {
    const lo = bee("breezy", { position: position(SOL, { riskUsd: 10 }), uplUsd: 1.44, flatSince: null });
    const hi = bee("breezy", { position: position(SOL, { riskUsd: 10 }), uplUsd: 25, flatSince: null });
    expect(stateHashFor(ctx("breezy", hi, V))).toBe(stateHashFor(ctx("breezy", lo, V)));
  });
});

describe("cacheReusable", () => {
  it("reuses within the heartbeat and expires at it", () => {
    expect(cacheReusable(entry(), cur(), 0, 12)).toBe(true);
    expect(cacheReusable(entry(), cur(), 11, 12)).toBe(true);
    expect(cacheReusable(entry(), cur(), 12, 12)).toBe(false);
  });
  it("invalidates on menu/state/top/position/cap/stale changes", () => {
    expect(cacheReusable(entry(), cur({ menuHash: "x" }), 0, 12)).toBe(false);
    expect(cacheReusable(entry(), cur({ stateHash: "x" }), 0, 12)).toBe(false);
    expect(cacheReusable(entry(), cur({ topId: "flip" }), 0, 12)).toBe(false);
    expect(cacheReusable(entry(), cur({ posKey: "open" }), 0, 12)).toBe(false);
    expect(cacheReusable(entry(), cur({ cap: "trade_cap" }), 0, 12)).toBe(false);
    expect(cacheReusable(entry(), cur({ stale: true }), 0, 12)).toBe(false);
  });
});

describe("posKeyFor / topIdFor", () => {
  it("flat vs positioned vs flipped", () => {
    expect(posKeyFor(ctx("breezy", bee("breezy"), V))).toBe("flat");
    const p = bee("breezy", { position: position(SOL), flatSince: null });
    expect(posKeyFor(ctx("breezy", p, V))).toBe(`${SOL.instId}:long:100`);
  });
  it("top is the bee's own universe head", () => {
    expect(topIdFor(breezy, ctx("breezy", bee("breezy"), V))).toBe(breezy.universe(ctx("breezy", bee("breezy"), V))[0]);
  });
});

describe("ghostPick (caged, deterministic)", () => {
  const menu: Menu = {
    LONG_BTC: { desc: null, intent: { kind: "open", instId: BTC.instId, side: "long", sizeFrac: 0.5, setup: "strict" } },
    LONG_SOL: { desc: null, intent: { kind: "open", instId: SOL.instId, side: "long", sizeFrac: 0.5, setup: "strict" } },
    HOLD_WINNER: { desc: null, intent: { kind: "hold" } },
  };
  it("picks the highest-|score| strict open when flat", () => {
    const pick = ghostPick(breezy, ctx("breezy", bee("breezy"), V, testConfig()), menu);
    expect(pick).toMatchObject({ choice: "LONG_BTC", reason: "ghost_top_score" });
  });
  it("holds when positioned and reports no setup when flat without strict opens", () => {
    const p = bee("breezy", { position: position(SOL), flatSince: null });
    expect(ghostPick(breezy, ctx("breezy", p, V), menu)).toMatchObject({ choice: "hold", reason: "ghost_hold_position" });
    const loose: Menu = { X: { desc: null, intent: { kind: "hold" } } };
    expect(ghostPick(breezy, ctx("breezy", bee("breezy"), V), loose)).toMatchObject({ choice: null, reason: "ghost_no_strict_setup" });
  });
});

describe("breakevenStopPx", () => {
  it("entry ± feeBufferR in R, favourably", () => {
    // risk $10 over 100 contracts x ctVal 1/100 @ $100 → 1R = $10 price move.
    const s = coin("SOL");
    const v = view([s]);
    const ctVal = v.instruments.get(s.instId)!.ctVal;
    const long = position(s, { side: "long", entryPx: 100, riskUsd: 10, contracts: 100 });
    const short = position(s, { side: "short", entryPx: 100, riskUsd: 10, contracts: 100 });
    expect(breakevenStopPx(long, ctVal, 0.1)).toBeCloseTo(101, 8);
    expect(breakevenStopPx(short, ctVal, 0.1)).toBeCloseTo(99, 8);
  });
  it("null when 1R has no price meaning", () => {
    const p = position(SOL, { riskUsd: 0 });
    expect(breakevenStopPx(p, 0.01, 0.1)).toBeNull();
  });
});

describe("aggregateExposure", () => {
  it("sums open notional per instrument across bees", () => {
    const cfg = testConfig();
    const v = view([SOL, BTC]);
    const b1 = bee("bee1", { position: position(SOL, { contracts: 100 }), flatSince: null });
    const b2 = bee("bee2", { position: position(SOL, { contracts: 50 }), flatSince: null });
    const rows = aggregateExposure([b1, b2, bee("bee3")], v);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bees).toBe(2);
    expect(rows[0]!.notionalUsd).toBeCloseTo(150, 5);
    expect(cfg.risk.maxNotionalUsdPerBee).toBe(700);
  });
});


describe("no trim repeat from stale cache after execution (Finding 1)", () => {
  // Full decide() ticks against a fake Jev. bee2 runs breezy with a decayed
  // trend score (entryScore 5 → score 1), so TRIM_HALF is on the menu.
  async function harness(choice: string, score = 1, contracts = 100) {
    const { Db } = await import("../src/db.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Engine } = await import("../src/engine.js");
    const { Jev } = await import("../src/jev.js");
    const { Alerts } = await import("../src/alerts.js");
    const cfg = testConfig();
    const db = new Db(":memory:");
    const bus = new EventBus(db);
    const btc = coin("BTC", { trend: trend({ score }) }, 80000);
    const V = view([btc]);
    const feed = { view: () => V, lastRefreshAt: NOW } as never;
    const answers = {
      action: { type: "choice", choice, confidence: 1, probabilities: { [choice]: 1 } },
      conviction: { type: "score", score: 3, confidence: 0.5, legend: {}, probabilities: {} },
    };
    const jev = new Jev({
      apiKey: "k", model: "m", timeoutMs: 2000, dailyUsdCap: 5, usdPerMTok: 0.042,
      client: { async systemOne() { return { model: "m", usage: { input_tokens: 100, output_tokens: 0 }, answers } as never; } },
      now: () => NOW,
    });
    const exec = new SimExecutor(() => ({ tickers: V.tickers, instruments: V.instruments }), 0.0005, () => NOW);
    const engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts: new Alerts(undefined), now: () => NOW });
    const b = bee("breezy", { uplUsd: 0 });
    b.position = position(btc, { contracts, entryScore: 5, riskUsd: 10, stopPx: null });
    engine.bees["bee2"] = b;
    type E = { decide(id: string, now: number): Promise<void>; jevMade: Record<string, number>; jevCache: Record<string, unknown> };
    const e = engine as unknown as E;
    return { b, decide: (t: number) => e.decide("bee2", t), made: () => e.jevMade["bee2"] ?? 0, cache: () => e.jevCache["bee2"] };
  }

  it("posKey changes when contracts change", () => {
    const s = coin("SOL");
    const v = view([s]);
    const b = bee("breezy", { position: position(s, { contracts: 100 }), flatSince: null });
    const c = ctx("breezy", b, v);
    const before = posKeyFor(c);
    b.position!.contracts = 50;
    expect(posKeyFor(c)).not.toBe(before);
  });

  it("executed trim deletes the cache; next tick asks Jev afresh", async () => {
    const { b, decide, made, cache } = await harness("TRIM_HALF");
    await decide(NOW);
    expect(b.position!.contracts).toBe(50); // trim filled
    expect(cache()).toBeUndefined(); // cache dropped on execution
    expect(made()).toBe(1);
    await decide(NOW + 10_000);
    expect(made()).toBe(2); // tick 2 is a FRESH call, never a stale-cache repeat
  });

  it("unchanged hold ticks still reuse the cache (gate not over-invalidated)", async () => {
    // Positioned at target size (no rebalance add), score aligned with entry
    // (no TRIM_HALF): fake holds twice on identical state.
    const { decide, made, cache } = await harness("HOLD_WINNER", 5, 700);
    await decide(NOW);
    expect(made()).toBe(1);
    expect(cache()).toBeDefined();
    await decide(NOW + 10_000);
    expect(made()).toBe(1); // no fresh call: identical menu+state reuses the answer
  });
});

describe("lockedHold: rule-dictated ride never asks Jev (upstream parity)", () => {
  async function boozyHarness(stopPx: number | null) {
    const { Db } = await import("../src/db.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Engine } = await import("../src/engine.js");
    const { Jev } = await import("../src/jev.js");
    const { Alerts } = await import("../src/alerts.js");
    const cfg = testConfig();
    const db = new Db(":memory:");
    const bus = new EventBus(db);
    const doge = coin("DOGE", {}, 1);
    const V = view([doge]);
    const feed = { view: () => V, lastRefreshAt: NOW } as never;
    const answers = {
      action: { type: "choice", choice: "RIDE", confidence: 1, probabilities: { RIDE: 1 } },
      conviction: { type: "score", score: 3, confidence: 0.5, legend: {}, probabilities: {} },
    };
    const jev = new Jev({
      apiKey: "k", model: "m", timeoutMs: 2000, dailyUsdCap: 5, usdPerMTok: 0.042,
      client: { async systemOne() { return { model: "m", usage: { input_tokens: 100, output_tokens: 0 }, answers } as never; } },
      now: () => NOW,
    });
    const exec = new SimExecutor(() => ({ tickers: V.tickers, instruments: V.instruments }), 0.0005, () => NOW);
    const engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts: new Alerts(undefined), now: () => NOW });
    const b = bee("boozy", { uplUsd: 0, flatSince: null });
    b.position = position(doge, { contracts: 100, entryPx: 1, riskUsd: 10, stopPx, openedAt: NOW - 10 * 60_000 });
    engine.bees["bee3"] = b;
    type E = { decide(id: string, now: number): Promise<void>; jevMade: Record<string, number>; last: Record<string, { status: string }> };
    const e = engine as unknown as E;
    return { b, decide: (t: number) => e.decide("bee3", t), made: () => e.jevMade["bee3"] ?? 0, status: () => e.last["bee3"]?.status ?? "" };
  }

  it("committed ride with no double-down: zero Jev calls, status names the rule", async () => {
    const { b, decide, made, status } = await boozyHarness(null);
    await decide(NOW);
    expect(made()).toBe(0);
    expect(b.position).not.toBeNull();
    expect(status()).toContain("required by the rules");
    expect(status()).toContain("Jev not asked");
  });

  it("stop still fires under a locked hold without asking Jev", async () => {
    const { b, decide, made } = await boozyHarness(1.5);
    await decide(NOW);
    expect(made()).toBe(0);
    expect(b.position).toBeNull();
  });
});

describe("applyProfitLock (bank gains, never round-trip to loss)", () => {
  async function harness() {
    const { Db } = await import("../src/db.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Engine } = await import("../src/engine.js");
    const { Jev } = await import("../src/jev.js");
    const { Alerts } = await import("../src/alerts.js");
    const cfg = testConfig();
    const db = new Db(":memory:");
    const bus = new EventBus(db);
    const doge = coin("DOGE", {}, 1);
    const V = view([doge]);
    const feed = { view: () => V, lastRefreshAt: NOW } as never;
    const answers = {
      action: { type: "choice", choice: "RIDE", confidence: 1, probabilities: { RIDE: 1 } },
      conviction: { type: "score", score: 3, confidence: 0.5, legend: {}, probabilities: {} },
    };
    const jev = new Jev({
      apiKey: "k", model: "m", timeoutMs: 2000, dailyUsdCap: 5, usdPerMTok: 0.042,
      client: { async systemOne() { return { model: "m", usage: { input_tokens: 10, output_tokens: 0 }, answers } as never; } },
      now: () => NOW,
    });
    const exec = new SimExecutor(() => ({ tickers: V.tickers, instruments: V.instruments }), 0, () => NOW);
    const engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts: new Alerts(undefined), now: () => NOW });
    return { engine, V };
  }

  it("tracks peak and locks 90% via the stop once activated", async () => {
    const { engine, V } = await harness();
    type E = { applyProfitLock(id: string, ctx: unknown): string | null };
    const e = engine as unknown as E;
    const b = bee("boozy", { uplUsd: 5 });
    // $5 peak on 100 contracts x $1 with entry 1.0: lock = $4.50 → stop 1.045.
    b.position = position(coin("DOGE", {}, 1), { contracts: 100, entryPx: 1, riskUsd: 10, stopPx: 0.9 });
    const c = ctx("boozy", b, V, testConfig(), NOW);
    const note = e.applyProfitLock("bee3", c as never);
    expect(note).toContain("+$4.50");
    expect(b.position!.stopPx).toBeCloseTo(1.045, 8);
    expect(b.position!.peakUplUsd).toBe(5);
  });

  it("ignores dust peaks below activation and never loosens", async () => {
    const { engine, V } = await harness();
    type E = { applyProfitLock(id: string, ctx: unknown): string | null };
    const e = engine as unknown as E;
    const b = bee("boozy", { uplUsd: 1 });
    b.position = position(coin("DOGE", {}, 1), { contracts: 100, entryPx: 1, riskUsd: 10, stopPx: 1.02 });
    const c = ctx("boozy", b, V, testConfig(), NOW);
    expect(e.applyProfitLock("bee3", c as never)).toBeNull();
    expect(b.position!.stopPx).toBe(1.02);
    expect(b.position!.peakUplUsd).toBe(1);
  });
});

describe("protectAdds: an add can never turn a winner into a loser", () => {
  it("stop ratchets to at least the new average entry after a filled add", async () => {
    const { Db } = await import("../src/db.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Engine } = await import("../src/engine.js");
    const { Jev } = await import("../src/jev.js");
    const { Alerts } = await import("../src/alerts.js");
    const cfg = testConfig();
    const db = new Db(":memory:");
    const bus = new EventBus(db);
    const s = coin("PENGU", {}, 100);
    const V = view([s]);
    const feed = { view: () => V, lastRefreshAt: NOW } as never;
    const answers = {
      action: { type: "choice", choice: "DOUBLE_DOWN", confidence: 1, probabilities: { DOUBLE_DOWN: 1 } },
      conviction: { type: "score", score: 3, confidence: 0.5, legend: {}, probabilities: {} },
    };
    const jev = new Jev({
      apiKey: "k", model: "m", timeoutMs: 2000, dailyUsdCap: 5, usdPerMTok: 0.042,
      client: { async systemOne() { return { model: "m", usage: { input_tokens: 100, output_tokens: 0 }, answers } as never; } },
      now: () => NOW,
    });
    const exec = new SimExecutor(() => ({ tickers: V.tickers, instruments: V.instruments }), 0.0005, () => NOW);
    const engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts: new Alerts(undefined), now: () => NOW });
    const b = bee("boozy", { uplUsd: 0, flatSince: null });
    b.position = position(s, { contracts: 333, entryPx: 98.9, riskUsd: 10, stopPx: null });
    engine.bees["bee3"] = b;
    type E = { decide(id: string, now: number): Promise<void> };
    await (engine as unknown as E).decide("bee3", NOW);
    const p = b.position!;
    expect(p.contracts).toBeGreaterThan(333); // the add filled
    expect(p.stopPx).toBeCloseTo(p.entryPx, 6); // stop lifted to the new average entry
    expect(p.stopPx).toBeGreaterThan(98.9);
  });
});
