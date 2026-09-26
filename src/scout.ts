// Scout: pure shortlist screen for new opportunities (gain-and-exit philosophy).
//
// Pure function, no I/O, no clock, no randomness: given a MarketView it reports
// which coins pass the shortlist screen and why each other coin is excluded.
// LOG-ONLY integration: the caller may log the result, but must never gate
// today's trading on it (fail-open — the brains' own universe() still decides
// what trades). Do NOT wire this into any brain's universe().
import type { CoinStats, MarketView } from "./market/types.js";

/** Thresholds for the shortlist screen. Kept minimal and explicit so tests can fabricate them. */
export interface ScoutKnobs {
  /** Widest acceptable spread, in basis points (mirrors the bees' spreadGateBps). */
  spreadGateBps: number;
  /** Minimum 24h quote volume in USD (mirrors the universe min24hVolUsd). */
  min24hVolUsd: number;
}

export interface ScoutExclusion {
  instId: string;
  reasons: string[];
}

/**
 * Direction context stored alongside each eligible instId (LOG-ONLY screening
 * context, never a trade recommendation): how far the price is from the live
 * breakout trigger and the sign of the trend score, where that data exists.
 * Nulls mean "no data" (coin without breakout/trend coverage).
 */
export interface ScoutEligibleEntry {
  instId: string;
  /** (trigger-mid)/mid*100; negative = already through the trigger. Null when no breakout data. */
  toTriggerPct: number | null;
  /** Sign of trend.score (-1|0|1). Null when no trend data. */
  trendSign: -1 | 0 | 1 | null;
}

export interface ScoutResult {
  /** Passed every screen, sorted by 24h USD volume descending (mirrors the gated ranking). */
  eligible: string[];
  /** Failed at least one screen, in view.stats iteration order, with one reason per failed screen. */
  excluded: ScoutExclusion[];
}

/** Max excluded entries stored per snapshot: bounds row size while keeping the why-not visible. */
export const SCOUT_EXCLUDED_SAMPLE = 10;

/** instIds of an eligible list, whether legacy plain strings or enriched entries. */
export function eligibleIds(list: Array<string | { instId: string }>): string[] {
  return list.map((e) => (typeof e === "string" ? e : e.instId));
}

/**
 * Order-insensitive eligible-set equality: a volume-rank flip that changes the
 * order but not the membership is not a transition worth logging. Compares
 * instId SETS only — enrichment wiggles (proximity pct, trend sign) alone are
 * never a transition. Accepts legacy string lists and enriched entries.
 */
export function eligibleSetEqual(a: Array<string | { instId: string }>, b: Array<string | { instId: string }>): boolean {
  const ai = eligibleIds(a);
  const bi = eligibleIds(b);
  if (ai.length !== bi.length) return false;
  const set = new Set(ai);
  return bi.every((x) => set.has(x));
}

/**
 * Trigger proximity in pct: (trigger-mid)/mid*100, negative = price already
 * through the trigger. Null when there is no breakout data or mid is unusable.
 */
export function toTriggerPctFor(s: CoinStats): number | null {
  const t = s.breakout?.trigger;
  if (t === null || t === undefined || !Number.isFinite(t)) return null;
  if (!(s.mid > 0) || !Number.isFinite(s.mid)) return null;
  return ((t - s.mid) / s.mid) * 100;
}

/** Sign of the trend score (-1|0|1), null when the coin has no trend data. */
export function trendSignFor(s: CoinStats): -1 | 0 | 1 | null {
  const score = s.trend?.score;
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  return score > 0 ? 1 : score < 0 ? -1 : 0;
}

/**
 * Enrich each eligible instId with direction context from the live view.
 * Pure: never mutates the view. Missing coins/data yield nulls (never throws).
 */
export function enrichEligible(eligible: string[], view: MarketView): ScoutEligibleEntry[] {
  return eligible.map((instId) => {
    const s = view.stats.get(instId);
    return {
      instId,
      toTriggerPct: s ? toTriggerPctFor(s) : null,
      trendSign: s ? trendSignFor(s) : null,
    };
  });
}

/** Top-`limit` excluded by 24h USD volume, so the stored why-not stays bounded. */
export function sampleExcluded(excluded: ScoutExclusion[], volById: (instId: string) => number, limit = SCOUT_EXCLUDED_SAMPLE): ScoutExclusion[] {
  return [...excluded].sort((x, y) => volById(y.instId) - volById(x.instId)).slice(0, limit);
}

function screenOne(s: CoinStats, knobs: ScoutKnobs): string[] {
  const reasons: string[] = [];
  // 1. Spread gate: wide spreads eat the gain-and-exit edge on entry and trim.
  if (!(s.spreadBp <= knobs.spreadGateBps)) reasons.push(`spread ${s.spreadBp}bp > ${knobs.spreadGateBps}bp gate`);
  // 2. Minimum 24h volume/notional: thin coins cannot fill at size without slippage.
  if (!(s.vol24hUsd >= knobs.min24hVolUsd)) reasons.push(`24h vol $${s.vol24hUsd} < $${knobs.min24hVolUsd} minimum`);
  // 3. Funding-data presence: brains need the live rate AND the 30d z to apply
  // the funding veto on longs, so both must be present.
  if (s.fundingPct === null || s.fundingZ === null) reasons.push("missing funding data");
  // 4. Trend-data availability: at least a day of 1h history (24h return) so
  // momentum can be ranked. The 7d return is optional (brains fall back to 24h).
  if (s.ret24hPct === null) reasons.push("missing trend data (no 24h return)");
  return reasons;
}

/**
 * Screen every coin in view.stats through the shortlist gates.
 * Pure: never mutates the view, never throws on missing/NaN fields (a failed
 * comparison simply excludes with a reason). Fail-open by design: the caller
 * logs the outcome and keeps trading the brains' own universes.
 */
export function screenUniverse(view: MarketView, knobs: ScoutKnobs): ScoutResult {
  const eligible: Array<{ instId: string; vol: number }> = [];
  const excluded: ScoutExclusion[] = [];
  for (const s of view.stats.values()) {
    const reasons = screenOne(s, knobs);
    if (reasons.length === 0) eligible.push({ instId: s.instId, vol: s.vol24hUsd });
    else excluded.push({ instId: s.instId, reasons });
  }
  eligible.sort((a, b) => b.vol - a.vol);
  return { eligible: eligible.map((e) => e.instId), excluded };
}
