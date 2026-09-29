// Stall meter: would banking flat winners early have beaten holding?
// For every attributed closed position (entry link + decisions between open and
// close), it replays upl_r from state_json and reports hold time, peak R,
// exit R, and giveback (peak - exit). Buckets by hold time. Descriptive only —
// the stall-close rule graduates from this data, not from opinions.
// Usage: pnpm stall:value [path/to/db.sqlite] (default ./data/bees-dry.sqlite)
import { createRequire } from "node:module";
import { Db } from "../db.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface StallWindow {
  bee: string;
  entryTs: number;
  exitTs: number;
  holdMin: number;
  exitR: number;
  peakR: number;
  peakAtMin: number;
  givebackR: number;
}

interface RawDb {
  prepare(sql: string): { all(...p: unknown[]): Array<{ [k: string]: unknown }> };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Reconstruct closed-position R trajectories. Pre-attribution closes (no entry link) are excluded. */
export function loadWindows(db: RawDb): StallWindow[] {
  const closes = db.prepare(
    `SELECT f.entry_decision_id AS did, f.bee AS bee, MAX(f.ts) AS exitTs,
            COALESCE(SUM(f.realised_usd), 0) AS pnl
     FROM fills f JOIN orders o ON o.id = f.order_id
     WHERE o.reduce_only = 1 AND f.entry_decision_id IS NOT NULL
     GROUP BY f.entry_decision_id, f.bee`,
  ).all() as Array<{ did: number; bee: string; exitTs: number; pnl: number }>;
  const out: StallWindow[] = [];
  for (const c of closes) {
    const decs = db.prepare(
      `SELECT ts, state_json AS sj FROM decisions WHERE bee = ? AND ts >= (SELECT ts FROM decisions WHERE id = ?) AND ts <= ? ORDER BY ts`,
    ).all(c.bee, c.did, c.exitTs) as Array<{ ts: number; sj: string }>;
    let peakR = -Infinity;
    let peakAt = 0;
    let lastR: number | null = null;
    let entryTs = 0;
    for (const d of decs) {
      if (!entryTs) entryTs = d.ts;
      try {
        const me = (JSON.parse(d.sj) as { me?: { upl_r?: unknown } }).me;
        const r = num(me?.upl_r);
        if (r === null) continue;
        lastR = r;
        if (r > peakR) {
          peakR = r;
          peakAt = d.ts;
        }
      } catch {
        continue;
      }
    }
    if (peakR === -Infinity || lastR === null || !entryTs) continue;
    out.push({
      bee: c.bee,
      entryTs,
      exitTs: c.exitTs,
      holdMin: Math.max(0, (c.exitTs - entryTs) / 60_000),
      exitR: lastR,
      peakR,
      peakAtMin: Math.max(0, (peakAt - entryTs) / 60_000),
      givebackR: Math.max(0, peakR - lastR),
    });
  }
  return out;
}

const BUCKETS: Array<{ name: string; minMin: number; maxMin: number }> = [
  { name: "<1h", minMin: 0, maxMin: 60 },
  { name: "1-4h", minMin: 60, maxMin: 240 },
  { name: "4-12h", minMin: 240, maxMin: 720 },
  { name: "12h+", minMin: 720, maxMin: Number.POSITIVE_INFINITY },
];

/** Stall candidates: profitable peak, meaningful giveback, held long enough to judge. */
export const STALL_PEAK_R = 0.2;
export const STALL_GIVEBACK_R = 0.2;
export const STALL_HOLD_MIN = 120;

export function summarize(windows: StallWindow[]) {
  return BUCKETS.map((b) => {
    const rows = windows.filter((w) => w.holdMin >= b.minMin && w.holdMin < b.maxMin);
    const stalls = rows.filter((w) => w.peakR >= STALL_PEAK_R && w.givebackR >= STALL_GIVEBACK_R && w.holdMin >= STALL_HOLD_MIN);
    return {
      bucket: b.name,
      n: rows.length,
      stalls: stalls.length,
      givebackR: rows.reduce((a, w) => a + w.givebackR, 0),
      stallGivebackR: stalls.reduce((a, w) => a + w.givebackR, 0),
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.argv[2] ?? process.env.DB_PATH ?? "./data/bees-dry.sqlite";
  new Db(dbPath).close(); // SCHEMA + column backfills on old books.
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  const windows = loadWindows(raw as unknown as RawDb);
  console.log(`Stall meter — ${dbPath}: ${windows.length} attributed closed positions\n`);
  if (!windows.length) {
    console.log("(nothing yet — close attribution started 2026-09-29; resolves accrue with live trading)");
  } else {
    console.log("hold    n  stalls  givebackR  stallGivebackR");
    for (const s of summarize(windows)) {
      console.log(`${s.bucket.padEnd(6)}${String(s.n).padStart(4)}${String(s.stalls).padStart(8)}${s.givebackR.toFixed(2).padStart(11)}${s.stallGivebackR.toFixed(2).padStart(15)}`);
    }
    console.log(`\nstall = peak ≥ +${STALL_PEAK_R}R, gave back ≥ ${STALL_GIVEBACK_R}R, held ≥ ${STALL_HOLD_MIN}m. stallGivebackR is what banking stalls at their peak would have kept.`);
  }
}
