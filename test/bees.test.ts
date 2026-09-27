import { describe, expect, it } from "vitest";
import { MARGIN_HEADROOM } from "../src/bees/common.js";
import { bizzy, fadeSetup, stingerSetup } from "../src/bees/bizzy.js";
import { boozy, rankCandidates, switchTarget } from "../src/bees/boozy.js";
import { breezy, breezySizeFrac } from "../src/bees/breezy.js";
import { buildSnapshot } from "../src/snapshot.js";
import { bee, coin, ctx, NOW, position, testConfig, trend, view } from "./fixtures.js";

const HOLDS = ["HOLD", "HOLD_WINNER", "RIDE"];

describe("drama rule 1: no do-nothing option while flat", () => {
  const v = view([
    coin("BTC", { trend: trend({ score: 4 }), pctB: 1.2, rsi14: 75 }, 80000),
    coin("ETH", { trend: trend({ score: -3 }), ret24hPct: 5 }, 2700),
    coin("SOL", { ret24hPct: 12, rsi14: 25, pctB: -0.2 }),
  ]);
  for (const [id, brain] of [["bizzy", bizzy], ["breezy", breezy], ["boozy", boozy]] as const) {
    // bizzy (breakout hunter since 2026-09-24) waits for her trigger instead; see "bizzy breakout" below.
    if (id !== "bizzy") it(`${id}: flat menu has real moves and no hold`, () => {
      const m = brain.menu(ctx(id, bee(id), v));
      expect(Object.keys(m).length).toBeGreaterThan(0);
      for (const h of HOLDS) expect(m[h]).toBeUndefined();
    });
    it(`${id}: positioned menu offers a hold`, () => {
      const b = bee(id, { position: position(v.stats.get("SOL-USD_UM_XPERP-310404")!), flatSince: null });
      if (id === "breezy") b.position = position(v.stats.get("BTC-USD_UM_XPERP-310404")!);
      const m = brain.menu(ctx(id, b, v));
      expect(HOLDS.some((h) => m[h])).toBe(true);
    });
  }
});

describe("bizzy setups", () => {
  it("strict long needs rsi<30 AND close below the lower band", () => {
    expect(fadeSetup(coin("A", { rsi14: 29, pctB: -0.01 }))).toMatchObject({ side: "long", strict: true });
    expect(fadeSetup(coin("A", { rsi14: 31, pctB: -0.01 }))).toBeNull();
    expect(fadeSetup(coin("A", { rsi14: 29, pctB: 0.01 }))).toBeNull();
  });
  it("strict short needs rsi>70 AND close above the upper band", () => {
    expect(fadeSetup(coin("A", { rsi14: 71, pctB: 1.01 }))).toMatchObject({ side: "short", strict: true });
    expect(fadeSetup(coin("A", { rsi14: 69, pctB: 1.01 }))).toBeNull();
  });
  it("funding z > 1.5 removes the long setup", () => {
    expect(fadeSetup(coin("A", { rsi14: 25, pctB: -0.2, fundingZ: 1.6 }))).toBeNull();
  });
});

describe("bizzy breakout (one Larry Williams breakout a day)", () => {
  const lvl = { dayOpen: 100, prevRange: 4, trigger: 102 };
  it("offers BREAKOUT_<coin> only once price is through today's trigger, plus WAIT", () => {
    const through = coin("SOL", { breakout: lvl }, 102.5);
    const below = coin("BTC", { breakout: { dayOpen: 100, prevRange: 4, trigger: 102 } }, 101);
    const m = bizzy.menu(ctx("bizzy", bee("bizzy"), view([through, below])));
    expect(m.BREAKOUT_SOL!.intent).toMatchObject({ kind: "open", side: "long", sizeFrac: 1 });
    expect(m.BREAKOUT_BTC).toBeUndefined();
    expect(m.WAIT).toBeDefined();
  });
  it("nothing through its trigger = empty menu, so Jev is not asked", () => {
    const m = bizzy.menu(ctx("bizzy", bee("bizzy"), view([coin("SOL", { breakout: lvl }, 101)])));
    expect(Object.keys(m)).toEqual([]);
  });
  it("only BTC, ETH, SOL and HYPE inside her spread gate", () => {
    const v = view([coin("SOL", { breakout: lvl, spreadBp: 4.9 }), coin("PUMP", { breakout: lvl }), coin("ETH", { breakout: lvl, spreadBp: 12 })]);
    expect(bizzy.universe(ctx("bizzy", bee("bizzy"), v))).toEqual(["SOL-USD_UM_XPERP-310404"]);
  });
  it("idle status says how far the nearest coin is from its trigger", () => {
    expect(bizzy.idleStatus!(ctx("bizzy", bee("bizzy"), view([coin("SOL", { breakout: lvl }, 101)])))).toBe("SOL is 0.99% from breakout");
  });
  it("idleDetail returns the nearest trigger coin with pct math (data, not parsed text)", () => {
    const v = view([
      coin("SOL", { breakout: lvl }, 100.5), // (102-100.5)/100.5*100 ≈ 1.49% away
      coin("BTC", { breakout: lvl }, 101), // (102-101)/101*100 ≈ 0.99% away → nearest
    ]);
    expect(bizzy.idleDetail!(ctx("bizzy", bee("bizzy"), v))).toMatchObject({ label: "Waiting to pounce", coin: "BTC" });
    expect(bizzy.idleDetail!(ctx("bizzy", bee("bizzy"), v))?.pctAway).toBeCloseTo(0.99, 2);
    expect(bizzy.idleDetail!(ctx("bizzy", bee("bizzy"), view([coin("SOL", {}, 101)])))).toBeNull();
  });
  it("positioned: HOLD always, CUT_LOSS only while losing", () => {
    const s = coin("SOL", { breakout: lvl }, 103);
    const win = bizzy.menu(ctx("bizzy", bee("bizzy", { position: position(s), flatSince: null, uplUsd: 1 }), view([s])));
    expect(win.HOLD).toBeDefined();
    expect(win.CUT_LOSS).toBeUndefined();
    const lose = bizzy.menu(ctx("bizzy", bee("bizzy", { position: position(s), flatSince: null, uplUsd: -1 }), view([s])));
    expect(lose.CUT_LOSS).toBeDefined();
  });
  it("stop is today's open (a failed breakout)", () => {
    const s = coin("SOL", { breakout: lvl }, 103);
    expect(bizzy.stopFor(s.instId, "long", 102.5, ctx("bizzy", bee("bizzy"), view([s])))).toBe(100);
  });
});

describe("breezy", () => {
  it("sizes max(0.5, |score|/9) of max, capped by the 60% vol limit", () => {
    const b = bee("breezy");
    const calm = coin("BTC", { trend: trend({ score: 9, rv90Pct: 20 }) });
    expect(breezySizeFrac(calm, ctx("breezy", b, view([calm])))).toBe(1);
    const wild = coin("BTC", { trend: trend({ score: 9, rv90Pct: 100 }) });
    expect(breezySizeFrac(wild, ctx("breezy", b, view([wild])))).toBeCloseTo((333 * 0.6) / (666 * MARGIN_HEADROOM), 6);
    const flat = coin("BTC", { trend: trend({ score: 0, rv90Pct: 50 }) });
    expect(breezySizeFrac(flat, ctx("breezy", b, view([flat])))).toBe(0.5);
    const weak = coin("BTC", { trend: trend({ score: 2, rv90Pct: 50 }) });
    expect(breezySizeFrac(weak, ctx("breezy", b, view([weak])))).toBe(0.5);
  });
  it("rebalances up when over 25% of max below target, not when near it or against the trend", () => {
    const s = coin("BTC", { trend: trend({ score: 9, rv90Pct: 20 }) }, 80000);
    const v = view([s]);
    // one contract = $1 at the fixture price: 100 contracts = $100, target = max = $666 x MARGIN_HEADROOM
    const small = breezy.rebalance!(ctx("breezy", bee("breezy", { position: position(s, { contracts: 100 }), flatSince: null }), v));
    expect(small).toMatchObject({ kind: "add" });
    expect(small!.sizeFrac).toBeCloseTo((666 * MARGIN_HEADROOM - 100) / (666 * MARGIN_HEADROOM), 6);
    expect(breezy.rebalance!(ctx("breezy", bee("breezy", { position: position(s, { contracts: 600 }), flatSince: null }), v))).toBeNull();
    expect(breezy.rebalance!(ctx("breezy", bee("breezy", { position: position(s, { contracts: 100, side: "short" }), flatSince: null }), v))).toBeNull();
  });
  it("ADD_TO_WINNER only above +1R", () => {
    const s = coin("BTC", { trend: trend({ score: 5 }) }, 80000);
    const v = view([s]);
    const up = breezy.menu(ctx("breezy", bee("breezy", { position: position(s, { riskUsd: 10, contracts: 1 }), flatSince: null, uplUsd: 11 }), v));
    expect(up.ADD_TO_WINNER).toBeDefined();
    const meh = breezy.menu(ctx("breezy", bee("breezy", { position: position(s, { riskUsd: 10, contracts: 1 }), flatSince: null, uplUsd: 9 }), v));
    expect(meh.ADD_TO_WINNER).toBeUndefined();
  });
  it("TRIM_HALF when the score falls by 3+, not by 2", () => {
    const s = coin("BTC", { trend: trend({ score: 4 }) }, 80000);
    const v = view([s]);
    expect(breezy.menu(ctx("breezy", bee("breezy", { position: position(s, { entryScore: 7 }), flatSince: null }), v)).TRIM_HALF).toBeDefined();
    expect(breezy.menu(ctx("breezy", bee("breezy", { position: position(s, { entryScore: 6 }), flatSince: null }), v)).TRIM_HALF).toBeUndefined();
  });
});

describe("boozy", () => {
  it("ranks momentum plus attention, and never ranks a spread-blocked coin", () => {
    const v = view([coin("BTC", { ret24hPct: 1 }), coin("PENGU", { ret24hPct: 15, volZ: 3 }), coin("RAY", { ret24hPct: 17, spreadBp: 58.6 })]);
    const ranked = rankCandidates(v, 15).map((c) => c.s.coin);
    expect(ranked[0]).toBe("PENGU");
    expect(ranked).not.toContain("RAY");
  });
  it("FLIP_SHORT only when 1h is negative AND OI is falling (after the 24h commitment)", () => {
    const old = { openedAt: NOW - 25 * 60 * 60_000 };
    const yes = coin("PENGU", { ret1hPct: -1, oiChg1hPct: -2 });
    expect(boozy.menu(ctx("boozy", bee("boozy", { position: position(yes, old), flatSince: null }), view([yes]))).FLIP_SHORT).toBeDefined();
    const no = coin("PENGU", { ret1hPct: -1, oiChg1hPct: 2 });
    expect(boozy.menu(ctx("boozy", bee("boozy", { position: position(no, old), flatSince: null }), view([no]))).FLIP_SHORT).toBeUndefined();
  });
  it("commits to a pick for 24h: no BAIL, SWITCH_COIN or FLIP_SHORT before, all unlocked after", () => {
    const s = coin("PENGU", { ret1hPct: -1, oiChg1hPct: -2 });
    const other = coin("PEPE", { ret24hPct: 20 });
    const v = view([s, other]);
    const young = boozy.menu(ctx("boozy", bee("boozy", { position: position(s, { openedAt: NOW - 23 * 60 * 60_000 }), flatSince: null }), v));
    expect(young.BAIL ?? young.SWITCH_COIN ?? young.FLIP_SHORT).toBeUndefined();
    expect(young.RIDE).toBeDefined();
    // SWITCH_COIN also needs PEPE to have led the last two hourly checks (no switching on a stale ranking).
    const old = boozy.menu(ctx("boozy", bee("boozy", { position: position(s, { openedAt: NOW - 24 * 60 * 60_000 }), flatSince: null, top1: { coin: "PEPE", streak: 2, rankedAt: NOW } }), v));
    expect(old.BAIL && old.SWITCH_COIN && old.FLIP_SHORT).toBeDefined();
  });
  it("DOUBLE_DOWN only after another 1 ATR(1h) run past the entry", () => {
    // atr14Pct 0.5 at price 100: 15m ATR = 0.5, so ATR(1h) ~ 1.0
    const s = coin("PENGU", {}, 100);
    const v = view([s]);
    const ran = boozy.menu(ctx("boozy", bee("boozy", { position: position(s, { entryPx: 98.9, contracts: 333 }), flatSince: null }), v));
    expect(ran.DOUBLE_DOWN!.intent).toMatchObject({ kind: "add", sizeFrac: 0.25 });
    const notYet = boozy.menu(ctx("boozy", bee("boozy", { position: position(s, { entryPx: 99.5, contracts: 333 }), flatSince: null }), v));
    expect(notYet.DOUBLE_DOWN).toBeUndefined();
  });
});

describe("snapshot (phase 3 budget: < 400 tokens)", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    coin(`C${i}`, { rsi14: 12.3456, pctB: -0.123456, ret24hPct: 10 - i, ret7dPct: 3.3333, fundingPct: 0.0123456, fundingZ: 1.23456, oiChg1hPct: -2.2222, volZ: 1.1111, trend: i < 2 ? trend({ score: 7, trailStop: 95 }) : undefined }, 0.0012345),
  );
  const v = view(many);
  for (const [id, brain] of [["bizzy", bizzy], ["breezy", breezy], ["boozy", boozy]] as const) {
    it(`${id} stays well under 400 tokens`, () => {
      const s = buildSnapshot(brain, ctx(id, bee(id), v));
      expect(s.approxTokens).toBeLessThan(400);
      expect(s.hash).toMatch(/^[0-9a-f]{16}$/);
    });
  }
  it("contains numbers and labels, never account data", () => {
    const s = JSON.stringify(buildSnapshot(boozy, ctx("boozy", bee("boozy"), v)).state);
    expect(s).not.toMatch(/uid|subacct|key|secret/i);
  });
});


describe("bizzy Stinger setup (prev-day-high + rising volume, challenger)", () => {
  const hi = { dayOpen: 100, prevRange: 4, trigger: 102, prevHigh: 101 };
  it("strict long only above prev high with rising volume", () => {
    expect(stingerSetup(coin("SOL", { breakout: hi, volZ: 1.5 }, 102))).toMatchObject({ coin: "SOL" });
    expect(stingerSetup(coin("SOL", { breakout: hi, volZ: 1.5 }, 100.5))).toBeNull(); // below high
    expect(stingerSetup(coin("SOL", { breakout: hi, volZ: 0.2 }, 102))).toBeNull(); // thin volume
    expect(stingerSetup(coin("SOL", { breakout: { dayOpen: 100, prevRange: 4, trigger: 102 }, volZ: 2 }, 103))).toBeNull(); // no prevHigh data
  });
  it("menu offers STINGER_ alongside BREAKOUT_ with separate labels for attribution", () => {
    const s = coin("SOL", { breakout: hi, volZ: 1.5 }, 102.5);
    const m = bizzy.menu(ctx("bizzy", bee("bizzy"), view([s])));
    expect(m.BREAKOUT_SOL).toBeDefined(); // through Williams trigger too
    expect(m.STINGER_SOL!.intent).toMatchObject({ kind: "open", side: "long", setup: "strict" });
  });
});
  it("idle line adds scout-wide nearest trigger outside bizzy's list (watch only)", () => {
    const lvl = { dayOpen: 100, prevRange: 4, trigger: 102, prevHigh: 99 };
    // Own nearest: SOL 0.99% away; AVAX (outside list) nearer at 0.10%.
    const v = view([
      coin("SOL", { breakout: lvl }, 101),
      coin("AVAX", { breakout: { dayOpen: 50, prevRange: 2, trigger: 51, prevHigh: 49 } }, 50.95),
    ]);
    const line = bizzy.idleStatus!(ctx("bizzy", bee("bizzy"), v));
    expect(line).toContain("SOL is 0.99% from breakout");
    expect(line).toContain("scout-wide nearest AVAX");
    expect(line).toContain("watch only");
  });

describe("boozy lockedHold (rule-dictated ride skips Jev)", () => {
  it("locks only when committed with no double-down available", async () => {
    const { boozy } = await import("../src/bees/boozy.js");
    const s = coin("DOGE", {}, 1);
    const v = view([s]);
    const held = (over = {}) => ctx("boozy", bee("boozy", { uplUsd: 0, ...over }), v, testConfig(), NOW);
    const pos = (openedAt: number) => position(s, { contracts: 100, openedAt, entryPx: 1, riskUsd: 10, stopPx: null });
    // Fresh position at entry: committed, no run-up → locked.
    expect(boozy.lockedHold!(held({ position: { ...pos(NOW - 10 * 60_000), flatSince: null } }))).toBe("required by the rules");
    // Past the 24h commit window → real choice exists.
    expect(boozy.lockedHold!(held({ position: { ...pos(NOW - 25 * 60 * 60_000), flatSince: null } }))).toBeNull();
    // Flat → null (nothing to ride).
    expect(boozy.lockedHold!(held())).toBeNull();
  });
});

describe("breezy neverForce (profit mode: no forced entries)", () => {
  it("flag set and waiting line names the strongest signal", () => {
    expect(breezy.neverForce).toBe(true);
    const v = view([coin("BTC", { trend: trend({ score: -4 }) }, 80000), coin("ETH", { trend: trend({ score: 2 }) }, 2700)]);
    expect(breezy.idleStatus!(ctx("breezy", bee("breezy"), v))).toContain("BTC");
  });
});

describe("boozy risk-normalized entries (1.5% risk per stopped-out entry)", () => {
  const cfg = testConfig();
  const mk = (mid: number, atrPct: number, equity = 333) => {
    const s = coin("DOGE", { atr14Pct: atrPct }, mid);
    const v = view([s]);
    const c = ctx("boozy", bee("boozy", { equityUsd: equity }), v, cfg, NOW);
    return { s, v, c };
  };
  const open = { kind: "open" as const, instId: "", side: "long" as const, sizeFrac: 0.5, setup: "strict" as const };
  it("wide stop shrinks the entry (AERO case: 7.2% stop on $333)", () => {
    // atr14Pct 1.2 → atr1h 2.4% → 3x trail = 7.2% stop; max = min(2*333, 700) x MARGIN_HEADROOM.
    const { c, s } = mk(1, 1.2);
    const f = boozy.sizeFrac({ ...open, instId: s.instId }, 3, c);
    expect(f).toBeCloseTo((0.015 * 333) / (0.072 * 666 * MARGIN_HEADROOM), 3);
    expect(f).toBeLessThan(0.5);
  });
  it("narrow stop caps at full size, unknown stop passes through", () => {
    const narrow = mk(100, 0.1);
    expect(boozy.sizeFrac({ ...open, instId: narrow.s.instId }, 3, narrow.c)).toBe(1);
    const noAtr = coin("DOGE", { atr14Pct: null }, 1);
    const v = view([noAtr]);
    const c = ctx("boozy", bee("boozy"), v, cfg, NOW);
    expect(boozy.sizeFrac({ ...open, instId: noAtr.instId }, 3, c)).toBe(0.5);
  });
});

describe("boozy spike challenger (volume spike + push-up, label-only)", () => {
  it("strict long only on spike with upward push", async () => {
    const { spikeSetup } = await import("../src/bees/boozy.js");
    const hot = coin("DOGE", { volZ: 2.5, ret1hPct: 1.2 }, 1);
    expect(spikeSetup(hot)).toMatchObject({ coin: "DOGE" });
    expect(spikeSetup(coin("DOGE", { volZ: 0.5, ret1hPct: 1.2 }, 1))).toBeNull();
    expect(spikeSetup(coin("DOGE", { volZ: 2.5, ret1hPct: -0.5 }, 1))).toBeNull();
    expect(spikeSetup(coin("DOGE", { volZ: null, ret1hPct: 1.2 }, 1))).toBeNull();
  });
});

describe("boozy: a switch needs a confirmed outrank", () => {
  // ENA held; SUI has stronger momentum, so it ranks first.
  const ena = coin("ENA", { ret24hPct: 5, ret7dPct: 20 });
  const sui = coin("SUI", { ret24hPct: 12, ret7dPct: 40 });
  const unlocked = (top1: { coin: string | null; streak: number }, stats = [ena, sui]) => {
    const b = bee("boozy", { position: position(ena, { openedAt: NOW - 25 * 60 * 60_000 }), flatSince: null, top1: { ...top1, rankedAt: NOW } });
    return ctx("boozy", b, view(stats));
  };

  it("offered when the other coin leads now and led the last two hourly checks", () => {
    const c = unlocked({ coin: "SUI", streak: 2 });
    expect(rankCandidates(c.view, c.knobs.spreadGateBps)[0]!.s.coin).toBe("SUI");
    expect(boozy.menu(c).SWITCH_COIN?.intent).toMatchObject({ kind: "switch", instId: sui.instId });
  });

  it("not offered on a single check", () => {
    expect(boozy.menu(unlocked({ coin: "SUI", streak: 1 })).SWITCH_COIN).toBeUndefined();
  });

  it("not offered while the held coin is still #1, whatever the hourly history says", () => {
    const strongEna = coin("ENA", { ret24hPct: 25, ret7dPct: 43 });
    expect(boozy.menu(unlocked({ coin: "SUI", streak: 3 }, [strongEna, sui])).SWITCH_COIN).toBeUndefined();
  });

  it("not offered when the held coin is out of the ranking (spread gate), since there is no fair comparison", () => {
    const wide = coin("ENA", { ret24hPct: 5, ret7dPct: 20, spreadBp: 27 });
    const c = unlocked({ coin: "SUI", streak: 2 }, [wide, sui]);
    expect(switchTarget(c, rankCandidates(c.view, c.knobs.spreadGateBps))).toBeNull();
    expect(boozy.menu(c).SWITCH_COIN).toBeUndefined();
    expect(boozy.menu(c).BAIL).toBeDefined(); // bailing stays Jev's call
  });

  it("the streak belongs to one challenger: a different leader starts from zero", () => {
    expect(boozy.menu(unlocked({ coin: "DOGE", streak: 5 })).SWITCH_COIN).toBeUndefined();
  });
});

describe("entry-stop backfill re-sizes R once", () => {
  it("an old position without initialStopPx is anchored to its entry stop; a trailed-past-entry one is left alone", async () => {
    const { Db } = await import("../src/db.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Engine } = await import("../src/engine.js");
    const { Alerts } = await import("../src/alerts.js");
    const cfg = testConfig();
    const s = coin("ENA", { ret24hPct: 25, ret7dPct: 43 });
    const V = view([s]);
    const feed = { view: () => V, lastRefreshAt: NOW } as never;
    const db = new Db(":memory:");
    const engine = new Engine({ cfg, db, feed, jev: null as never, exec: new SimExecutor(() => V, 0), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW });
    type E = { bees: Record<string, ReturnType<typeof bee>>; markBee(id: string, now: number): void };
    const e = engine as unknown as E;
    const ctVal = V.instruments.get(s.instId)!.ctVal;
    e.bees["bee3"] = bee("boozy", { position: position(s, { contracts: 21, entryPx: 100, stopPx: 90, riskUsd: 1 }) });
    e.markBee("bee3", NOW);
    expect(e.bees["bee3"]!.position).toMatchObject({ initialStopPx: 90 });
    expect(e.bees["bee3"]!.position!.riskUsd).toBeCloseTo(21 * ctVal * 10, 6);
    e.bees["bee3"] = bee("boozy", { position: position(s, { contracts: 21, entryPx: 95, stopPx: 96, riskUsd: 7 }) });
    e.markBee("bee3", NOW);
    expect(e.bees["bee3"]!.position).toMatchObject({ initialStopPx: null, riskUsd: 7 });
  });
});
