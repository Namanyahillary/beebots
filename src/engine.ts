import { customBrain } from "./bees/custom.js";
import { BRAINS } from "./bees/index.js";
import { maxNotionalUsd, minutesSince, positionNotional } from "./bees/common.js";
import { coinOf, type Action, type BeeBrain, type BeeContext, type BeeState, type Intent, type Menu, type Position, type Side } from "./bees/types.js";
import { BEES, STYLES, type BeeId, type Config } from "./config.js";
import type { Alerts } from "./alerts.js";
import type { Db } from "./db.js";
import type { EventBus } from "./events.js";
import type { Executor } from "./exec/executor.js";
import { contractsFor, roundToLot } from "./exec/sizing.js";
import type { Jev, JevResult } from "./jev.js";
import { applyFill, applyFunding, freshBee, mark, rollDay } from "./ledger.js";
import { log } from "./log.js";
import type { MarketFeed } from "./market/data.js";
import type { MarketView } from "./market/types.js";
import { createHash } from "node:crypto";
import { safeError } from "./redact.js";
import { applyRisk, takeProfitSignal, type JevStatus, type Proposal } from "./risk.js";
import { eligibleSetEqual, sampleExcluded, screenUniverse } from "./scout.js";
import { buildSnapshot } from "./snapshot.js";

const FUNDING_HOURS_UTC = [0, 8, 16];
const RECON_MS = 5 * 60_000;
/** How often a benched bee gets a live P&L row in the stream. */
const PULSE_MS = 4_000;
const EQUITY_SNAPSHOT_MS = 10_000;
/** Ghost benchmark + liq-proxy sampling: one row per bee every Nth tick. */
export const GHOST_EVERY_TICKS = 6;
export const LIQ_SAMPLE_TICKS = 6;
/** Re-alert window for the aggregate-exposure monitor (mirrors Alerts' 10 min dedupe). */
const AGG_ALERT_MS = 10 * 60_000;

// ---------- Jev answer reuse (REUSE-LAST-ANSWER with risk-every-tick) ----------
//
// The waste this kills is ~40k Jev calls/day → ~8 orders. Only the Jev API call is
// ever skipped: applyRisk still runs EVERY tick (stops, caps, spread/funding vetoes,
// gates all fire in code), so a cached tick cannot ride a loser blind — the stop that
// would close the position fires with or without a fresh answer.
//
// A tick reuses the bee's last answer only when ALL hold:
//   - the menu is identical (same labels, same intent kinds/targets),
//   - the rounded material state is identical (scores, uplR, fundingZ, spreadBp,
//     position identity, cap — mid is deliberately excluded: marks move every tick),
//   - no invalidation event (position opened/closed, cap change, fresh↔stale flip,
//     leadership flip of the bee's own universe ranking),
//   - fewer than HEARTBEAT_TICKS decide ticks since the last real call.
// The heartbeat guarantees a real call at least every HEARTBEAT_TICKS ticks, so the
// outage detector (downSince / "Jev is back") keeps working despite caching. While an
// outage is known (jev.downSince !== null) the cache is bypassed entirely so the
// fail-closed path runs on a live answer.

const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Sorted labels + intent kinds/targets. Size fracs rounded: equity-driven float dust must not bust the cache. */
export function menuHashFor(menu: Menu): string {
  const norm = Object.keys(menu)
    .sort()
    .map((label) => {
      const i = menu[label]!.intent;
      const frac = (x: number) => Number(x.toFixed(3));
      switch (i.kind) {
        case "open":
        case "switch":
          return [label, i.kind, i.instId, i.side, frac(i.sizeFrac), i.setup];
        case "add":
          return [label, i.kind, frac(i.sizeFrac)];
        case "trim":
          return [label, i.kind, frac(i.fraction)];
        case "close":
          return [label, i.kind, i.reason];
        case "hold":
          return [label, i.kind];
      }
    });
  return sha16(JSON.stringify(norm));
}

/**
 * Rounded material vars. Deliberately EXCLUDES mid/last (marks move every tick; the
 * stop logic in risk.ts watches exits in code) and wall-clock held/flat minutes
 * (time stops and max-flat forcing run in code every tick regardless of the answer).
 */
/**
 * Reuse predicate (tuned from live data: continuous marks in the hash held the
 * skip rate at ~1%). Only DISCRETE, decision-relevant state is hashed: integer
 * scores, position identity, cap. Continuously-varying values are deliberately
 * excluded because every action they drive already runs on LIVE values in code
 * every tick: stops/caps/vetoes in applyRisk, TP/BE in takeProfitSignal. Veto
 * and gate flips fail safe — risk vetoes a stale "open" into a hold.
 */
export function stateHashFor(ctx: BeeContext): string {
  const coins = [...ctx.view.stats.values()]
    .sort((a, b) => (a.instId < b.instId ? -1 : 1))
    .map((s) => [s.coin, s.trend?.score ?? null]);
  const p = ctx.bee.position;
  return sha16(
    JSON.stringify({
      coins,
      news: ctx.view.newsAvailable,
      pos: p ? `${p.side}:${p.coin}` : "flat",
      cap: ctx.bee.cap,
    }),
  );
}

/** "flat" or instId:side:contracts — any fill (open/add/trim/close) invalidates the cache. */
export function posKeyFor(ctx: BeeContext): string {
  const p = ctx.bee.position;
  return p ? `${p.instId}:${p.side}:${p.contracts}` : "flat";
}

/** The bee's own ranking top (same notion rankBoozyHourly uses). A flip means leadership changed. */
export function topIdFor(brain: BeeBrain, ctx: BeeContext): string | null {
  return brain.universe(ctx)[0] ?? null;
}

export interface JevCacheEntry {
  choice: string;
  conviction: number;
  convictionRaw: number;
  prob: number;
  confidence: number;
  probabilities: Record<string, number>;
  menuHash: string;
  stateHash: string;
  topId: string | null;
  posKey: string;
  cap: string | null;
  stale: boolean;
  askedAtTick: number;
}

export interface CacheNow {
  menuHash: string;
  stateHash: string;
  topId: string | null;
  posKey: string;
  cap: string | null;
  stale: boolean;
}

export function cacheReusable(entry: JevCacheEntry, cur: CacheNow, ticksSinceAsk: number, heartbeatTicks: number): boolean {
  return (
    ticksSinceAsk < heartbeatTicks &&
    entry.menuHash === cur.menuHash &&
    entry.stateHash === cur.stateHash &&
    entry.topId === cur.topId &&
    entry.posKey === cur.posKey &&
    entry.cap === cur.cap &&
    entry.stale === cur.stale
  );
}

/**
 * Ghost benchmark chooser (caged): highest-|score| strict-setup open when flat, hold
 * otherwise. Read-only and deterministic — same market snapshot, same pick. Never
 * executed, never persisted outside ghost_decisions, never emitted on the bus.
 *
 * PRE-REGISTERED METRIC (offline, NOT in the tick path): fee-adjusted equity delta vs
 * the real bee = (ghost replay equity incl. simulated taker fees) − bee.equityUsd,
 * computed by an offline job replaying ghost_decisions. The tick path only records picks.
 */
export function ghostPick(brain: BeeBrain, ctx: BeeContext, menu: Menu): { choice: string | null; reason: string; detail: unknown } {
  void brain; // The pick reads the menu the brain built; scoring below is intentionally brain-agnostic.
  const midOf = (instId: string): number | null =>
    ctx.view.tickers.get(instId)?.mid ?? ctx.view.stats.get(instId)?.mid ?? null;
  const p = ctx.bee.position;
  if (p) return { choice: "hold", reason: "ghost_hold_position", detail: { coin: p.coin, side: p.side, mid: midOf(p.instId) } };
  const cands = Object.entries(menu)
    .filter(([, o]) => o.intent.kind === "open" && (o.intent as Extract<Intent, { kind: "open" }>).setup === "strict")
    .map(([label, o]) => {
      const intent = o.intent as Extract<Intent, { kind: "open" }>;
      const s = ctx.view.stats.get(intent.instId);
      return { label, instId: intent.instId, side: intent.side, score: Math.abs(s?.trend?.score ?? 0) };
    })
    .sort((a, b) => b.score - a.score || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const best = cands[0];
  if (!best) return { choice: null, reason: "ghost_no_strict_setup", detail: null };
  return { choice: best.label, reason: "ghost_top_score", detail: { instId: best.instId, side: best.side, score: best.score, mid: midOf(best.instId) } };
}

/**
 * Scout snapshot writer (LOG-ONLY): stores the shortlist only when the eligible
 * set changed since the last stored snapshot, so the log shows transitions
 * instead of one row per refresh. Never gates trading — the caller keeps
 * trading the brains' own universes. Returns true when a row was stored.
 */
export function storeScoutIfChanged(
  db: Db,
  ts: number,
  eligible: string[],
  excluded: Array<{ instId: string; reasons: string[] }>,
): boolean {
  const prev = db.latestScoutSnapshot();
  if (prev && eligibleSetEqual(prev.eligible, eligible)) return false;
  db.insertScoutSnapshot({ ts, eligible, excluded });
  return true;
}

/** Per-instrument sum of open notional across bees (mark-based). Alert-only; the engine never trades on it. */
export function aggregateExposure(bees: BeeState[], view: MarketView): Array<{ instId: string; coin: string; notionalUsd: number; bees: number }> {
  const sums = new Map<string, { coin: string; notionalUsd: number; bees: number }>();
  for (const b of bees) {
    const p = b.position;
    if (!p) continue;
    const inst = view.instruments.get(p.instId);
    const t = view.tickers.get(p.instId);
    if (!inst || !t) continue;
    const e = sums.get(p.instId) ?? { coin: p.coin, notionalUsd: 0, bees: 0 };
    e.notionalUsd += positionNotional(p, t.mid, inst.ctVal);
    e.bees += 1;
    sums.set(p.instId, e);
  }
  return [...sums.entries()].map(([instId, v]) => ({ instId, ...v }));
}

/** Breakeven stop: entry ± feeBufferR (in R) in the position's favour. Null when 1R has no price meaning. */
export function breakevenStopPx(p: Position, ctVal: number, feeBufferR: number): number | null {
  if (!Number.isFinite(p.entryPx) || p.riskUsd <= 0 || p.contracts <= 0 || !(ctVal > 0) || !Number.isFinite(feeBufferR)) return null;
  const rPx = p.riskUsd / (p.contracts * ctVal);
  if (!(rPx > 0) || !Number.isFinite(rPx)) return null;
  return p.side === "long" ? p.entryPx + feeBufferR * rPx : p.entryPx - feeBufferR * rPx;
}

export interface EngineDeps {
  cfg: Config;
  db: Db;
  feed: MarketFeed;
  jev: Jev;
  exec: Executor;
  bus: EventBus;
  alerts: Alerts;
  now?: () => number;
  /** True once someone asked to end the experiment (deploy/close.sh drops a flag file in the data volume). */
  closeRequested?: () => boolean;
  /** Dry run only: consume a one-shot "resume last position" request (flag file). */
  takeResumeRequest?: () => boolean;
}

interface LastDecision {
  choice: string | null;
  top3: Array<[string, number]>;
  confidence: number | null;
  latencyMs: number | null;
  status: string;
  ts: number;
}

export class Engine {
  readonly bees = {} as Record<BeeId, BeeState>;
  private last = {} as Partial<Record<BeeId, LastDecision>>;
  private now: () => number;
  private ticking = false;
  private stopped = false;
  private refreshing = false;
  private timers: NodeJS.Timeout[] = [];
  private lastEquityAt = 0;
  private lastReconAt = 0;
  private lastFundingSlot: number;
  private seq = 0;
  private jevDownAlerted = false;
  /** Monotonic decide-tick counter: the heartbeat measures ticks-since-last-ask in these. */
  private tickIndex = 0;
  /** Per-bee last real Jev answer (REUSE-LAST-ANSWER cache). */
  private jevCache = {} as Partial<Record<BeeId, JevCacheEntry>>;
  /** Per-bee Jev call counters + cost basis for estUsdSaved (avg cost of real ok calls). */
  private jevMade = {} as Partial<Record<BeeId, number>>;
  private jevSkipped = {} as Partial<Record<BeeId, number>>;
  private jevCostSum = {} as Partial<Record<BeeId, number>>;
  private jevOkCount = {} as Partial<Record<BeeId, number>>;
  /** Aggregate-exposure re-alert gate per instId (alert-only monitor). */
  private aggAlertedAt = new Map<string, number>();
  /** Liq-proxy counters per bee (no veto — real guard awaits the OKX margin feed). */
  private liqSamples = {} as Partial<Record<BeeId, number>>;
  private liqMax = {} as Partial<Record<BeeId, number>>;
  private liqLast = {} as Partial<Record<BeeId, number | null>>;
  private recon: { ok: boolean | null; detail: string; ts: number } = { ok: null, detail: "not run yet", ts: 0 };
  private liveStartedAt: number | null = null;
  private lastPulseAt: Partial<Record<BeeId, number>> = {};
  private lastChipUsd: Partial<Record<BeeId, number>> = {};
  startedAt: number;
  private experimentStartedAt = 0;
  /** Experiment closed: no Jev calls, no new positions; open positions are closed, then the engine only marks and reconciles. */
  private closedAt: number | null = null;
  private closeRetryAt: Partial<Record<BeeId, number>> = {};
  private closeAnnounced = false;

  constructor(private d: EngineDeps) {
    this.now = d.now ?? Date.now;
    this.startedAt = this.now();
    this.lastFundingSlot = fundingSlot(this.startedAt);
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    const { cfg, db } = this.d;
    const storedMode = db.getMeta("mode");
    if (storedMode && storedMode !== cfg.mode) {
      throw new Error(`This database was used for MODE=${storedMode}. Point DB_PATH at a separate file for MODE=${cfg.mode}.`);
    }
    db.setMeta("mode", cfg.mode);
    if (cfg.mode === "live") {
      const s = db.getMeta("live_started_at");
      this.liveStartedAt = s ? Number(s) : this.now();
      if (!s) db.setMeta("live_started_at", String(this.liveStartedAt));
    }
    if (!db.getMeta("funding_since")) db.setMeta("funding_since", String(this.now()));
    if (!db.getMeta("experiment_started_at")) db.setMeta("experiment_started_at", String(this.now()));
    this.experimentStartedAt = Number(db.getMeta("experiment_started_at"));
    const closed = db.getMeta("experiment_closed_at");
    if (closed) {
      this.closedAt = Number(closed);
      this.closeAnnounced = db.getMeta("experiment_flat_at") !== null;
    }

    for (const id of BEES) {
      this.bees[id] = db.loadBee(id) ?? freshBee(id, cfg.risk.startEquityUsd, this.now());
      await this.d.exec.init(id);
    }

    await this.refreshMarket();
    if (this.d.exec.kind === "okx") await this.reconcile();

    this.d.bus.emit("status", { event: "engine_start", mode: cfg.mode, tickMs: cfg.tickMs });
    this.d.alerts.send(`engine started (MODE=${cfg.mode})`);

    this.loop(() => this.tick(), cfg.tickMs);
    this.loop(() => this.refreshMarket(), cfg.dataRefreshMs);
    this.timers.push(setInterval(() => this.d.bus.emit("heartbeat", {}), 15_000));
    this.timers.push(setInterval(() => { this.d.db.pruneEvents(this.now() - 3 * 86_400_000); this.d.db.pruneGhostDecisions(this.now() - 3 * 86_400_000); this.d.db.pruneScoutSnapshots(this.now() - 3 * 86_400_000); }, 3_600_000));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    for (const id of BEES) this.d.db.saveBee(this.bees[id], this.now());
  }

  private loop(fn: () => Promise<void>, everyMs: number) {
    const slot = this.timers.length;
    const run = async () => {
      const t0 = this.now();
      try {
        await fn();
      } catch (err) {
        log.error("loop error", { err: safeError(err) });
      }
      if (!this.stopped) this.timers[slot] = setTimeout(run, Math.max(0, everyMs - (this.now() - t0)));
    };
    this.timers[slot] = setTimeout(run, everyMs);
  }

  async refreshMarket(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.d.feed.refresh(this.now());
      this.rankBoozyHourly();
      this.recordScout(this.now());
      if (this.d.exec.kind === "okx") await this.pollFunding();
    } catch (err) {
      log.warn("market refresh failed", { err: safeError(err) });
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Scout visibility (LOG-ONLY, never gates trading): after each market refresh,
   * screen the universe and store a snapshot only when the eligible set changed
   * (opportunities decay — the log shows transitions, not every refresh).
   * Excluded reasons are sampled to the top ~10 by volume to bound row size.
   * Failures are contained so the screen can never break a market refresh.
   */
  private recordScout(now: number): void {
    try {
      const view = this.d.feed.view();
      const r = screenUniverse(view, {
        spreadGateBps: Math.max(...STYLES.map((s) => this.d.cfg.bees[s].spreadGateBps)),
        min24hVolUsd: this.d.cfg.universe.min24hVolUsd,
      });
      const excluded = sampleExcluded(r.excluded, (id) => view.stats.get(id)?.vol24hUsd ?? 0);
      if (storeScoutIfChanged(this.d.db, now, r.eligible, excluded)) {
        log.info("scout transition", { eligible: r.eligible, excluded: excluded.length });
      }
    } catch (err) {
      log.warn("scout snapshot failed", { err: safeError(err) });
    }
  }

  // ---------- the tick ----------

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.tickIndex++;
    try {
      try {
        await this.d.feed.refreshTickers();
      } catch (err) {
        log.warn("ticker refresh failed", { err: safeError(err) });
      }
      const now = this.now();
      for (const id of BEES) this.markBee(id, now);
      for (const id of BEES) this.sampleLiqProxy(id);
      if (this.d.feed.lastRefreshAt === 0) return; // no market data yet
      if (this.d.exec.kind === "sim") this.simulateFunding(now);

      if (this.closedAt === null && this.d.closeRequested?.()) this.beginClose(now);
      if (this.closedAt === null && this.d.takeResumeRequest?.()) await this.resumeLast(now);
      if (this.closedAt !== null) await this.windDown(now);
      else await Promise.all(BEES.map((id) => this.decide(id, now).catch((err) => log.error("decision failed", { bee: id, err: safeError(err) }))));
      this.checkAggregateExposure(now);

      if (now - this.lastEquityAt >= EQUITY_SNAPSHOT_MS) {
        this.lastEquityAt = now;
        for (const id of BEES) {
          const b = this.bees[id];
          this.d.db.insertEquity(id, now, b.equityUsd, b.cashUsd, b.uplUsd);
        }
      }
      this.d.bus.emit("equity", { bees: BEES.map((id) => this.publicBee(id)) }, now);
      if (this.d.exec.kind === "okx" && now - this.lastReconAt >= RECON_MS) await this.reconcile();
      this.checkJevOutage(now);
    } finally {
      this.ticking = false;
    }
  }

  private ctx(id: BeeId, now: number): BeeContext {
    const bee = this.bees[id];
    const p = bee.position;
    return {
      bee,
      view: this.d.feed.view(),
      cfg: this.d.cfg,
      knobs: this.knobs(id),
      now,
      uplR: p && p.riskUsd > 0 ? bee.uplUsd / p.riskUsd : null,
    };
  }

  private markBee(id: BeeId, now: number) {
    const bee = this.bees[id];
    const view = this.d.feed.view();
    const p = bee.position;
    const t = p ? view.tickers.get(p.instId) : undefined;
    mark(bee, t?.mid, p ? view.instruments.get(p.instId)?.ctVal : undefined);
    if (rollDay(bee, now)) {
      this.d.bus.emit("cap", { bee: id, cap: null, detail: "new UTC day: counters and caps reset" }, now);
    }
    // Trailing stop: only ever ratchets in the position's favour.
    const brain = this.brain(id);
    if (p && brain.trail) {
      const cand = brain.trail(this.ctx(id, now));
      if (cand !== null && Number.isFinite(cand)) {
        if (p.stopPx === null) p.stopPx = cand;
        else p.stopPx = p.side === "long" ? Math.max(p.stopPx, cand) : Math.min(p.stopPx, cand);
      }
    }
  }

  /** Store a real answer for REUSE-LAST-ANSWER and fold its cost into the per-bee avg cost basis. */
  private rememberJevAnswer(id: BeeId, r: Extract<JevResult, { ok: true }>, menu: Menu, ctx: BeeContext, brain: BeeBrain, stale: boolean): void {
    this.jevCache[id] = {
      choice: r.choice,
      conviction: r.conviction,
      convictionRaw: r.convictionRaw,
      prob: r.probabilities[r.choice] ?? 0,
      confidence: r.confidence,
      probabilities: { ...r.probabilities },
      menuHash: menuHashFor(menu),
      stateHash: stateHashFor(ctx),
      topId: topIdFor(brain, ctx),
      posKey: posKeyFor(ctx),
      cap: ctx.bee.cap,
      stale,
      askedAtTick: this.tickIndex,
    };
    this.jevCostSum[id] = (this.jevCostSum[id] ?? 0) + r.costUsd;
    this.jevOkCount[id] = (this.jevOkCount[id] ?? 0) + 1;
  }

  /** Avg cost of this bee's real Jev calls (0 until the first ok call). Basis for estUsdSaved. */
  private jevAvgCost(id: BeeId): number {
    const n = this.jevOkCount[id] ?? 0;
    return n > 0 ? (this.jevCostSum[id] ?? 0) / n : 0;
  }

  private jevSavedUsd(id: BeeId): number {
    return (this.jevSkipped[id] ?? 0) * this.jevAvgCost(id);
  }

  /**
   * Ratchet-only breakeven move (same discipline as the trail in markBee: the stop only
   * ever moves in the position's favour, never loosens). Sets beMoved; the caller persists
   * via the existing saveBee path. Returns a status note, or null when nothing applied.
   */
  private moveStopToBreakeven(id: BeeId, ctx: BeeContext, uplR: number): string | null {
    const p = ctx.bee.position;
    const pol = this.brain(id).takeProfit;
    if (!p || !pol) return null;
    const inst = ctx.view.instruments.get(p.instId);
    const be = inst ? breakevenStopPx(p, inst.ctVal, pol.feeBufferR) : null;
    if (be === null) return null;
    if (p.side === "long") p.stopPx = p.stopPx === null ? be : Math.max(p.stopPx, be);
    else p.stopPx = p.stopPx === null ? be : Math.min(p.stopPx, be);
    p.beMoved = true;
    return `stop→BE at +${uplR.toFixed(1)}R`;
  }

  /**
   * Ghost benchmark (caged): ONE row per bee every GHOST_EVERY_TICKS ticks, written ONLY
   * to ghost_decisions via insertGhostDecision. Never touches orders/fills/decisions,
   * never emits bus events. Failures are contained (warn) so the benchmark can never
   * break a trading tick.
   */
  private recordGhost(id: BeeId, ctx: BeeContext, brain: BeeBrain, menu: Menu, now: number): void {
    if (this.tickIndex % GHOST_EVERY_TICKS !== 0) return;
    try {
      const pick = ghostPick(brain, ctx, menu);
      this.d.db.insertGhostDecision({ bee: id, ts: now, choice: pick.choice, reason: pick.reason, detail: pick.detail });
    } catch (err) {
      log.warn("ghost benchmark write failed", { bee: id, err: safeError(err) });
    }
  }

  /**
   * Liq proxy (NO veto, counters only): per-position notional/equity, sampled. A real
   * guard awaits the OKX margin feed — this only makes leverage drift visible in logs.
   */
  private sampleLiqProxy(id: BeeId): void {
    const bee = this.bees[id];
    const p = bee.position;
    if (!p) {
      this.liqLast[id] = null;
      return;
    }
    const view = this.d.feed.view();
    const inst = view.instruments.get(p.instId);
    const mid = view.tickers.get(p.instId)?.mid ?? view.stats.get(p.instId)?.mid;
    if (!inst || mid === undefined || !(bee.equityUsd > 0)) return;
    const ratio = positionNotional(p, mid, inst.ctVal) / bee.equityUsd;
    this.liqSamples[id] = (this.liqSamples[id] ?? 0) + 1;
    this.liqMax[id] = Math.max(this.liqMax[id] ?? 0, ratio);
    this.liqLast[id] = ratio;
    if (this.tickIndex % LIQ_SAMPLE_TICKS === 0) {
      log.info("liq proxy", { bee: id, coin: p.coin, side: p.side, notionalEquityRatio: Number(ratio.toFixed(3)) });
    }
  }

  /**
   * Aggregate monitor (ALERT-ONLY, not a veto): per-instrument sum of open notional across
   * the 3 bees vs the single-instrument cap (cfg.risk.maxNotionalUsdPerBee). Logs + alerts,
   * zero trading effect.
   */
  private checkAggregateExposure(now: number): void {
    const rows = aggregateExposure(BEES.map((id) => this.bees[id]), this.d.feed.view());
    for (const r of rows) {
      if (r.notionalUsd <= this.d.cfg.risk.maxNotionalUsdPerBee) continue;
      const last = this.aggAlertedAt.get(r.instId) ?? 0;
      if (now - last < AGG_ALERT_MS) continue;
      this.aggAlertedAt.set(r.instId, now);
      this.d.alerts.send(
        `aggregate exposure ${r.coin} $${r.notionalUsd.toFixed(0)} across ${r.bees} bees > $${this.d.cfg.risk.maxNotionalUsdPerBee.toFixed(0)} single-instrument cap (alert-only, no trading effect)`,
      );
    }
  }

  private async decide(id: BeeId, now: number): Promise<void> {    const { cfg, db, bus, jev } = this.d;
    const brain = this.brain(id);
    const bee = this.bees[id];
    // Benched (trade cap or fee budget): the bee rides whatever it holds. Jev is not asked, because nothing it
    // chose could be acted on; only code can close the position (stop, time stop, loss stop) until 00:00 UTC.
    if (bee.cap === "trade_cap" || bee.cap === "fee_budget") return this.decideBenched(id, now);
    const ctx = this.ctx(id, now);
    const menu = brain.menu(ctx);
    const snap = buildSnapshot(brain, ctx);
    if (brain.id === "boozy" && bee.top1.coin) snap.state.top1 = `${bee.top1.coin} x${bee.top1.streak}`;

    let jevStatus: JevStatus = "ok";
    let r: JevResult | null = null;
    let cached: JevCacheEntry | null = null;
    let jevCached = false;
    const dataAgeMs = now - this.d.feed.lastRefreshAt;
    const maxDataAgeMs = 3 * cfg.dataRefreshMs + 30_000;
    if (jev.capTripped) jevStatus = "daily_cap";
    else if (Object.keys(menu).length === 0) jevStatus = "no_options";
    else if (jev.downSince !== null) {
      // Known outage: bypass the cache so the fail-closed path runs on a live answer.
      r = await jev.decide({ strategy: brain.strategy, state: snap.state, menu, convictionLabels: brain.convictionLabels });
      this.jevMade[id] = (this.jevMade[id] ?? 0) + 1;
      if (!r.ok) jevStatus = r.reason === "daily_cap" ? "daily_cap" : "unreachable";
      else this.rememberJevAnswer(id, r, menu, ctx, brain, dataAgeMs > maxDataAgeMs);
    } else {
      const cur: CacheNow = {
        menuHash: menuHashFor(menu),
        stateHash: stateHashFor(ctx),
        topId: topIdFor(brain, ctx),
        posKey: posKeyFor(ctx),
        cap: bee.cap,
        stale: dataAgeMs > maxDataAgeMs,
      };
      const prev = this.jevCache[id];
      const ticksSinceAsk = prev ? this.tickIndex - prev.askedAtTick : Number.POSITIVE_INFINITY;
      if (prev && menu[prev.choice] && cacheReusable(prev, cur, ticksSinceAsk, cfg.jev.heartbeatTicks)) {
        cached = prev;
        jevCached = true;
        this.jevSkipped[id] = (this.jevSkipped[id] ?? 0) + 1;
        log.debug("jev answer reused", { bee: id, choice: prev.choice, ticksSinceAsk });
      } else {
        r = await jev.decide({ strategy: brain.strategy, state: snap.state, menu, convictionLabels: brain.convictionLabels });
        this.jevMade[id] = (this.jevMade[id] ?? 0) + 1;
        if (!r.ok) jevStatus = r.reason === "daily_cap" ? "daily_cap" : "unreachable";
        else this.rememberJevAnswer(id, r, menu, ctx, brain, cur.stale);
      }
    }
    const proposal: Proposal | null =
      r && r.ok
        ? { label: r.choice, intent: menu[r.choice]!.intent, prob: r.probabilities[r.choice] ?? 0, conviction: r.conviction }
        : cached
          ? { label: cached.choice, intent: menu[cached.choice]!.intent, prob: cached.prob, conviction: cached.conviction }
          : null;

    // Risk runs EVERY tick, cached or not: stops, caps, spread/funding vetoes and gates
    // all fire in code either way. Only the Jev API call is ever skipped.
    const risk = applyRisk({
      ctx,
      brain,
      proposal,
      jev: jevStatus,
      sizeMult: this.sizeMult(now),
      dataAgeMs,
      maxDataAgeMs: 3 * cfg.dataRefreshMs + 30_000,
    });

    if (risk.capTripped) {
      const detail = risk.status;
      db.insertCap(id, now, risk.capTripped, detail);
      bus.emit("cap", { bee: id, cap: risk.capTripped, detail }, now);
      this.d.alerts.send(`${this.d.cfg.slots[id].name}: ${detail}`);
    }
    bee.cap = risk.cap;

    // Take-profit / breakeven (per-brain opt-in only, never universal): code-driven, after
    // risk, and only when risk says hold — never overrides a stop, veto or close. The trim
    // reuses the EXISTING trim execution path below; trimmedAtR is set only on fill confirm.
    let action = risk.action;
    let forcedBy = risk.forcedBy;
    let status = risk.status;
    let tpTrim: { fraction: number; uplR: number } | null = null;
    const tpPol = brain.takeProfit;
    if (tpPol && bee.position && action.kind === "none" && ctx.uplR !== null) {
      const sig = takeProfitSignal(bee.position, ctx.uplR, tpPol);
        if (sig?.trim && bee.position) {
          // A trim that rounds below minimum size would no-op every tick without ever
          // setting trimmedAtR (Finding 2): mark it spent here instead of emitting it.
          const inst = ctx.view.instruments.get(bee.position.instId);
          const lots = inst ? roundToLot(bee.position.contracts * sig.trim.fraction, inst) : 0;
          if (inst && lots >= inst.minSz) {
            tpTrim = { fraction: sig.trim.fraction, uplR: ctx.uplR };
            action = { kind: "trim", fraction: sig.trim.fraction };
            forcedBy = "take_profit";
            status = `take-profit trim ${Math.round(sig.trim.fraction * 100)}% at +${ctx.uplR.toFixed(1)}R`;
          } else {
            bee.position.trimmedAtR = ctx.uplR;
            log.info("take-profit trim below minimum size, marked spent", { bee: id });
          }
        }
        if (sig?.moveStopToBe) {
          const note = this.moveStopToBreakeven(id, ctx, ctx.uplR);
          if (note) status = `${status}; ${note}`;
        }
    }

    this.recordGhost(id, ctx, brain, menu, now);

    // Hard rule 10: recorded before it is acted on.
    const costUsd = r && r.ok ? r.costUsd : 0;
    const decisionId = db.insertDecision({
      bee: id,
      ts: now,
      stateHash: snap.hash,
      stateJson: JSON.stringify(snap.state),
      menuJson: JSON.stringify(Object.keys(menu)),
      choice: r && r.ok ? r.choice : (cached?.choice ?? null),
      probabilities: r && r.ok ? r.probabilities : cached ? cached.probabilities : null,
      confidence: r && r.ok ? r.confidence : (cached?.confidence ?? null),
      conviction: r && r.ok ? r.convictionRaw : (cached?.convictionRaw ?? null),
      latencyMs: r ? r.latencyMs : null,
      inputTokens: r && r.ok ? r.inputTokens : null,
      jevCostUsd: costUsd,
      jevError: r && !r.ok ? `${r.reason}${r.error ? `: ${r.error.code} ${r.error.message}` : ""}` : null,
      jevCached,
      action,
      vetoedBy: risk.vetoedBy,
      forcedBy,
      status,
    });
    bee.totals.jevUsd += costUsd;
    bee.totals.decisions++;

    const top3 =
      r && r.ok
        ? (Object.entries(r.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3) as Array<[string, number]>)
        : cached
          ? (Object.entries(cached.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3) as Array<[string, number]>)
          : [];
    this.last[id] = { choice: r && r.ok ? r.choice : (cached?.choice ?? null), top3, confidence: r && r.ok ? r.confidence : (cached?.confidence ?? null), latencyMs: r ? r.latencyMs : null, status, ts: now };
    // Flat and nothing to ask Jev (bizzy waiting for her breakout): a live "watching" row every PULSE_MS instead of a
    // "no call" row every tick, so the stream shows how close the trigger is.
    const watching = jevStatus === "no_options" && !bee.position && !!brain.idleStatus && risk.action.kind === "none";
    if (watching && now - (this.lastPulseAt[id] ?? 0) < PULSE_MS) {
      db.saveBee(bee, now);
      return;
    }
    if (watching) this.lastPulseAt[id] = now;
    bus.emit(
      "decision",
      {
        bee: id,
        decisionId,
        menu: Object.keys(menu),
        choice: r && r.ok ? r.choice : watching ? "WATCHING" : (cached?.choice ?? null),
        ...(watching ? { watch: status } : {}),
        probabilities: top3.map(([label, p]) => ({ label, p: Number(p.toFixed(3)) })),
        confidence: r && r.ok ? Number(r.confidence.toFixed(3)) : (cached ? Number(cached.confidence.toFixed(3)) : null),
        conviction: r && r.ok ? brain.convictionLabels[r.conviction] : cached ? brain.convictionLabels[cached.conviction] : null,
        latencyMs: r ? r.latencyMs : null,
        tokens: r && r.ok ? r.inputTokens : null,
        jevUsd: Number(costUsd.toFixed(6)),
        action: describeAction(action),
        vetoedBy: risk.vetoedBy,
        forcedBy,
        status,
        jev: jevStatus,
        cached: jevCached,
        ...this.liveChip(id),
      },
      now,
    );

    const contractsBefore = bee.position?.contracts ?? null;
    if (action.kind !== "none") {
      // Any executed action changes the world the cached answer was given for:
      // drop the cache so the next tick asks Jev afresh. Never re-trade stale intent.
      delete this.jevCache[id];
      await this.execute(id, action, decisionId, ctx, proposal?.conviction ?? 0);
    }
    if (tpTrim && bee.position && contractsBefore !== null && bee.position.contracts < contractsBefore) {
      bee.position.trimmedAtR = tpTrim.uplR;
    }
    db.saveBee(bee, now);
  }

  // ---------- benched: ride the position ----------

  private async decideBenched(id: BeeId, now: number): Promise<void> {
    const { db } = this.d;
    const bee = this.bees[id];
    const ctx = this.ctx(id, now);
    const risk = applyRisk({
      ctx,
      brain: this.brain(id),
      proposal: null,
      jev: "no_options",
      sizeMult: this.sizeMult(now),
      dataAgeMs: now - this.d.feed.lastRefreshAt,
      maxDataAgeMs: 3 * this.d.cfg.dataRefreshMs + 30_000,
    });
    if (risk.capTripped) {
      db.insertCap(id, now, risk.capTripped, risk.status);
      this.d.bus.emit("cap", { bee: id, cap: risk.capTripped, detail: risk.status }, now);
      this.d.alerts.send(`${this.d.cfg.slots[id].name}: ${risk.status}`);
    }
    bee.cap = risk.cap;
    // Benched: no new orders (not even TP trims — the fee budget may be why this bee is
    // benched), but the free, risk-reducing breakeven move still applies when risk holds.
    let benchStatus = risk.status;
    if (risk.action.kind === "none" && bee.position && ctx.uplR !== null && this.brain(id).takeProfit) {
      const sig = takeProfitSignal(bee.position, ctx.uplR, this.brain(id).takeProfit!);
      if (sig?.moveStopToBe) {
        const note = this.moveStopToBreakeven(id, ctx, ctx.uplR);
        if (note) benchStatus = `${benchStatus}; ${note}`;
      }
    }
    const prev = this.last[id];
    this.last[id] = { choice: null, top3: prev?.top3 ?? [], confidence: null, latencyMs: null, status: benchStatus, ts: now };
    if (risk.action.kind !== "none") {
      const decisionId = db.insertDecision({
        bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
        conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
        action: risk.action, vetoedBy: null, forcedBy: risk.forcedBy, status: risk.status,
      });
      this.d.bus.emit("decision", {
        bee: id, decisionId, choice: null, probabilities: [], confidence: null, conviction: null, latencyMs: null, tokens: null,
        jevUsd: 0, action: describeAction(risk.action), vetoedBy: null, forcedBy: risk.forcedBy, status: risk.status, jev: "no_options",
        ...this.liveChip(id),
      }, now);
      await this.execute(id, risk.action, decisionId, ctx, 0);
    } else if (now - (this.lastPulseAt[id] ?? 0) >= PULSE_MS) {
      // Keep benched bees in the stream: a live row with the position's P&L ticking, no Jev call behind it.
      this.lastPulseAt[id] = now;
      const p = bee.position;
      this.d.bus.emit("decision", {
        bee: id, choice: p ? `RIDING ${p.coin}` : "BENCHED", probabilities: [], confidence: null, conviction: null, latencyMs: null,
        tokens: null, jevUsd: 0, action: "hold", vetoedBy: null, forcedBy: null, status: benchStatus, jev: "benched", pulse: true,
        ...this.liveChip(id),
      }, now);
    }
    db.saveBee(bee, now);
  }

  /** The bee's money right now, for the stream: open P&L (or total P&L when flat) and how it moved since its last row. */
  private liveChip(id: BeeId) {
    const b = this.bees[id];
    const p = b.position;
    const value = p ? b.uplUsd : b.equityUsd - this.d.cfg.risk.startEquityUsd;
    const prev = this.lastChipUsd[id];
    this.lastChipUsd[id] = value;
    return {
      live: {
        coin: p?.coin ?? null,
        side: p?.side ?? null,
        valueUsd: Number(value.toFixed(2)),
        kind: p ? "open" : "total",
        deltaUsd: prev === undefined ? 0 : Number((value - prev).toFixed(2)),
      },
    };
  }

  /**
   * DRY RUN ONLY, one-shot (flag file `resume-last-dry` in the data volume): a benched bee that is sitting flat
   * re-opens the last position it held (same coin, side and size, at today's price) and rides it. Not a trade
   * toward its cap. Refused outright in demo/live.
   */
  private async resumeLast(now: number): Promise<void> {
    if (this.d.cfg.mode !== "dry") return;
    for (const id of BEES) {
      const bee = this.bees[id];
      if (bee.position || (bee.cap !== "trade_cap" && bee.cap !== "fee_budget")) continue;
      const last = this.d.db.raw
        .prepare(`SELECT inst_id AS instId, side, contracts FROM orders WHERE bee = ? AND reduce_only = 0 AND state = 'filled' ORDER BY id DESC LIMIT 1`)
        .get(id) as { instId: string; side: "buy" | "sell"; contracts: number } | undefined;
      if (!last) continue;
      const decisionId = this.d.db.insertDecision({
        bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
        conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
        action: { kind: "open", instId: last.instId, side: last.side === "buy" ? "long" : "short" }, vetoedBy: null, forcedBy: "resume_last",
        status: "benched: back into its last position to ride it",
      });
      const ok = await this.order(id, decisionId, last.instId, last.side, last.contracts, false, "resume_last");
      const p = (this.bees[id] as BeeState).position; // re-read: order() just filled it
      if (!ok || !p) continue;
      const ctx = this.ctx(id, this.now());
      const inst = ctx.view.instruments.get(last.instId);
      p.stopPx = this.brain(id).stopFor(last.instId, p.side, p.entryPx, ctx);
      const notional = inst ? positionNotional(p, p.entryPx, inst.ctVal) : 0;
      p.riskUsd = p.stopPx !== null ? (notional * Math.abs(p.entryPx - p.stopPx)) / p.entryPx : notional * 0.01;
      this.d.db.saveBee(bee, now);
      log.info("resumed last position", { bee: id, coin: p.coin, side: p.side });
    }
  }

  // ---------- closing the experiment ----------

  private beginClose(now: number) {
    this.closedAt = now;
    this.d.db.setMeta("experiment_closed_at", String(now));
    log.info("experiment close requested: closing every position, no more Jev calls");
    this.d.bus.emit("status", { event: "experiment_closing" }, now);
    this.d.alerts.send("experiment close requested: closing all positions");
  }

  /** Close whatever each bee holds (reduce-only market, through the normal ledger), then idle. */
  private async windDown(now: number): Promise<void> {
    await Promise.all(
      BEES.map(async (id) => {
        const bee = this.bees[id];
        const p = bee.position;
        if (!p || now < (this.closeRetryAt[id] ?? 0)) return;
        const decisionId = this.d.db.insertDecision({
          bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
          conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
          action: { kind: "close", reason: "experiment_closed" }, vetoedBy: null, forcedBy: "experiment_closed", status: "experiment closed: closing position",
        });
        const ok = await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, "experiment_close");
        if (!ok) this.closeRetryAt[id] = now + 10_000;
        this.d.db.saveBee(bee, now);
      }),
    ).catch((err) => log.error("close failed", { err: safeError(err) }));
    if (!this.closeAnnounced && BEES.every((id) => !this.bees[id].position)) {
      this.closeAnnounced = true;
      this.d.db.setMeta("experiment_flat_at", String(now));
      this.lastReconAt = 0; // confirm flat against OKX on the next tick
      this.d.bus.emit("status", { event: "experiment_closed" }, now);
      this.d.alerts.send("experiment closed: every bee is flat");
    }
  }

  // ---------- execution ----------

  private async execute(id: BeeId, action: Action, decisionId: number, ctx: BeeContext, _conviction: number): Promise<void> {
    const bee = this.bees[id];
    const p = bee.position;
    switch (action.kind) {
      case "close":
        if (p) await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, action.reason);
        return;
      case "trim": {
        if (!p) return;
        const inst = ctx.view.instruments.get(p.instId);
        const n = inst ? roundToLot(p.contracts * action.fraction, inst) : 0;
        if (n > 0 && inst && n >= inst.minSz) await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", n, true, "trim");
        else log.info("trim rounds to zero, skipped", { bee: id });
        return;
      }
      case "add": {
        if (!p) return;
        const inst = ctx.view.instruments.get(p.instId);
        const s = ctx.view.stats.get(p.instId);
        const n = inst && s ? contractsFor(action.notionalUsd, inst, s.mid) : 0;
        if (n > 0) await this.order(id, decisionId, p.instId, p.side === "long" ? "buy" : "sell", n, false, "add");
        else log.info("add rounds to zero contracts, skipped", { bee: id });
        return;
      }
      case "switch":
        if (p) {
          const ok = await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, "switch_close");
          if (!ok) return;
        }
        await this.openPosition(id, decisionId, action.instId, action.side, action.notionalUsd);
        return;
      case "open":
        await this.openPosition(id, decisionId, action.instId, action.side, action.notionalUsd);
        return;
    }
  }

  private async openPosition(id: BeeId, decisionId: number, instId: string, side: Side, notionalUsd: number): Promise<void> {
    const view = this.d.feed.view();
    const inst = view.instruments.get(instId);
    const s = view.stats.get(instId);
    if (!inst || !s) return;
    const contracts = contractsFor(notionalUsd, inst, s.mid);
    if (contracts <= 0) {
      log.info("order rounds to zero contracts, skipped", { bee: id, coin: inst.coin, notionalUsd });
      return;
    }
    const ok = await this.order(id, decisionId, instId, side === "long" ? "buy" : "sell", contracts, false, "open");
    const bee = this.bees[id];
    if (!ok || !bee.position) return;
    bee.tradesToday++;
    const ctx = this.ctx(id, this.now());
    const p = bee.position;
    p.stopPx = this.brain(id).stopFor(instId, side, p.entryPx, ctx);
    const notional = positionNotional(p, p.entryPx, inst.ctVal);
    p.riskUsd = p.stopPx !== null ? (notional * Math.abs(p.entryPx - p.stopPx)) / p.entryPx : notional * 0.01;
    if (s.trend) p.entryScore = s.trend.score;
  }

  /** Record the order, send it, apply the fill. Returns true when it filled. */
  private async order(id: BeeId, decisionId: number, instId: string, side: "buy" | "sell", contracts: number, reduceOnly: boolean, purpose: string): Promise<boolean> {
    const { db, bus, exec } = this.d;
    const now = this.now();
    const inst = this.d.feed.view().instruments.get(instId);
    if (!inst) return false;
    const clOrdId = `${id.slice(0, 2)}${now.toString(36)}${(this.seq++ % 1296).toString(36).padStart(2, "0")}`;
    const orderId = db.insertOrder({ decisionId, bee: id, ts: now, clOrdId, instId, side, contracts, reduceOnly, purpose });
    bus.emit("order", { bee: id, coin: inst.coin, side, contracts, purpose, clOrdId, state: "sent" }, now);
    const res = await exec.market(id, { instId, side, contracts, reduceOnly, clOrdId });
    if (!res.ok) {
      db.updateOrder(orderId, res.state, null, `${res.error.code} ${res.error.message}`);
      bus.emit("order", { bee: id, coin: inst.coin, side, contracts, purpose, state: res.state, error: res.error });
      log.warn("order failed", { bee: id, coin: inst.coin, purpose, err: res.error });
      if (res.state === "unknown") this.lastReconAt = 0; // reconcile on the next tick
      return false;
    }
    db.updateOrder(orderId, "filled", res.ordId, null);
    const bee = this.bees[id];
    const realised = applyFill(bee, { instId, coin: inst.coin, side, contracts: res.contracts, px: res.avgPx, feeUsd: res.feeUsd, ctVal: inst.ctVal, ts: res.ts });
    const notionalUsd = res.contracts * inst.ctVal * res.avgPx;
    db.insertFill({ orderId, bee: id, ts: res.ts, instId, side, contracts: res.contracts, px: res.avgPx, notionalUsd, feeUsd: res.feeUsd, realisedUsd: realised });
    mark(bee, res.avgPx, inst.ctVal);
    const dir = reduceOnly ? "CLOSE" : side === "buy" ? "LONG" : "SHORT";
    bus.emit("fill", {
      bee: id,
      decisionId,
      coin: inst.coin,
      side,
      purpose,
      contracts: res.contracts,
      px: res.avgPx,
      notionalUsd: Number(notionalUsd.toFixed(2)),
      feeUsd: Number(res.feeUsd.toFixed(4)),
      realisedUsd: Number(realised.toFixed(2)),
      label: `${this.d.cfg.slots[id].name} ${dir} ${inst.coin} $${notionalUsd.toFixed(0)}`,
    });
    return true;
  }

  // ---------- funding, reconciliation, ranks ----------

  /** MODE=dry: charge funding at 00/08/16 UTC using the current rate (long pays a positive rate). */
  private simulateFunding(now: number) {
    const slot = fundingSlot(now);
    if (slot === this.lastFundingSlot) return;
    this.lastFundingSlot = slot;
    const view = this.d.feed.view();
    for (const id of BEES) {
      const bee = this.bees[id];
      const p = bee.position;
      const s = p ? view.stats.get(p.instId) : undefined;
      const inst = p ? view.instruments.get(p.instId) : undefined;
      if (!p || !s || !inst || s.fundingPct === null) continue;
      const amount = -(p.side === "long" ? 1 : -1) * (s.fundingPct / 100) * positionNotional(p, s.mid, inst.ctVal);
      if (this.d.db.insertFunding(id, now, p.instId, amount, `sim-${id}-${slot}`)) {
        applyFunding(bee, amount);
        this.d.bus.emit("funding", { bee: id, coin: p.coin, amountUsd: Number(amount.toFixed(4)) }, now);
      }
    }
  }

  /** MODE=demo/live: record funding bills (type 8) as their own ledger rows. */
  private async pollFunding() {
    const since = Number(this.d.db.getMeta("funding_since") ?? 0);
    for (const id of BEES) {
      const bills = await this.d.exec.fundingBills(id);
      for (const b of bills ?? []) {
        if (b.ts < since) continue;
        if (this.d.db.insertFunding(id, b.ts, b.instId, b.amountUsd, b.billId)) {
          applyFunding(this.bees[id], b.amountUsd);
          this.d.bus.emit("funding", { bee: id, coin: b.instId?.split("-")[0] ?? null, amountUsd: b.amountUsd }, b.ts);
        }
      }
    }
  }

  /** Every 5 min (demo/live): our position and fees vs OKX. On mismatch, adopt OKX's position and go red. */
  async reconcile(): Promise<void> {
    const now = this.now();
    this.lastReconAt = now;
    const view = this.d.feed.view();
    const diffs: string[] = [];
    for (const id of BEES) {
      const bee = this.bees[id];
      const ex = await this.d.exec.positions(id);
      if (ex === null) {
        diffs.push(`${this.d.cfg.slots[id].name}: could not read OKX positions`);
        continue;
      }
      const theirs = ex[0];
      const ours = bee.position;
      const oursSigned = ours ? (ours.side === "long" ? 1 : -1) * ours.contracts : 0;
      const theirSigned = theirs?.pos ?? 0;
      const sameInst = (ours?.instId ?? null) === (theirs?.instId ?? null);
      let ok = ex.length <= 1 && sameInst && Math.abs(oursSigned - theirSigned) < 1e-9;
      let detail = ok ? "match" : `ours ${ours ? `${ours.side} ${ours.contracts} ${ours.coin}` : "flat"} vs OKX ${theirs ? `${theirs.pos} ${theirs.instId.split("-")[0]}` : "flat"}`;

      // Fees to the cent on our recent filled orders.
      const rows = this.d.db.raw
        .prepare(`SELECT o.ord_id AS ordId, o.inst_id AS instId, f.fee_usd AS fee FROM orders o JOIN fills f ON f.order_id = o.id WHERE o.bee = ? AND o.ord_id IS NOT NULL ORDER BY o.id DESC LIMIT 50`)
        .all(id) as Array<{ ordId: string; instId: string; fee: number }>;
      if (rows.length) {
        const theirFees = await this.d.exec.feesFor(id, [...new Set(rows.map((r) => r.instId))], new Set(rows.map((r) => r.ordId)));
        if (theirFees) {
          const ourSum = rows.filter((r) => theirFees.has(r.ordId)).reduce((a, r) => a + r.fee, 0);
          const theirSum = [...theirFees.values()].reduce((a, b) => a + b, 0);
          if (Math.abs(ourSum - theirSum) >= 0.005) {
            ok = false;
            detail += `; fees ours $${ourSum.toFixed(2)} vs OKX $${theirSum.toFixed(2)}`;
          }
        }
      }

      if (!sameInst || Math.abs(oursSigned - theirSigned) >= 1e-9) {
        // OKX is the truth: rebuild the position from it.
        if (!theirs) {
          bee.position = null;
          bee.flatSince ??= now;
        } else {
          const inst = view.instruments.get(theirs.instId);
          const side: Side = theirs.pos > 0 ? "long" : "short";
          const keepStop = ours && sameInst && ours.side === side ? ours.stopPx : null;
          // One-shot take-profit flags survive reconcile when we still hold the same side of
          // the same instrument (they are persisted via saveBee, never reset by a re-read).
          const keepFlags = ours && sameInst && ours.side === side;
          bee.position = {
            instId: theirs.instId,
            coin: theirs.instId.split("-")[0]!,
            side,
            contracts: Math.abs(theirs.pos),
            entryPx: theirs.avgPx,
            openedAt: ours?.openedAt ?? now,
            stopPx: keepStop ?? this.brain(id).stopFor(theirs.instId, side, theirs.avgPx, this.ctx(id, now)),
            riskUsd: ours?.riskUsd ?? (inst ? Math.abs(theirs.pos) * inst.ctVal * theirs.avgPx * 0.01 : 0),
            trimmedAtR: keepFlags ? (ours!.trimmedAtR ?? null) : null,
            beMoved: keepFlags ? (ours!.beMoved ?? false) : false,
          };
          bee.flatSince = null;
        }
      }
      this.d.db.insertRecon(id, now, ok, { detail });
      if (!ok) diffs.push(`${this.d.cfg.slots[id].name}: ${detail}`);
    }
    const ok = diffs.length === 0;
    const was = this.recon.ok;
    this.recon = { ok, detail: ok ? "books match OKX" : diffs.join(" | "), ts: now };
    this.d.bus.emit("recon", { ok, detail: this.recon.detail }, now);
    if (!ok && was !== false) this.d.alerts.send(`reconciliation mismatch: ${this.recon.detail}`);
  }

  /** Momentum bees: who is #1 on the hourly rank, and for how many ranks in a row. */
  private rankBoozyHourly() {
    const now = this.now();
    for (const id of BEES) {
      if (this.d.cfg.slots[id].style !== "boozy") continue;
      const bee = this.bees[id];
      if (Math.floor(now / 3_600_000) === Math.floor(bee.top1.rankedAt / 3_600_000)) continue;
      // Each Momentum bee's own ranking: a coin-restricted bee only ranks its own coins.
      const topId = this.brain(id).universe(this.ctx(id, now))[0];
      if (!topId) continue;
      const coin = coinOf(topId);
      bee.top1 = { coin, streak: coin === bee.top1.coin ? bee.top1.streak + 1 : 1, rankedAt: now };
    }
  }

  private brains = {} as Record<BeeId, BeeBrain>;

  /** The slot's style brain, narrowed to the owner's coins and carrying the owner's rules (bees/custom.ts). */
  private brain(id: BeeId): BeeBrain {
    const s = this.d.cfg.slots[id];
    return (this.brains[id] ??= customBrain(BRAINS[s.style], { coins: s.coins, rules: s.rules }));
  }

  private knobs(id: BeeId) {
    return this.d.cfg.bees[this.d.cfg.slots[id].style];
  }

  /**
   * Outage detection runs on real calls only (jev.downSince is set by Jev.decide failures).
   * The cache heartbeat guarantees a real call at least every HEARTBEAT_TICKS decide ticks
   * per bee, so a "no real call for > X" stall cannot hide an outage: a down Jev is noticed
   * at the latest on the next heartbeat call, and "Jev is back" fires on the first success
   * after that. While downSince !== null the cache is bypassed, so detection and recovery
   * both observe live answers.
   */
  private checkJevOutage(now: number) {
    const since = this.d.jev.downSince;
    if (since === null) {
      if (this.jevDownAlerted) this.d.alerts.send("Jev is back");
      this.jevDownAlerted = false;
    } else if (!this.jevDownAlerted && now - since > 5 * 60_000) {
      this.jevDownAlerted = true;
      this.d.alerts.send("Jev unreachable for over 5 minutes: all bees holding");
    }
  }

  private sizeMult(now: number): number {
    const { cfg } = this.d;
    if (cfg.mode !== "live" || this.liveStartedAt === null) return 1;
    return now - this.liveStartedAt < cfg.risk.liveRampHours * 3_600_000 ? cfg.risk.liveSizeMultiplier : 1;
  }

  // ---------- read-only views for the dashboard ----------

  private publicBee(id: BeeId) {
    const b = this.bees[id];
    const view = this.d.feed.view();
    const p = b.position;
    const inst = p ? view.instruments.get(p.instId) : undefined;
    const mid = p ? view.tickers.get(p.instId)?.mid : undefined;
    const start = this.d.cfg.risk.startEquityUsd;
    const knobs = this.knobs(id);
    const r2 = (x: number) => Number(x.toFixed(2));
    return {
      bee: id,
      equityUsd: r2(b.equityUsd),
      pnlUsd: r2(b.equityUsd - start),
      pnlPct: r2(((b.equityUsd - start) / start) * 100),
      position: p
        ? {
            coin: p.coin,
            side: p.side,
            sizeUsd: inst && mid ? r2(positionNotional(p, mid, inst.ctVal)) : null,
            entryPx: p.entryPx,
            markPx: mid ?? null,
            stopPx: p.stopPx,
            uplUsd: r2(b.uplUsd),
            minutesHeld: Math.round(minutesSince(p.openedAt, this.now())),
          }
        : null,
      flatMinutes: p ? null : Math.round(minutesSince(b.flatSince, this.now())),
      tradesToday: b.tradesToday,
      maxTradesPerDay: knobs.maxTradesPerDay,
      feesTodayUsd: r2(b.feesTodayUsd),
      feeBudgetUsd: knobs.feeBudgetUsdDay,
      cap: b.cap,
      totals: { feesUsd: r2(b.totals.feesUsd), fundingUsd: r2(b.totals.fundingUsd), jevUsd: Number(b.totals.jevUsd.toFixed(4)), realisedUsd: r2(b.totals.realisedUsd), decisions: b.totals.decisions, orders: b.totals.orders,
        jevCallsMade: this.jevMade[id] ?? 0, jevCallsSkipped: this.jevSkipped[id] ?? 0, jevSavedUsd: Number(this.jevSavedUsd(id).toFixed(4)) },
      // Liq proxy (no veto): last + max notional/equity. Real guard awaits the OKX margin feed.
      liqProxy: { ratio: this.liqLast[id] ?? null, max: this.liqMax[id] ?? null, samples: this.liqSamples[id] ?? 0 },
      maxNotionalUsd: r2(maxNotionalUsd(this.ctx(id, this.now()))),
      last: this.last[id] ?? null,
    };
  }

  snapshot() {
    const bees = BEES.map((id) => this.publicBee(id));
    const sum = (f: (b: (typeof bees)[number]) => number) => Number(bees.reduce((a, b) => a + f(b), 0).toFixed(4));
    const view = this.d.feed.view();
    const scoutLatest = this.d.db.latestScoutSnapshot();
    return {
      ts: this.now(),
      mode: this.d.cfg.mode,
      startedAt: this.experimentStartedAt,
      closed: this.closedAt === null ? null : { at: this.closedAt, flat: BEES.every((id) => !this.bees[id].position) },
      startEquityUsd: this.d.cfg.risk.startEquityUsd,
      tickMs: this.d.cfg.tickMs,
      bees,
      leaderboard: [...bees].sort((a, b) => b.equityUsd - a.equityUsd).map((b) => ({ bee: b.bee, equityUsd: b.equityUsd })),
      totals: { feesUsd: sum((b) => b.totals.feesUsd), fundingUsd: sum((b) => b.totals.fundingUsd), jevUsd: sum((b) => b.totals.jevUsd), pnlUsd: sum((b) => b.pnlUsd) },
      jev: { spentTodayUsd: Number(this.d.jev.spentTodayUsd.toFixed(4)), dailyCapUsd: this.d.cfg.jev.dailyUsdCap, capTripped: this.d.jev.capTripped, down: this.d.jev.downSince !== null,
        heartbeatTicks: this.d.cfg.jev.heartbeatTicks,
        callsMade: BEES.reduce((a, id) => a + (this.jevMade[id] ?? 0), 0),
        callsSkipped: BEES.reduce((a, id) => a + (this.jevSkipped[id] ?? 0), 0),
        estSavedUsd: Number(BEES.reduce((a, id) => a + this.jevSavedUsd(id), 0).toFixed(4)) },
      recon: this.recon,
      market: {
        refreshedAt: view.ts,
        universe: view.gated.map((i) => i.split("-")[0]),
        spreadBlocked: view.spreadBlocked.map((i) => ({ coin: i.split("-")[0], spreadBp: Number((view.tickers.get(i)?.spreadBp ?? 0).toFixed(1)) })),
        attention: view.newsAvailable ? "news" : "volume",
      },
      // Latest scout shortlist transition (log-only visibility; nothing trades on it).
      scout: scoutLatest ? { ts: scoutLatest.ts, eligible: scoutLatest.eligible, excluded: scoutLatest.excluded } : null,
    };
  }

  health() {
    const age = this.now() - this.d.feed.lastRefreshAt;
    return { ok: this.d.feed.lastRefreshAt > 0 && age < 5 * this.d.cfg.dataRefreshMs, mode: this.d.cfg.mode, closed: this.closedAt !== null, flat: BEES.every((id) => !this.bees[id].position), marketAgeMs: age, uptimeS: Math.round((this.now() - this.startedAt) / 1000) };
  }
}

function fundingSlot(ms: number): number {
  const d = new Date(ms);
  const h = d.getUTCHours();
  const slotHour = [...FUNDING_HOURS_UTC].reverse().find((x) => h >= x) ?? 0;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), slotHour);
}

function describeAction(a: Action): string {
  switch (a.kind) {
    case "none":
      return "hold";
    case "close":
      return `close (${a.reason})`;
    case "trim":
      return `trim ${Math.round(a.fraction * 100)}%`;
    case "add":
      return `add $${a.notionalUsd.toFixed(0)}`;
    case "open":
      return `${a.side} ${a.instId.split("-")[0]} $${a.notionalUsd.toFixed(0)}`;
    case "switch":
      return `switch to ${a.side} ${a.instId.split("-")[0]} $${a.notionalUsd.toFixed(0)}`;
  }
}
