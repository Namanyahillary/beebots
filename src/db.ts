// SQLite (WAL) via node:sqlite. Hard rule 10: every decision is written before it is acted on.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BeeId } from "./config.js";
import type { BeeState, Position } from "./bees/types.js";
import type { ScoutEligibleEntry } from "./scout.js";

/** Backfill the one-shot take-profit flags on a stored position. Preserves set values across restores. */
export function normalizePosition(p: Position): Position {
  p.trimmedAtR ??= null;
  p.lastLadderR ??= null;
  p.beMoved ??= false;
  p.peakUplUsd ??= null;
  p.entryDecisionId ??= null;
  return p;
}

/**
 * Parse the eligible JSON of a scout row. Current rows hold enriched
 * {instId, toTriggerPct, trendSign} entries; rows from before the enrichment
 * hold plain instId strings and normalize to null-context entries. Defensive:
 * malformed entries are dropped, never thrown.
 */
export function parseScoutEligible(raw: string): ScoutEligibleEntry[] {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: ScoutEligibleEntry[] = [];
  for (const e of v) {
    if (typeof e === "string") {
      out.push({ instId: e, toTriggerPct: null, trendSign: null });
      continue;
    }
    if (typeof e !== "object" || e === null) continue;
    const o = e as Record<string, unknown>;
    if (typeof o.instId !== "string") continue;
    const pct = typeof o.toTriggerPct === "number" && Number.isFinite(o.toTriggerPct) ? o.toTriggerPct : null;
    const sign = o.trendSign === 1 || o.trendSign === -1 || o.trendSign === 0 ? o.trendSign : null;
    out.push({ instId: o.instId, toTriggerPct: pct, trendSign: sign });
  }
  return out;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY, bee TEXT NOT NULL, ts INTEGER NOT NULL,
  state_hash TEXT, state_json TEXT, menu_json TEXT,
  choice TEXT, probabilities_json TEXT, confidence REAL, conviction REAL,
  latency_ms INTEGER, input_tokens INTEGER, jev_cost_usd REAL NOT NULL DEFAULT 0, jev_error TEXT, jev_cached INTEGER NOT NULL DEFAULT 0, model TEXT,
  action_json TEXT NOT NULL, vetoed_by TEXT, forced_by TEXT, status TEXT
);
CREATE INDEX IF NOT EXISTS decisions_bee_ts ON decisions(bee, ts);
CREATE INDEX IF NOT EXISTS decisions_ts ON decisions(ts);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, decision_id INTEGER NOT NULL, bee TEXT NOT NULL, ts INTEGER NOT NULL,
  cl_ord_id TEXT NOT NULL UNIQUE, ord_id TEXT, inst_id TEXT NOT NULL, side TEXT NOT NULL,
  contracts REAL NOT NULL, reduce_only INTEGER NOT NULL, purpose TEXT NOT NULL,
  state TEXT NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, bee TEXT NOT NULL, ts INTEGER NOT NULL,
  inst_id TEXT NOT NULL, side TEXT NOT NULL, contracts REAL NOT NULL, px REAL NOT NULL,
  notional_usd REAL NOT NULL, fee_usd REAL NOT NULL, realised_usd REAL NOT NULL,
  entry_decision_id INTEGER
);
CREATE INDEX IF NOT EXISTS fills_bee_ts ON fills(bee, ts);
CREATE TABLE IF NOT EXISTS funding (
  id INTEGER PRIMARY KEY, bee TEXT NOT NULL, ts INTEGER NOT NULL, inst_id TEXT,
  amount_usd REAL NOT NULL, bill_id TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS equity_snapshots (bee TEXT NOT NULL, ts INTEGER NOT NULL, equity_usd REAL, cash_usd REAL, upl_usd REAL);
CREATE INDEX IF NOT EXISTS equity_bee_ts ON equity_snapshots(bee, ts);
CREATE TABLE IF NOT EXISTS reconciliations (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, bee TEXT NOT NULL, ok INTEGER NOT NULL, diff_json TEXT);
CREATE TABLE IF NOT EXISTS caps (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, bee TEXT NOT NULL, cap TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS bee_state (bee TEXT PRIMARY KEY, json TEXT NOT NULL, updated_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS ghost_decisions (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, bee TEXT NOT NULL,
  choice TEXT, reason TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS ghost_decisions_bee_ts ON ghost_decisions(bee, ts);
CREATE INDEX IF NOT EXISTS ghost_decisions_ts ON ghost_decisions(ts);
CREATE TABLE IF NOT EXISTS scout_snapshots (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL,
  eligible TEXT NOT NULL, excluded TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scout_snapshots_ts ON scout_snapshots(ts);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export interface DecisionRow {
  bee: BeeId;
  ts: number;
  stateHash: string | null;
  stateJson: string | null;
  menuJson: string | null;
  choice: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  conviction: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
  jevCostUsd: number;
  jevError: string | null;
  /** True when the Jev answer was reused from the per-bee cache (no API call this tick). */
  jevCached?: boolean | null;
  /** Reasoning model that produced this decision (distinguishes Jev vs interim backends). */
  model?: string | null;
  action: unknown;
  vetoedBy: string | null;
  forcedBy: string | null;
  status: string;
}

export interface OrderRow {
  decisionId: number;
  bee: BeeId;
  ts: number;
  clOrdId: string;
  instId: string;
  side: "buy" | "sell";
  contracts: number;
  reduceOnly: boolean;
  purpose: string;
}

export interface FillRow {
  orderId: number;
  bee: BeeId;
  ts: number;
  instId: string;
  side: "buy" | "sell";
  contracts: number;
  px: number;
  notionalUsd: number;
  feeUsd: number;
  realisedUsd: number;
  /** decisions.id that opened the position this fill reduces (null on opens / pre-attribution rows). */
  entryDecisionId?: number | null;
}

/** A ghost (paper-only, never executed) decision. Fully separate from orders/fills/decisions: no helpers here ever write to those tables. */
export interface GhostDecisionRow {
  bee: BeeId;
  ts: number;
  choice: string | null;
  reason: string | null;
  detail: unknown;
}

/** A scout shortlist transition: what passed the screen plus a sampled why-not for the rest. Log-only, never gates trading. */
export interface ScoutSnapshotRow {
  ts: number;
  /** Enriched entries (direction context); legacy rows stored plain instId strings. */
  eligible: ScoutEligibleEntry[];
  excluded: Array<{ instId: string; reasons: string[] }>;
}

/** A fill as the Hive sees it (hive.ts): base-asset quantity, no order ids, no account data. */
export interface HiveFill {
  slot: string;
  instId: string;
  side: "buy" | "sell";
  qty: number;
  px: number;
  ts: number;
  feeUsd: number;
  reduceOnly: boolean;
}

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.raw.exec(SCHEMA);
    // Existing DBs predate jev_cached/model: backfill the columns once. Fresh DBs already have them via SCHEMA.
    const cols = this.raw.prepare(`PRAGMA table_info(decisions)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "jev_cached")) {
      this.raw.exec(`ALTER TABLE decisions ADD COLUMN jev_cached INTEGER NOT NULL DEFAULT 0`);
    }
    if (!cols.some((c) => c.name === "model")) {
      this.raw.exec(`ALTER TABLE decisions ADD COLUMN model TEXT`);
    }
    // Existing fills predate close attribution: backfill the entry link once. Fresh DBs have it via SCHEMA.
    const fillCols = this.raw.prepare(`PRAGMA table_info(fills)`).all() as Array<{ name: string }>;
    if (!fillCols.some((c) => c.name === "entry_decision_id")) {
      this.raw.exec(`ALTER TABLE fills ADD COLUMN entry_decision_id INTEGER`);
    }
  }

  insertDecision(d: DecisionRow): number {
    const r = this.raw
      .prepare(
        `INSERT INTO decisions (bee, ts, state_hash, state_json, menu_json, choice, probabilities_json, confidence, conviction,
          latency_ms, input_tokens, jev_cost_usd, jev_error, jev_cached, model, action_json, vetoed_by, forced_by, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        d.bee, d.ts, d.stateHash, d.stateJson, d.menuJson, d.choice, d.probabilities ? JSON.stringify(d.probabilities) : null,
        d.confidence, d.conviction, d.latencyMs, d.inputTokens, d.jevCostUsd, d.jevError, d.jevCached ? 1 : 0, d.model ?? null, JSON.stringify(d.action),
        d.vetoedBy, d.forcedBy, d.status,
      );
    return Number(r.lastInsertRowid);
  }

  insertOrder(o: OrderRow): number {
    const r = this.raw
      .prepare(
        `INSERT INTO orders (decision_id, bee, ts, cl_ord_id, inst_id, side, contracts, reduce_only, purpose, state)
         VALUES (?,?,?,?,?,?,?,?,?,'sent')`,
      )
      .run(o.decisionId, o.bee, o.ts, o.clOrdId, o.instId, o.side, o.contracts, o.reduceOnly ? 1 : 0, o.purpose);
    return Number(r.lastInsertRowid);
  }

  updateOrder(id: number, state: string, ordId: string | null, error: string | null): void {
    this.raw.prepare(`UPDATE orders SET state = ?, ord_id = COALESCE(?, ord_id), error = ? WHERE id = ?`).run(state, ordId, error, id);
  }

  insertFill(f: FillRow): void {
    this.raw
      .prepare(`INSERT INTO fills (order_id, bee, ts, inst_id, side, contracts, px, notional_usd, fee_usd, realised_usd, entry_decision_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(f.orderId, f.bee, f.ts, f.instId, f.side, f.contracts, f.px, f.notionalUsd, f.feeUsd, f.realisedUsd, f.entryDecisionId ?? null);
  }

  /**
   * Closed R by entry source: every close/trim fill joined to the decision
   * that opened its position. Source is read off the entry decision row —
   * forced_by set means code forced it in, jev_cached means a reused answer,
   * input tokens means a fresh Jev call, otherwise the rule path decided.
   * Rows from before attribution existed land in 'unknown'. Trims count: a
   * partial bank is realised P&L from that entry choice all the same.
   */
  closeAttribution(): Array<{ bee: string; source: string; fills: number; pnlUsd: number; feesUsd: number }> {
    const rows = this.raw
      .prepare(
        `SELECT f.bee AS bee,
          CASE WHEN d.forced_by IS NOT NULL THEN 'forced:' || d.forced_by
               WHEN d.jev_cached = 1 THEN 'jev-cached'
               WHEN d.input_tokens IS NOT NULL THEN 'jev-fresh'
               WHEN f.entry_decision_id IS NULL THEN 'unknown'
               ELSE 'rule' END AS source,
          COUNT(*) AS fills, COALESCE(SUM(f.realised_usd), 0) AS pnl, COALESCE(SUM(f.fee_usd), 0) AS fees
         FROM fills f LEFT JOIN decisions d ON d.id = f.entry_decision_id
         JOIN orders o ON o.id = f.order_id
         WHERE o.reduce_only = 1
         GROUP BY f.bee, source ORDER BY f.bee, pnl`,
      )
      .all() as Array<{ bee: string; source: string; fills: number; pnl: number; fees: number }>;
    return rows.map((r) => ({ bee: r.bee, source: r.source, fills: r.fills, pnlUsd: r.pnl, feesUsd: r.fees }));
  }

  /**
   * Every fill since `sinceTs`, oldest first, at most `limit`. Base-asset qty = contracts x ctVal, which is
   * notional / px (the engine records notional = contracts x ctVal x px), so no instrument lookup is needed.
   */
  hiveFills(sinceTs: number, limit: number): HiveFill[] {
    const rows = this.raw
      .prepare(
        `SELECT f.bee, f.inst_id AS instId, f.side, f.notional_usd AS notional, f.px, f.ts, f.fee_usd AS fee, COALESCE(o.reduce_only, 0) AS ro
         FROM fills f LEFT JOIN orders o ON o.id = f.order_id WHERE f.ts >= ? ORDER BY f.ts, f.id LIMIT ?`,
      )
      .all(sinceTs, limit) as Array<{ bee: string; instId: string; side: "buy" | "sell"; notional: number; px: number; ts: number; fee: number; ro: number }>;
    return rows
      .filter((r) => r.px > 0)
      .map((r) => ({
        slot: r.bee,
        instId: r.instId,
        side: r.side,
        qty: Number((Math.abs(r.notional) / r.px).toPrecision(12)),
        px: r.px,
        ts: r.ts,
        feeUsd: Number(r.fee.toFixed(6)),
        reduceOnly: r.ro === 1,
      }));
  }

  /** Returns false if this bill was already recorded. */
  insertFunding(bee: BeeId, ts: number, instId: string | null, amountUsd: number, billId: string): boolean {
    const r = this.raw.prepare(`INSERT OR IGNORE INTO funding (bee, ts, inst_id, amount_usd, bill_id) VALUES (?,?,?,?,?)`).run(bee, ts, instId, amountUsd, billId);
    return Number(r.changes) > 0;
  }

  insertEquity(bee: BeeId, ts: number, equity: number, cash: number, upl: number): void {
    this.raw.prepare(`INSERT INTO equity_snapshots (bee, ts, equity_usd, cash_usd, upl_usd) VALUES (?,?,?,?,?)`).run(bee, ts, equity, cash, upl);
  }

  /** Equity per bee, bucketed to at most ~`points` samples (last value in each bucket). */
  equitySeries(sinceTs: number, points: number): Record<string, Array<[number, number]>> {
    const span = Math.max(1, Date.now() - sinceTs);
    const bucket = Math.max(10_000, Math.ceil(span / points));
    const rows = this.raw
      .prepare(`SELECT bee, MAX(ts) AS ts, equity_usd AS eq FROM equity_snapshots WHERE ts >= ? GROUP BY bee, ts / ? ORDER BY ts`)
      .all(sinceTs, bucket) as Array<{ bee: string; ts: number; eq: number }>;
    const out: Record<string, Array<[number, number]>> = {};
    for (const r of rows) (out[r.bee] ??= []).push([r.ts, Number(r.eq.toFixed(2))]);
    return out;
  }

  insertRecon(bee: BeeId, ts: number, ok: boolean, diff: unknown): void {
    this.raw.prepare(`INSERT INTO reconciliations (ts, bee, ok, diff_json) VALUES (?,?,?,?)`).run(ts, bee, ok ? 1 : 0, JSON.stringify(diff));
  }

  insertCap(bee: BeeId, ts: number, cap: string, detail: string): void {
    this.raw.prepare(`INSERT INTO caps (ts, bee, cap, detail) VALUES (?,?,?,?)`).run(ts, bee, cap, detail);
  }

  saveBee(s: BeeState, ts: number): void {
    this.raw.prepare(`INSERT INTO bee_state (bee, json, updated_ts) VALUES (?,?,?) ON CONFLICT(bee) DO UPDATE SET json = excluded.json, updated_ts = excluded.updated_ts`).run(s.id, JSON.stringify(s), ts);
  }

  loadBee(bee: BeeId): BeeState | null {
    const row = this.raw.prepare(`SELECT json FROM bee_state WHERE bee = ?`).get(bee) as { json: string } | undefined;
    if (!row) return null;
    const s = JSON.parse(row.json) as BeeState;
    // Migrate old rows: default the one-shot take-profit flags, preserve them when already set
    // (reconcile restores must carry these over rather than resetting them).
    if (s.position) s.position = normalizePosition(s.position);
    return s;
  }

  insertEvent(ts: number, type: string, json: string): void {
    this.raw.prepare(`INSERT INTO events (ts, type, json) VALUES (?,?,?)`).run(ts, type, json);
  }

  recentEvents(n: number): string[] {
    // Decision ticks flood the table: reserve room so fills/caps/funding are never
    // pushed out of the window (Fills card showed "none yet" with fills in the DB).
    type Row = { id: number; json: string };
    const dec = this.raw
      .prepare(`SELECT id, json FROM events WHERE type = 'decision' ORDER BY id DESC LIMIT ?`)
      .all(n) as Row[];
    const rest = this.raw
      .prepare(`SELECT id, json FROM events WHERE type != 'decision' ORDER BY id DESC LIMIT 50`)
      .all() as Row[];
    return [...dec, ...rest].sort((a, b) => a.id - b.id).map((r) => r.json);
  }

  pruneEvents(olderThanTs: number): void {
    this.raw.prepare(`DELETE FROM events WHERE ts < ?`).run(olderThanTs);
  }

  /**
   * Trigger scoreboard: offered/picked counts per entry-trigger label
   * (STINGER_/BREAKOUT_/SCALP_/FADE_/BOUNCE_/PULLBACK_) over recent trigger-bearing decisions.
   * Powers GET /setups — the dashboard panel can't live on the live window
   * alone (50 rows ≈ 90 seconds across six bees; triggers are rare events).
   * The LIKE prefilter anchors on `"menu":["` so veto/status prose that merely
   * mentions a label ("wanted SCALP_X, code said no") never counts.
   */
  triggerScoreboard(limit = 200): Array<{ label: string; offered: number; picked: number; lastSeen: number }> {
    const like = (t: string) => `json LIKE '%"menu":["%${t}%'`;
    const rows = this.raw
      .prepare(`SELECT json FROM events WHERE type = 'decision' AND (${like("STINGER_")} OR ${like("BREAKOUT_")} OR ${like("SCALP_")} OR ${like("FADE_")} OR ${like("BOUNCE_")} OR ${like("PULLBACK_")}) ORDER BY id DESC LIMIT ?`)
      .all(limit) as Array<{ json: string }>;
    const re = /^(STINGER|BREAKOUT|SCALP|FADE|BOUNCE|PULLBACK)_/;
    const by = new Map<string, { label: string; offered: number; picked: number; lastSeen: number }>();
    for (const r of rows) {
      let d: { ts?: number; menu?: string[]; choice?: string | null };
      try {
        d = JSON.parse(r.json) as { ts?: number; menu?: string[]; choice?: string | null };
      } catch {
        continue;
      }
      const ts = typeof d.ts === "number" ? d.ts : 0;
      for (const label of d.menu ?? []) {
        if (!re.test(label)) continue;
        const row = by.get(label) ?? { label, offered: 0, picked: 0, lastSeen: 0 };
        row.offered++;
        if (d.choice === label) row.picked++;
        if (ts > row.lastSeen) row.lastSeen = ts;
        by.set(label, row);
      }
    }
    return [...by.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** Ghost path only: records a paper decision that was never executed. Never touches orders/fills. */
  insertGhostDecision(g: GhostDecisionRow): number {
    const r = this.raw
      .prepare(`INSERT INTO ghost_decisions (ts, bee, choice, reason, detail) VALUES (?,?,?,?,?)`)
      .run(g.ts, g.bee, g.choice, g.reason, g.detail === undefined ? null : JSON.stringify(g.detail));
    return Number(r.lastInsertRowid);
  }

  pruneGhostDecisions(olderThanTs: number): void {
    this.raw.prepare(`DELETE FROM ghost_decisions WHERE ts < ?`).run(olderThanTs);
  }

  /** Scout path only: records a shortlist transition. Never touches orders/fills/decisions. */
  insertScoutSnapshot(s: { ts: number; eligible: Array<string | ScoutEligibleEntry>; excluded: ScoutSnapshotRow["excluded"] }): number {
    const eligible: ScoutEligibleEntry[] = s.eligible.map((e) =>
      typeof e === "string" ? { instId: e, toTriggerPct: null, trendSign: null } : { instId: e.instId, toTriggerPct: e.toTriggerPct ?? null, trendSign: e.trendSign ?? null },
    );
    const r = this.raw
      .prepare(`INSERT INTO scout_snapshots (ts, eligible, excluded) VALUES (?,?,?)`)
      .run(s.ts, JSON.stringify(eligible), JSON.stringify(s.excluded));
    return Number(r.lastInsertRowid);
  }

  /** The most recent scout snapshot, or null when the scout has never stored one. */
  latestScoutSnapshot(): (ScoutSnapshotRow & { id: number }) | null {
    const row = this.raw.prepare(`SELECT id, ts, eligible, excluded FROM scout_snapshots ORDER BY id DESC LIMIT 1`).get() as
      | { id: number; ts: number; eligible: string; excluded: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      ts: row.ts,
      eligible: parseScoutEligible(row.eligible),
      excluded: JSON.parse(row.excluded) as Array<{ instId: string; reasons: string[] }>,
    };
  }

  /** First recorded decision and fill per bee (birth = first decision). Nulls when a bee has no rows yet. */
  firstActivity(): Record<string, { decisions: number | null; fills: number | null }> {
    const out: Record<string, { decisions: number | null; fills: number | null }> = {};
    for (const row of this.raw.prepare(`SELECT bee, MIN(ts) AS ts FROM decisions GROUP BY bee`).all() as Array<{ bee: string; ts: number }>) {
      out[row.bee] = { decisions: row.ts, fills: null };
    }
    for (const row of this.raw.prepare(`SELECT bee, MIN(ts) AS ts FROM fills GROUP BY bee`).all() as Array<{ bee: string; ts: number }>) {
      (out[row.bee] ??= { decisions: null, fills: null }).fills = row.ts;
    }
    return out;
  }

  /** Recent scout snapshots, newest first, at most `limit`. Powers GET /scout/history. */
  scoutHistory(limit: number): Array<ScoutSnapshotRow & { id: number }> {
    const n = Math.max(1, Math.min(50, Math.floor(limit) || 20));
    const rows = this.raw.prepare(`SELECT id, ts, eligible, excluded FROM scout_snapshots ORDER BY id DESC LIMIT ?`).all(n) as Array<{
      id: number;
      ts: number;
      eligible: string;
      excluded: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      eligible: parseScoutEligible(row.eligible),
      excluded: JSON.parse(row.excluded) as Array<{ instId: string; reasons: string[] }>,
    }));
  }

  pruneScoutSnapshots(olderThanTs: number): void {
    this.raw.prepare(`DELETE FROM scout_snapshots WHERE ts < ?`).run(olderThanTs);
  }

  jevSpendSince(ts: number): number {
    const r = this.raw.prepare(`SELECT COALESCE(SUM(jev_cost_usd), 0) AS s FROM decisions WHERE ts >= ?`).get(ts) as { s: number };
    return r.s;
  }

  getMeta(k: string): string | null {
    const r = this.raw.prepare(`SELECT v FROM meta WHERE k = ?`).get(k) as { v: string } | undefined;
    return r?.v ?? null;
  }

  setMeta(k: string, v: string): void {
    this.raw.prepare(`INSERT INTO meta (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, v);
  }

  close(): void {
    this.raw.close();
  }
}
