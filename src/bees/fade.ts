// rook-bee (bee6, "Rook"): crowded-funding fade. See strategies/FADE.md.
// The only counter-trend, only two-sided brain in the building: shorts crowded
// longs paying extreme funding into extended rallies, longs washed-out shorts.
// Rule-driven (strict gates, neverForce): the code takes the setup, Jev is
// never asked. Deliberately OI-free — oi1h_pct is null on every coin in this
// environment (verified 2026-09-28), so nothing here may depend on it.
import type { CoinStats } from "../market/types.js";
import { atrStop, maxNotionalUsd, r2 } from "./common.js";
import type { BeeBrain, BeeContext, IdleDetail, Menu, Side } from "./types.js";

/** Crowding bar: |funding z| at least this extreme (top ~2.5%, exhaustion not strength). */
export const FADE_MIN_FUNDING_Z = 2.0;
/** Extension bar: |24h return| at least this far (the crowd had to travel to get crowded). */
export const FADE_MIN_EXT_PCT = 8;
/** Risk 1% of book equity per fade, stop-distance sized. */
export const FADE_RISK_PCT_EQUITY = 0.01;
/** Fades snap or fail: anything alive at 6h is a regime, not an exhaustion. */
export const FADE_TIME_STOP_MIN = 360;

export interface FadeSetup {
  instId: string;
  coin: string;
  side: Side;
  fundingZ: number;
  ret24hPct: number;
}

/** Crowded-long exhaustion (short it) or washed-out-short capitulation (long it). Null = no fade. */
export function fadeSetup(s: CoinStats): FadeSetup | null {
  if (s.fundingZ === null || s.ret24hPct === null) return null;
  if (s.fundingZ >= FADE_MIN_FUNDING_Z && s.ret24hPct >= FADE_MIN_EXT_PCT)
    return { instId: s.instId, coin: s.coin, side: "short", fundingZ: s.fundingZ, ret24hPct: s.ret24hPct };
  if (s.fundingZ <= -FADE_MIN_FUNDING_Z && s.ret24hPct <= -FADE_MIN_EXT_PCT)
    return { instId: s.instId, coin: s.coin, side: "long", fundingZ: s.fundingZ, ret24hPct: s.ret24hPct };
  return null;
}

function fadeStats(ctx: BeeContext): CoinStats[] {
  return ctx.view.gated
    .map((id) => ctx.view.stats.get(id))
    .filter((s): s is CoinStats => !!s && s.spreadBp <= ctx.knobs.spreadGateBps);
}

/** Most crowded first (|funding z| descending). */
export function rankFades(ctx: BeeContext): FadeSetup[] {
  return fadeStats(ctx)
    .map((s) => fadeSetup(s))
    .filter((x): x is FadeSetup => !!x)
    .sort((a, b) => Math.abs(b.fundingZ) - Math.abs(a.fundingZ));
}

/** Nearest fade by missing bar: smallest |funding z| shortfall or extension shortfall. */
function nearestFade(ctx: BeeContext): { coin: string; why: string; mid: number } | null {
  const rows = fadeStats(ctx)
    .filter((s) => s.fundingZ !== null && s.ret24hPct !== null)
    .map((s) => {
      const zGap = FADE_MIN_FUNDING_Z - Math.abs(s.fundingZ!);
      const eGap = FADE_MIN_EXT_PCT - Math.abs(s.ret24hPct!);
      const miss = Math.max(zGap / FADE_MIN_FUNDING_Z, eGap / FADE_MIN_EXT_PCT);
      const why = zGap / FADE_MIN_FUNDING_Z > eGap / FADE_MIN_EXT_PCT ? "funding not crowded yet" : "move not extended yet";
      return { coin: s.coin, miss, why, mid: s.mid };
    })
    .sort((a, b) => a.miss - b.miss);
  return rows[0] ?? null;
}

export const fade: BeeBrain = {
  id: "fade",
  triggers: ["crowded-long", "washed-out-short"],
  strategy:
    "You are rook-bee, the contrarian. You fade crowded positioning on every liquid coin: when longs are so crowded that funding z-score hits +2 into a +8% day, you short the exhaustion; when shorts pay -2 into a -8% washout, you long the capitulation. Wide 2x ATR stops because crowds overshoot, trim half at +1R, out at +2R, dead at 6 hours. Rare by construction. (Rule-driven: the code executes this, Jev is never asked.)",
  convictionLabels: ["cold", "patient", "crowded", "capitulation"],
  neverForce: true,
  requiresStrictSetup: true,
  /** Rule-driven entries: the engine takes the single setup without asking Jev. */
  ruleDriven: true,
  timeStopMinutes: () => FADE_TIME_STOP_MIN,

  idleStatus(ctx) {
    const p = ctx.bee.position;
    if (p) return `fading ${p.coin} ${p.side}${ctx.uplR !== null ? ` ${ctx.uplR >= 0 ? "+" : ""}${ctx.uplR.toFixed(1)}R` : ""} (6h time stop)`;
    const near = nearestFade(ctx);
    return near ? `${near.coin}: ${near.why}` : "no crowd worth fading";
  },

  idleDetail(ctx): IdleDetail | null {
    if (ctx.bee.position) return null;
    const near = nearestFade(ctx);
    return near ? { label: "Watching the crowd", coin: near.coin, midPx: near.mid } : null;
  },

  universe(ctx) {
    return fadeStats(ctx).map((s) => s.instId);
  },

  snapshotCoins(ctx) {
    const ids = new Set(this.universe(ctx));
    if (ctx.bee.position) ids.add(ctx.bee.position.instId);
    return [...ids];
  },

  coinSnapshot(s) {
    return {
      fund_z: r2(s.fundingZ, 1),
      r24h_pct: r2(s.ret24hPct, 1),
      atr15_pct: r2(s.atr14Pct, 2),
      spread_bp: r2(s.spreadBp, 1),
    };
  },

  menu(ctx): Menu {
    // Flat: the most crowded setup, or nothing. Positioned: nothing — the stop,
    // the ladder and the time stop all fire in code.
    if (ctx.bee.position) return {};
    const ranked = rankFades(ctx);
    // bee6 is the only fade slot; rank by crowdedness, no rotation needed.
    const pick = ranked[0];
    if (!pick) return {};
    const tag = pick.side === "short" ? "crowd-short" : "washout-long";
    return {
      [`FADE_${pick.side === "short" ? "SHORT" : "LONG"}_${pick.coin}`]: {
        desc: `${tag} fundZ ${pick.fundingZ.toFixed(1)}, 24h ${pick.ret24hPct.toFixed(1)}%`,
        intent: { kind: "open", instId: pick.instId, side: pick.side, sizeFrac: 1, setup: "strict" },
      },
    };
  },

  forcedEntry() {
    return null;
  },

  sizeFrac(intent, _conviction, ctx) {
    // Risk-normalized: notional = 1% equity / stop distance. No dollar floor —
    // fades are rare and wide-stopped; the floor logic belongs to high-frequency
    // styles, not this one. Falls back to the fixed fraction without ATR data.
    if (intent.kind === "open" || intent.kind === "switch") {
      const s = ctx.view.stats.get(intent.instId);
      if (s && s.atr14Pct !== null && s.mid > 0) {
        const distFrac = (s.atr14Pct / 100) * ctx.knobs.stopAtrMult;
        const max = maxNotionalUsd(ctx);
        if (distFrac > 0 && max > 0) {
          return Math.max(0, Math.min(1, (FADE_RISK_PCT_EQUITY * ctx.bee.equityUsd) / (distFrac * max)));
        }
      }
    }
    return intent.sizeFrac;
  },

  stopFor(instId, side, entryPx, ctx) {
    // Wide on purpose: crowded positioning overshoots before it breaks.
    return atrStop(ctx.view.stats.get(instId), side, entryPx, ctx.knobs.stopAtrMult);
  },

  // Trim half at +1R, close the rest at +2R (ladder rung frac 1.0 = full exit),
  // BE at +0.75R. trimAtR > breakevenAtR so BE fires on its own.
  takeProfit: { trimAtR: 1, trimFrac: 0.5, breakevenAtR: 0.75, feeBufferR: 0.05, ladder: { everyR: 1, frac: 1.0 } },
};
