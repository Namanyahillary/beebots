// echo-bee (bee7, "Echo"): Bollinger-RSI mean reversion. See strategies/BOUNCE.md.
// The building's first strategy (Z1 fade), retired into bizzy.ts as reference
// helpers when Grim became a breakout hunter, promoted back into a living wolf:
// strict statistical extremes with modern gates. Reuses fadeSetup verbatim —
// one definition of the setup, two consumers (reference tests + this brain).
// Distinct from Rook: Echo fades PRICE extremes, Rook fades POSITIONING extremes.
import type { CoinStats } from "../market/types.js";
import { atrStop, maxNotionalUsd, r2 } from "./common.js";
import { fadeSetup } from "./bizzy.js";
import type { BeeBrain, BeeContext, IdleDetail, Menu } from "./types.js";

/** Risk 1% of book equity per revert, stop-distance sized. */
export const BOUNCE_RISK_PCT_EQUITY = 0.01;
/** A stretch that hasn't snapped back in 8h is a regime, not a stretch. */
export const BOUNCE_TIME_STOP_MIN = 480;

function bounceStats(ctx: BeeContext): CoinStats[] {
  return ctx.view.gated
    .map((id) => ctx.view.stats.get(id))
    .filter((s): s is CoinStats => !!s && s.spreadBp <= ctx.knobs.spreadGateBps);
}

/** Strict setups only (fadeSetup returns null for anything loose). Most stretched first. */
export function rankBounces(ctx: BeeContext) {
  return bounceStats(ctx)
    .map((s) => fadeSetup(s))
    .filter((x): x is NonNullable<ReturnType<typeof fadeSetup>> => !!x)
    .sort((a, b) => b.stretch - a.stretch);
}

/** Nearest stretch by RSI distance to its trigger (30 below / 70 above). */
function nearestStretch(ctx: BeeContext): { coin: string; why: string; mid: number } | null {
  const rows = bounceStats(ctx)
    .filter((s) => s.rsi14 !== null)
    .map((s) => {
      const r = s.rsi14!;
      const longGap = r < 30 ? 0 : r - 30;
      const shortGap = r > 70 ? 0 : 70 - r;
      const gap = Math.min(longGap, shortGap);
      const why = longGap <= shortGap ? `RSI ${r.toFixed(0)} (long trigger < 30)` : `RSI ${r.toFixed(0)} (short trigger > 70)`;
      return { coin: s.coin, gap, why, mid: s.mid };
    })
    .sort((a, b) => a.gap - b.gap);
  return rows[0] ?? null;
}

export const bounce: BeeBrain = {
  id: "bounce",
  triggers: ["oversold-bounce", "overbought-fade"],
  strategy:
    "You are echo-bee, the mean-reverter. You buy stretched selloffs and short stretched rallies on every liquid coin: long when RSI drops below 30 with price outside the lower Bollinger band (never into crowded longs), short when RSI tops 70 above the upper band. Wide 1.5x ATR stops because stretches extend, trim half at +1R, out at +2R, dead in 8 hours. Rare by construction. (Rule-driven: the code executes this, Jev is never asked.)",
  convictionLabels: ["cold", "patient", "stretched", "snapping"],
  neverForce: true,
  requiresStrictSetup: true,
  /** Rule-driven entries: the engine takes the single setup without asking Jev. */
  ruleDriven: true,
  timeStopMinutes: () => BOUNCE_TIME_STOP_MIN,

  idleStatus(ctx) {
    const p = ctx.bee.position;
    if (p) return `fading the stretch ${p.side} ${p.coin}${ctx.uplR !== null ? ` ${ctx.uplR >= 0 ? "+" : ""}${ctx.uplR.toFixed(1)}R` : ""} (8h time stop)`;
    const near = nearestStretch(ctx);
    return near ? `${near.coin}: ${near.why}` : "nothing stretched enough to fade";
  },

  idleDetail(ctx): IdleDetail | null {
    if (ctx.bee.position) return null;
    const near = nearestStretch(ctx);
    return near ? { label: "Waiting for the snap-back", coin: near.coin, midPx: near.mid } : null;
  },

  universe(ctx) {
    return bounceStats(ctx).map((s) => s.instId);
  },

  snapshotCoins(ctx) {
    const ids = new Set(this.universe(ctx));
    if (ctx.bee.position) ids.add(ctx.bee.position.instId);
    return [...ids];
  },

  coinSnapshot(s) {
    return {
      rsi14: r2(s.rsi14, 0),
      pct_b: r2(s.pctB, 2),
      fund_z: r2(s.fundingZ, 1),
      spread_bp: r2(s.spreadBp, 1),
    };
  },

  menu(ctx): Menu {
    // Flat: the most stretched strict setup, or nothing. Positioned: nothing —
    // the stop, the ladder and the time stop all fire in code.
    if (ctx.bee.position) return {};
    const ranked = rankBounces(ctx);
    const pick = ranked[0];
    if (!pick) return {};
    const tag = pick.side === "long" ? "oversold-bounce" : "overbought-fade";
    return {
      [`BOUNCE_${pick.side === "long" ? "LONG" : "SHORT"}_${pick.coin}`]: {
        desc: `${tag} RSI ${tag === "oversold-bounce" ? "under 30" : "over 70"}, outside the band`,
        intent: { kind: "open", instId: pick.instId, side: pick.side, sizeFrac: 1, setup: "strict" },
      },
    };
  },

  forcedEntry() {
    return null;
  },

  sizeFrac(intent, _conviction, ctx) {
    // Risk-normalized: 1% equity / stop distance. No dollar floor (rare
    // wide-stopped fades, not high-frequency). Falls back without ATR data.
    if (intent.kind === "open" || intent.kind === "switch") {
      const s = ctx.view.stats.get(intent.instId);
      if (s && s.atr14Pct !== null && s.mid > 0) {
        const distFrac = (s.atr14Pct / 100) * ctx.knobs.stopAtrMult;
        const max = maxNotionalUsd(ctx);
        if (distFrac > 0 && max > 0) {
          return Math.max(0, Math.min(1, (BOUNCE_RISK_PCT_EQUITY * ctx.bee.equityUsd) / (distFrac * max)));
        }
      }
    }
    return intent.sizeFrac;
  },

  stopFor(instId, side, entryPx, ctx) {
    // Extension beyond the extreme is invalidation: 1.5x ATR against.
    return atrStop(ctx.view.stats.get(instId), side, entryPx, ctx.knobs.stopAtrMult);
  },

  // Trim half at +1R, close the rest at +2R (ladder rung frac 1.0 = full exit),
  // BE at +0.75R. trimAtR > breakevenAtR so BE fires on its own.
  takeProfit: { trimAtR: 1, trimFrac: 0.5, breakevenAtR: 0.75, feeBufferR: 0.05, ladder: { everyR: 1, frac: 1.0 } },
};
