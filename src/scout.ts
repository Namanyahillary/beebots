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

export interface ScoutResult {
  /** Passed every screen, sorted by 24h USD volume descending (mirrors the gated ranking). */
  eligible: string[];
  /** Failed at least one screen, in view.stats iteration order, with one reason per failed screen. */
  excluded: ScoutExclusion[];
}

/** Max excluded entries stored per snapshot: bounds row size while keeping the why-not visible. */
export const SCOUT_EXCLUDED_SAMPLE = 10;

/**
 * Order-insensitive eligible-set equality: a volume-rank flip that changes the
 * order but not the membership is not a transition worth logging.
 */
export function eligibleSetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
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
