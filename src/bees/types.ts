import type { BeeId, BeeKnobs, Config } from "../config.js";
import type { StyleId } from "../settings.js";
import type { CoinStats, MarketView } from "../market/types.js";

export type Side = "long" | "short";

export interface Position {
  instId: string;
  coin: string;
  side: Side;
  contracts: number;
  /** USD notional per contract at entry = ctVal x entry price. */
  entryPx: number;
  openedAt: number;
  /** Hard stop price, set by code at entry and trailed by the risk layer. */
  stopPx: number | null;
  /** USD at risk at entry (notional x stop distance). 1R. */
  riskUsd: number;
  /** breezy: ensemble score at entry, for TRIM_HALF. */
  entryScore?: number;
  /** R-multiple at which a take-profit trim fired (null = not yet triggered; persisted, survives reconcile). */
  trimmedAtR?: number | null;
  /** True once the stop has been moved to breakeven (false = not yet triggered; persisted, survives reconcile). */
  beMoved?: boolean;
}

/** Per-brain opt-in take-profit / breakeven policy (R-multiples; never universal). */
export interface TakeProfitPolicy {
  trimAtR: number;
  trimFrac: number;
  breakevenAtR: number;
  feeBufferR: number;
}

export type CapReason = "trade_cap" | "fee_budget" | "loss_stop" | "retired";

export interface BeeState {
  id: BeeId;
  /** Realised cash: start equity + realised P&L - fees + funding (ledger). */
  cashUsd: number;
  /** Mark-to-market equity = cash + unrealised P&L. */
  equityUsd: number;
  uplUsd: number;
  dayKey: string;
  dayStartEquityUsd: number;
  position: Position | null;
  /** When the bee last became flat (ms), or null while positioned. */
  flatSince: number | null;
  tradesToday: number;
  feesTodayUsd: number;
  lastOrderAt: number | null;
  /** Active cap until 00:00 UTC (or forever for "retired"). */
  cap: CapReason | null;
  totals: { feesUsd: number; fundingUsd: number; jevUsd: number; realisedUsd: number; decisions: number; orders: number };
  /** boozy: who was #1 on the previous hourly rank, and for how many ranks in a row. */
  top1: { coin: string | null; streak: number; rankedAt: number };
}

/** Structured idle state for a flat bee with nothing on the menu (drives the
 * dashboard proximity bar; data, never parsed from the status string). */
export interface IdleDetail {
  label: string;
  coin?: string;
  pctAway?: number;
}

/** What a menu option means, in code. The risk layer turns this into a final action. */
export type Intent =
  | { kind: "hold" }
  | { kind: "open"; instId: string; side: Side; sizeFrac: number; setup: "strict" | "loose" }
  | { kind: "close"; reason: string }
  | { kind: "switch"; instId: string; side: Side; sizeFrac: number; setup: "strict" | "loose" }
  | { kind: "add"; sizeFrac: number }
  | { kind: "trim"; fraction: number };

/** What the risk layer lets through to execution. Sizes are resolved to USD notional. */
export type Action =
  | { kind: "none" }
  | { kind: "open"; instId: string; side: Side; notionalUsd: number }
  | { kind: "close"; reason: string }
  | { kind: "switch"; instId: string; side: Side; notionalUsd: number }
  | { kind: "add"; notionalUsd: number }
  | { kind: "trim"; fraction: number };

export interface MenuOption {
  /** null when the label says it all (saves Jev tokens). */
  desc: string | null;
  intent: Intent;
}
export type Menu = Record<string, MenuOption>;

export interface BeeContext {
  bee: BeeState;
  view: MarketView;
  cfg: Config;
  knobs: BeeKnobs;
  now: number;
  /** Unrealised P&L of the open position, in R (null when flat). */
  uplR: number | null;
}

export interface BeeBrain {
  id: StyleId;
  /** Condensed from strategies/<BEE>.md; sent to Jev as the question instructions. */
  strategy: string;
  /** Entry triggers this brain can act on (capability label for the dashboard; no trading effect). */
  triggers?: string[];
  convictionLabels: readonly [string, string, string, string];
  /** instIds this bee may open right now (already gated). */
  universe(ctx: BeeContext): string[];
  menu(ctx: BeeContext): Menu;
  /** Per-coin numbers for this bee's snapshot. */
  coinSnapshot(s: CoinStats, ctx: BeeContext): Record<string, number | string | null>;
  /** Coins shown in the snapshot (instIds). */
  snapshotCoins(ctx: BeeContext): string[];
  /** Drama rule 2: what the code forces when this bee has been flat too long. null = nothing possible. */
  forcedEntry(ctx: BeeContext): Extract<Intent, { kind: "open" }> | null;
  /** Fraction of max notional for a chosen open, given conviction level 0..3. */
  sizeFrac(intent: Extract<Intent, { kind: "open" | "switch" }>, conviction: number, ctx: BeeContext): number;
  /** Stop price for a new position (code decides, not Jev). */
  stopFor(instId: string, side: Side, entryPx: number, ctx: BeeContext): number | null;
  /** Optional trailing stop candidate; the engine only ever ratchets the stop in the position's favour. */
  trail?(ctx: BeeContext): number | null;
  /** Minimum conviction level (0..3) and probability Jev needs for a discretionary open/switch. */
  openGate?: { minConviction: number; minProb: (ctx: BeeContext) => number };
  /** Discretionary opens must be a strict setup ("loose" picks wait for the max-flat forcing). */
  requiresStrictSetup?: boolean;
  /** Veto longs when the coin's 30-day funding z exceeds this. */
  fundingVetoLongZ?: number;
  /** Close any position older than this many minutes. */
  timeStopMinutes?: (ctx: BeeContext) => number;
  /** Code-side sizing: an add that brings an undersized position back to target (fires when Jev holds). */
  rebalance?: (ctx: BeeContext) => Extract<Intent, { kind: "add" }> | null;
  /** Opt-in take-profit / breakeven policy (per-brain only, never universal). */
  takeProfit?: TakeProfitPolicy;
  /** This bee waits for its setup instead of being forced in when flat (drama rule 2 does not apply). */
  neverForce?: boolean;
  /**
   * Rule-determined hold: when non-null (a human-readable reason), the code — not Jev —
   * dictates holding this tick (e.g. a commit window with no other available move).
   * The engine still runs full risk evaluation (stops/caps/vetoes fire); only the Jev
   * call is skipped. Return null whenever any real choice exists.
   */
  lockedHold?: (ctx: BeeContext) => string | null;
  /** Status line while flat with nothing on the menu (e.g. "waiting for a breakout"). */
  idleStatus?: (ctx: BeeContext) => string;
  /** Structured version of the idle state (for the dashboard proximity bar).
   * Brains without it keep today's behavior exactly (no idle payload). */
  idleDetail?: (ctx: BeeContext) => IdleDetail | null;
}

export const coinOf = (instId: string) => instId.split("-")[0]!;
