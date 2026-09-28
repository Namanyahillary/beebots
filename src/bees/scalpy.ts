// scalpy-bee (bee4 "Dash", bee5 "Zip"): fast day-trader. See strategies/SCALPER.md.
// One setup only — 15m Donchian micro-breakout, longs only, on the whole gated
// list — with rule-driven entries: Jev is never asked (1-3s of reasoning latency
// is a lifetime at this timescale), the code takes the setup when it triggers
// and the stop / TP ladder / time stop do the rest. Every number is guilty
// until the 30-scalp gate judges it.
import type { CoinStats } from "../market/types.js";
import { atrStop, maxNotionalUsd, r2 } from "./common.js";
import type { BeeBrain, BeeContext, IdleDetail, Menu } from "./types.js";

/** The whole gated list (volume + spread screened), not a hardcoded trio: the 5bp
 *  spread gate and the volume confirm do the excluding empirically. Thin coins
 *  fail the gates on their own; no allowlist to maintain. */
function scalpStats(ctx: BeeContext): CoinStats[] {
  return ctx.view.gated
    .map((id) => ctx.view.stats.get(id))
    .filter((s): s is CoinStats => !!s && !!s.micro && s.spreadBp <= ctx.knobs.spreadGateBps);
}
/** The 15m bar must be at least this many x its 24h median volume. */
export const MICRO_MIN_VOL_RATIO = 1.2;
/** Chase guard (post-SOL-consensus): a micro-high more than this far below the
 *  touch is a missed break, not an entry. Market-take within, never chase past. */
export const MICRO_MAX_CHASE_BPS = 30;
/** Risk 0.5% of book equity per scalp, stop-distance sized like boozy. */
export const SCALP_RISK_PCT_EQUITY = 0.005;
/** Fee wall: 5bp taker each way donates 30-60% of sub-$5 targets, so the dollar
 *  risk (and therefore the +1R target) never drops below $5. On a $333 book
 *  that means 1.5% risk per scalp — spicy, and exactly what the 30-scalp
 *  review re-judges (fee drag is measured per trade). */
export const SCALP_MIN_TARGET_USD = 5;
/** A scalp still open at 45 minutes is a failed scalp: market-close it. */
export const SCALPY_TIME_STOP_MIN = 45;

export interface MicroSetup {
  instId: string;
  coin: string;
  /** % the touch sits above the 20-bar micro-high (≥ 0 = through it). */
  gapPct: number;
  volRatio: number;
}

/** Strict micro-long: through the 20x15m high, inside the chase guard, volume-confirmed. */
export function microSetup(s: CoinStats): MicroSetup | null {
  const m = s.micro;
  if (!m || m.volRatio === null) return null;
  if (!(s.mid > m.hiN)) return null;
  const gapPct = ((s.mid - m.hiN) / m.hiN) * 100;
  if (gapPct > MICRO_MAX_CHASE_BPS / 100) return null;
  if (m.volRatio < MICRO_MIN_VOL_RATIO) return null;
  return { instId: s.instId, coin: s.coin, gapPct, volRatio: m.volRatio };
}

/** Freshest break first (smallest non-negative gap), volume breaks ties. */
export function pickScalp(ctx: BeeContext): MicroSetup | null {
  return scalpStats(ctx)
    .map((s) => microSetup(s))
    .filter((x): x is MicroSetup => !!x)
    .sort((a, b) => a.gapPct - b.gapPct || b.volRatio - a.volRatio)[0] ?? null;
}

/** Nearest micro-high by % still to rise (null = no micro data). Whole gated list. */
function nearestOwn(ctx: BeeContext): { coin: string; pct: number; mid: number } | null {
  const rows = scalpStats(ctx)
    .map((s) => ({ coin: s.coin, pct: s.micro ? ((s.micro.hiN - s.mid) / s.mid) * 100 : null, mid: s.mid }))
    .filter((x): x is { coin: string; pct: number; mid: number } => x.pct !== null)
    .sort((a, b) => a.pct - b.pct);
  return rows[0] ?? null;
}

export const scalpy: BeeBrain = {
  id: "scalpy",
  triggers: ["micro-breakout"],
  strategy:
    "You are scalpy-bee, the fast day-trader. You fish the 15-60 minute wiggle on every liquid coin: when the price breaks above its 20-bar 15-minute high on 1.2x median volume, inside a 30bp chase guard, you take it long at risk-normalized size with a 0.75x ATR stop, trim half at +0.5R, close the rest at +1R, and time-stop anything alive at 45 minutes. Small, frequent, out fast. (Rule-driven: the code executes this, Jev is never asked.)",
  convictionLabels: ["cold", "warm", "hot", "gone"],
  neverForce: true,
  requiresStrictSetup: true,
  /** Rule-driven entries: the engine takes the single setup without asking Jev. */
  ruleDriven: true,
  timeStopMinutes: () => SCALPY_TIME_STOP_MIN,

  idleStatus(ctx) {
    const p = ctx.bee.position;
    if (p) return `riding SCALP_${p.coin}${ctx.uplR !== null ? ` ${ctx.uplR >= 0 ? "+" : ""}${ctx.uplR.toFixed(1)}R` : ""} (45m time stop)`;
    const own = nearestOwn(ctx);
    return own ? `${own.coin} is ${own.pct.toFixed(2)}% from its micro-high` : "waiting for a micro-breakout";
  },

  idleDetail(ctx): IdleDetail | null {
    if (ctx.bee.position) return null;
    const own = nearestOwn(ctx);
    return own ? { label: "Stalking the micro-break", coin: own.coin, pctAway: own.pct, midPx: own.mid } : null;
  },

  universe(ctx) {
    return scalpStats(ctx).map((s) => s.instId);
  },

  snapshotCoins(ctx) {
    const ids = new Set(this.universe(ctx));
    if (ctx.bee.position) ids.add(ctx.bee.position.instId);
    return [...ids];
  },

  coinSnapshot(s) {
    const gap = s.micro ? ((s.mid - s.micro.hiN) / s.micro.hiN) * 100 : null;
    return {
      micro_gap_pct: r2(gap),
      vol_ratio: r2(s.micro?.volRatio ?? null, 1),
      atr15_pct: r2(s.atr14Pct, 2),
      spread_bp: r2(s.spreadBp, 1),
    };
  },

  menu(ctx): Menu {
    // Flat: the one setup, or nothing (no question for Jev either way — ruleDriven).
    // Positioned: nothing — the stop, the TP ladder and the time stop all fire in code.
    if (ctx.bee.position) return {};
    const pick = pickScalp(ctx);
    if (!pick) return {};
    return {
      [`SCALP_${pick.coin}`]: {
        desc: `micro-break +${pick.gapPct.toFixed(2)}%, vol ${pick.volRatio.toFixed(1)}x median`,
        intent: { kind: "open", instId: pick.instId, side: "long", sizeFrac: 1, setup: "strict" },
      },
    };
  },

  forcedEntry() {
    return null;
  },

  sizeFrac(intent, _conviction, ctx) {
    // Risk-normalized like boozy: notional = dollar risk / stop distance, so a
    // stopped-out scalp costs ~0.5% of equity — floored so the +1R target clears
    // the $5 fee wall. Falls back to the fixed fraction when no stop is computable.
    if (intent.kind === "open" || intent.kind === "switch") {
      const s = ctx.view.stats.get(intent.instId);
      const stopMult = ctx.knobs.stopAtrMult;
      if (s && s.atr14Pct !== null && s.mid > 0) {
        const distFrac = (s.atr14Pct / 100) * stopMult;
        const max = maxNotionalUsd(ctx);
        if (distFrac > 0 && max > 0) {
          const riskUsd = Math.max(SCALP_RISK_PCT_EQUITY * ctx.bee.equityUsd, SCALP_MIN_TARGET_USD);
          return Math.max(0, Math.min(1, riskUsd / (distFrac * max)));
        }
      }
    }
    return intent.sizeFrac;
  },

  stopFor(instId, side, entryPx, ctx) {
    // Hard stop at 0.75x ATR(15m), set at fill. No widening, ever.
    return atrStop(ctx.view.stats.get(instId), side, entryPx, ctx.knobs.stopAtrMult);
  },

  // Trim half at +0.5R, close the rest at +1R (ladder rung frac 1.0 = full exit
  // through the existing trim path), BE at +0.3R with a tight fee buffer —
  // scalps give back fast. trimAtR > breakevenAtR so BE fires on its own
  // (trimFirst = false).
  takeProfit: { trimAtR: 0.5, trimFrac: 0.5, breakevenAtR: 0.3, feeBufferR: 0.05, ladder: { everyR: 0.5, frac: 1.0 } },
};
