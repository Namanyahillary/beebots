// ash-bee (bee4, "Ash"): dip-buying inside weekly trends. See strategies/PULLBACK.md.
// Buys mild 15m weakness inside established 7-day trends with funding NOT crowded
// (the mirror of Rook's crowded-only rule), mirrored short. The fee-triangle
// favorite: 2R targets at ~0.05R tolls need only +1.6pp of edge. Rule-driven,
// neverForce, strict only.
import type { CoinStats } from "../market/types.js";
import { maxNotionalUsd, r2 } from "./common.js";
import type { BeeBrain, BeeContext, IdleDetail, Menu, Side } from "./types.js";

/** Trend bar: |7-day return| at least this far (established trend, not noise). */
export const PULLBACK_MIN_TREND_PCT = 8;
/** Funding must NOT be crowded (mirror of Rook's rule): longs need z ≤ +1, shorts z ≥ -1. */
export const PULLBACK_MAX_FUNDING_Z = 1.0;
/** Not mid-dump/pump on the 1h (pauses, not knives). */
export const PULLBACK_MAX_COUNTER_1H_PCT = 1.0;
/** Risk 1% of book equity per pullback, stop-distance sized. */
export const PULLBACK_RISK_PCT_EQUITY = 0.01;
/** A dip that hasn't resumed in 12h was a reversal — close it. */
export const PULLBACK_TIME_STOP_MIN = 720;

export interface PullbackSetup {
  instId: string;
  coin: string;
  side: Side;
}

const inRange = (x: number | null, lo: number, hi: number) => x !== null && x >= lo && x <= hi;

/** Strict trend-dip long / rally-fade short. Null = no setup. */
export function pullbackSetup(s: CoinStats): PullbackSetup | null {
  if (s.ret7dPct === null || s.ret1hPct === null) return null;
  if (s.ret7dPct >= PULLBACK_MIN_TREND_PCT) {
    if (!inRange(s.rsi14, 30, 42)) return null;
    if (!inRange(s.pctB, 0, 0.25)) return null;
    if (s.fundingZ !== null && s.fundingZ > PULLBACK_MAX_FUNDING_Z) return null;
    if (s.ret1hPct < -PULLBACK_MAX_COUNTER_1H_PCT) return null;
    if (s.trend && s.trend.score < 3) return null;
    return { instId: s.instId, coin: s.coin, side: "long" };
  }
  if (s.ret7dPct <= -PULLBACK_MIN_TREND_PCT) {
    if (!inRange(s.rsi14, 58, 70)) return null;
    if (!inRange(s.pctB, 0.75, 1)) return null;
    if (s.fundingZ !== null && s.fundingZ < -PULLBACK_MAX_FUNDING_Z) return null;
    if (s.ret1hPct > PULLBACK_MAX_COUNTER_1H_PCT) return null;
    return { instId: s.instId, coin: s.coin, side: "short" };
  }
  return null;
}

function pullbackStats(ctx: BeeContext): CoinStats[] {
  return ctx.view.gated
    .map((id) => ctx.view.stats.get(id))
    .filter((s): s is CoinStats => !!s && s.spreadBp <= ctx.knobs.spreadGateBps);
}

/** Strongest trend first. */
export function rankPullbacks(ctx: BeeContext): PullbackSetup[] {
  return pullbackStats(ctx)
    .map((s) => ({ s, setup: pullbackSetup(s) }))
    .filter((x): x is { s: CoinStats; setup: PullbackSetup } => !!x.setup)
    .sort((a, b) => Math.abs(b.s.ret7dPct!) - Math.abs(a.s.ret7dPct!))
    .map((x) => x.setup);
}

/** Nearest setup by smallest gate miss (for the idle line). */
function nearestPullback(ctx: BeeContext): { coin: string; why: string; mid: number } | null {
  const rows = pullbackStats(ctx)
    .filter((s) => s.ret7dPct !== null)
    .map((s) => {
      const tr = Math.abs(s.ret7dPct!);
      const miss = tr >= PULLBACK_MIN_TREND_PCT ? 0 : PULLBACK_MIN_TREND_PCT - tr;
      return { coin: s.coin, miss, mid: s.mid, why: miss > 0 ? "trend not established yet" : "dip not presenting yet" };
    })
    .sort((a, b) => a.miss - b.miss);
  return rows[0] ?? null;
}

export const pullback: BeeBrain = {
  id: "pullback",
  triggers: ["trend-dip", "trend-rally-fade"],
  strategy:
    "You are ash-bee, patient dip-buyer. You buy mild 15-minute dips inside established 7-day uptrends (RSI 30-42, inside the bands, funding NOT crowded), and mirror it short on downtrends. Stop 2x ATR with an 80bp floor, single exit at +2R, breakeven at +1R, dead in 12 hours. Rare by construction. (Rule-driven: the code executes this, Jev is never asked.)",
  convictionLabels: ["cold", "patient", "trending", "dipping"],
  neverForce: true,
  requiresStrictSetup: true,
  /** Rule-driven entries: the engine takes the single setup without asking Jev. */
  ruleDriven: true,
  timeStopMinutes: () => PULLBACK_TIME_STOP_MIN,

  idleStatus(ctx) {
    const p = ctx.bee.position;
    if (p) return `riding the dip ${p.side} ${p.coin}${ctx.uplR !== null ? ` ${ctx.uplR >= 0 ? "+" : ""}${ctx.uplR.toFixed(1)}R` : ""} (12h time stop)`;
    const near = nearestPullback(ctx);
    return near ? `${near.coin}: ${near.why}` : "no trend worth dipping into";
  },

  idleDetail(ctx): IdleDetail | null {
    if (ctx.bee.position) return null;
    const near = nearestPullback(ctx);
    return near ? { label: "Waiting for the dip", coin: near.coin, midPx: near.mid } : null;
  },

  universe(ctx) {
    return pullbackStats(ctx).map((s) => s.instId);
  },

  snapshotCoins(ctx) {
    const ids = new Set(this.universe(ctx));
    if (ctx.bee.position) ids.add(ctx.bee.position.instId);
    return [...ids];
  },

  coinSnapshot(s) {
    return {
      r7d_pct: r2(s.ret7dPct, 1),
      rsi14: r2(s.rsi14, 0),
      pct_b: r2(s.pctB, 2),
      fund_z: r2(s.fundingZ, 1),
    };
  },

  menu(ctx): Menu {
    // Flat: the strongest trend-dip, or nothing. Positioned: nothing — the stop,
    // the single exit, the BE and the time stop all fire in code.
    if (ctx.bee.position) return {};
    const pick = rankPullbacks(ctx)[0];
    if (!pick) return {};
    const tag = pick.side === "long" ? "trend-dip" : "trend-rally-fade";
    return {
      [`PULLBACK_${pick.side === "long" ? "LONG" : "SHORT"}_${pick.coin}`]: {
        desc: `${tag} 7d trend with 15m dip`,
        intent: { kind: "open", instId: pick.instId, side: pick.side, sizeFrac: 1, setup: "strict" },
      },
    };
  },

  forcedEntry() {
    return null;
  },

  sizeFrac(intent, _conviction, ctx) {
    // Risk-normalized: 1% equity / stop distance. No dollar floor (rare
    // wide-stopped trends, not high-frequency). Falls back without ATR data.
    if (intent.kind === "open" || intent.kind === "switch") {
      const s = ctx.view.stats.get(intent.instId);
      if (s && s.atr14Pct !== null && s.mid > 0) {
        const distFrac = Math.max((s.atr14Pct / 100) * ctx.knobs.stopAtrMult, 0.008);
        const max = maxNotionalUsd(ctx);
        if (distFrac > 0 && max > 0) {
          return Math.max(0, Math.min(1, (PULLBACK_RISK_PCT_EQUITY * ctx.bee.equityUsd) / (distFrac * max)));
        }
      }
    }
    return intent.sizeFrac;
  },

  stopFor(instId, side, entryPx, ctx) {
    // 2x ATR with an 80bp floor (fee-triangle: stops tighter than 80bp donate more
    // than 0.75R per round trip — banned by construction, not by review).
    const s = ctx.view.stats.get(instId);
    const atrDist = s && s.atr14Pct !== null ? entryPx * (s.atr14Pct / 100) * ctx.knobs.stopAtrMult : 0;
    const dist = Math.max(atrDist, entryPx * 0.008);
    if (!(dist > 0)) return null;
    return side === "long" ? entryPx - dist : entryPx + dist;
  },

  // Single exit at +2R (full close through the trim path), BE at +1R.
  // trimAtR > breakevenAtR so BE fires on its own.
  takeProfit: { trimAtR: 2, trimFrac: 1.0, breakevenAtR: 1, feeBufferR: 0.05 },
};
