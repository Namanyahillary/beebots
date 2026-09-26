// Mirrors the engine's read-only /snapshot and SSE payloads. No account data exists in these shapes.
import { BEE_MARK_URL } from "./BeeMark";

/** The three bee slots. Names, taglines and portraits come from the engine's /profile (set on the Setup page). */
export type BeeName = "bee1" | "bee2" | "bee3";
export const BEE_NAMES: BeeName[] = ["bee1", "bee2", "bee3"];

export type Cap = "trade_cap" | "fee_budget" | "loss_stop" | "retired" | null;

export interface LastDecision {
  choice: string | null;
  top3: Array<[string, number]>;
  confidence: number | null;
  latencyMs: number | null;
  status: string;
  ts: number;
  /** Structured idle state for a flat waiting bee (proximity bar data; absent for other bees). */
  idle?: { label: string; coin?: string; pctAway?: number } | null;
}

export interface PublicBee {
  bee: BeeName;
  /** Slot's engine style ("bizzy"/"breezy"/"boozy"); drives the engine badge. */
  style: string;
  /** Entry triggers this brain can act on; present only when the brain declares any. */
  triggers?: string[];
  equityUsd: number;
  pnlUsd: number;
  pnlPct: number;
  position: {
    coin: string;
    side: "long" | "short";
    sizeUsd: number | null;
    entryPx: number;
    markPx: number | null;
    stopPx: number | null;
    uplUsd: number;
    minutesHeld: number;
  } | null;
  flatMinutes: number | null;
  tradesToday: number;
  maxTradesPerDay: number;
  feesTodayUsd: number;
  feeBudgetUsd: number;
  cap: Cap;
  totals: { feesUsd: number; fundingUsd: number; jevUsd: number; realisedUsd: number; decisions: number; orders: number; jevCallsMade: number; jevCallsSkipped: number; jevSavedUsd: number };
  liqProxy: { ratio: number | null; max: number | null; samples: number };
  maxNotionalUsd: number;
  last: LastDecision | null;
}

/** Direction context on a scout eligible entry (screening context, never a trade recommendation). */
export interface ScoutEligibleEntry {
  instId: string;
  /** (trigger-mid)/mid*100; negative = through the trigger. Null when no breakout data. */
  toTriggerPct: number | null;
  /** Sign of trend.score (-1|0|1). Null when no trend data. */
  trendSign: -1 | 0 | 1 | null;
}

export interface ScoutSnapshot {
  ts: number;
  /** Enriched entries; rows stored before the enrichment read as plain instId strings. */
  eligible: Array<string | ScoutEligibleEntry>;
  excluded: Array<{ instId: string; reasons: string[] }>;
}

/** One row of GET /scout/history (newest first). */
export interface ScoutHistoryRow {
  id: number;
  ts: number;
  eligible: Array<string | ScoutEligibleEntry>;
  excluded: Array<{ instId: string; reasons: string[] }>;
}

export interface Snapshot {
  ts: number;
  mode: "dry" | "demo" | "live";
  closed?: { at: number; flat: boolean } | null;
  startedAt: number;
  startEquityUsd: number;
  tickMs: number;
  bees: PublicBee[];
  leaderboard: Array<{ bee: BeeName; equityUsd: number }>;
  totals: { feesUsd: number; fundingUsd: number; jevUsd: number; pnlUsd: number };
  jev: { spentTodayUsd: number; dailyCapUsd: number; capTripped: boolean; down: boolean; heartbeatTicks: number; callsMade: number; callsSkipped: number; estSavedUsd: number };
  recon: { ok: boolean | null; detail: string; ts: number };
  market: { refreshedAt: number; universe: string[]; spreadBlocked: Array<{ coin: string; spreadBp: number }>; attention: "news" | "volume" };
  /** Latest scout shortlist transition (log-only; nothing trades on it). Null until the first market refresh stores one. */
  scout: ScoutSnapshot | null;
  /** Account leverage setting: one isolated-margin leverage for every trade. */
  leverage: { max: number; mode: string };
  visitors?: { total: number; watching: number };
  /** Set when a newer GitHub Release exists than the version this install runs. */
  update?: { current: string; latest: string } | null;
}

export interface DecisionEvent {
  type: "decision";
  ts: number;
  bee: BeeName;
  choice: string | null;
  probabilities: Array<{ label: string; p: number }>;
  confidence: number | null;
  conviction: string | null;
  latencyMs: number | null;
  tokens: number | null;
  jevUsd: number;
  action: string;
  vetoedBy: string | null;
  forcedBy: string | null;
  status: string;
  jev: string;
  /** Labels Jev chose from this tick. Absent on benched rows, which ask nothing. */
  menu?: string[];
  /** DB decision id, for linking a fill to the decision that caused it. */
  decisionId?: number;
  /** True when Jev's answer was reused from cache instead of a fresh call. */
  cached?: boolean;
  /** A benched bee's live row: no Jev call, just its position P&L moving. */
  pulse?: boolean;
  /** Flat bee with nothing to ask Jev: what it is watching for (e.g. "SOL is 0.80% from breakout"). */
  watch?: string;
  /** Structured idle state on watching rows (mirrors LastDecision.idle; drives the proximity bar). */
  idle?: { label: string; coin?: string; pctAway?: number } | null;
  /** The bee's money at this moment: open P&L while positioned, total P&L when flat, and the move since its last row. */
  live?: { coin: string | null; side: "long" | "short" | null; valueUsd: number; kind: "open" | "total"; deltaUsd: number };
}

export interface FillEvent {
  type: "fill";
  ts: number;
  bee: BeeName;
  coin: string;
  side: "buy" | "sell";
  purpose: string;
  contracts: number;
  px: number;
  notionalUsd: number;
  feeUsd: number;
  realisedUsd: number;
  label: string;
  /** The decision that caused this fill. Absent on fills from before this field shipped. */
  decisionId?: number;
}

export interface CapEvent {
  type: "cap";
  ts: number;
  bee: BeeName;
  cap: Cap;
  detail: string;
}

export interface FundingEvent {
  type: "funding";
  ts: number;
  bee: BeeName;
  coin: string | null;
  amountUsd: number;
}

export type AnyEvent =
  | DecisionEvent
  | FillEvent
  | CapEvent
  | FundingEvent
  | { type: "equity"; ts: number; bees: PublicBee[] }
  | { type: "recon"; ts: number; ok: boolean; detail: string }
  | { type: "order" | "heartbeat" | "status"; ts: number; [k: string]: unknown };

export interface BeeMeta {
  short: string;
  tagline: string;
  styleLabel: string;
  /** The owner's rules for this bee (Setup), "" for the original three. */
  rules: string;
  coins: string[];
  img: string;
  color: string;
  glow: string;
}

/** Colours belong to the slot, so two bees on the same style still look different. Filled in from /profile at load. */
export const BEE_META: Record<BeeName, BeeMeta> = {
  bee1: { short: "Blaze", tagline: "the grinder", styleLabel: "Breakout", rules: "", coins: [], img: "/bees/bizzy.jpg", color: "var(--bizzy)", glow: "var(--bizzy-glow)" },
  bee2: { short: "Silver", tagline: "the calculated one", styleLabel: "Trend", rules: "", coins: [], img: "/bees/breezy.jpg", color: "var(--breezy)", glow: "var(--breezy-glow)" },
  bee3: { short: "Grim", tagline: "the degen", styleLabel: "Momentum", rules: "", coins: [], img: "/bees/boozy.jpg", color: "var(--boozy)", glow: "var(--boozy-glow)" },
};

export interface Profile {
  setup: boolean;
  mode: "dry" | "demo" | "live";
  links: { sponsor: string; code: string } | null;
  /** img null: a Setup-made bee without its portrait (the dashboard shows the placeholder mark). */
  bees: Array<{ id: BeeName; name: string; tagline: string; style: string; styleLabel: string; rules?: string; coins?: string[]; img: string | null }>;
}

export const PROFILE: { links: Profile["links"] } = { links: null };

export function applyProfile(p: Profile): void {
  PROFILE.links = p.links;
  for (const b of p.bees) {
    const m = BEE_META[b.id];
    if (!m) continue;
    m.short = b.name;
    m.tagline = b.tagline;
    m.styleLabel = b.styleLabel;
    m.rules = b.rules ?? "";
    m.coins = b.coins ?? [];
    m.img = b.img ?? BEE_MARK_URL;
  }
}

/** Shown on Setup and in the dashboard's Hive dialog. */
export const HIVE_DISCLAIMER =
  "You're about to share your bees' names, styles and paper-trading results on the public leaderboard at beebots.tech. The board shows % gain/loss only. No keys, no exchange account details, no IP address. Paper trading only. Not financial advice. You can leave any time.";

/** The engine's GET /hive/status. No hive id, no key. */
export interface HiveStatus {
  joined: boolean;
  /** false in MODE=live: the Hive is paper only. */
  paper: boolean;
  /** The leaderboard's base URL (HIVE_URL). */
  board: string;
  lastReportAt: number | null;
  verified: Record<string, boolean> | null;
  problem: string | null;
  locked: boolean;
  /** false: no owner password on this server (join/leave impossible until one is set). */
  passwordSet: boolean;
}
