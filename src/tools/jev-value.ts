// Jev value report: is the model doing good or bad?
// Reads close attribution (closed R by entry source) + shadow books (no-Jev
// counterfactual R) + Jev spend from a DB file, and prints the three numbers
// side by side. Descriptive until the samples mature — the verdict needs
// closed trades in each bucket, not opinions.
// Usage: pnpm jev:value [path/to/db.sqlite] (default ./data/bees-dry.sqlite)
import { createRequire } from "node:module";
import { Db } from "../db.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const dbPath = process.argv[2] ?? process.env.DB_PATH ?? "./data/bees-dry.sqlite";
// Db constructor applies SCHEMA + column backfills (entry_decision_id on old books).
new Db(dbPath).close();
const db = new DatabaseSync(dbPath, { readOnly: true });

const r2 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(2);

console.log(`Jev value — ${dbPath}\n`);

// 1. Closed R by entry source (close fills joined to their entry decision).
const attr = db.prepare(
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
).all() as Array<{ bee: string; source: string; fills: number; pnl: number; fees: number }>;
console.log("closed $ by entry source (trims count — a partial bank is realised P&L):");
console.log("bee   source       fills      pnl$     fees$");
for (const r of attr) console.log(`${r.bee.padEnd(6)}${r.source.padEnd(13)}${String(r.fills).padStart(6)}  ${r2(r.pnl).padStart(8)}  ${r.fees.toFixed(2).padStart(7)}`);
if (!attr.length) console.log("(no attributed closes yet — attribution started 2026-09-29; older fills are 'unknown')");

// 2. Shadow books (no-Jev counterfactual, gross R).
const sh = db.prepare(
  `SELECT bee, COUNT(*) AS fills, COALESCE(SUM(CAST(JSON_EXTRACT(detail, '$.r') AS REAL)), 0) AS r
   FROM ghost_decisions WHERE choice = 'SHADOW_FILL' GROUP BY bee ORDER BY bee`,
).all() as Array<{ bee: string; fills: number; r: number }>;
console.log("\nshadow R (first-strict-setup, same exits, gross — live R is gross too):");
for (const r of sh) console.log(`${r.bee.padEnd(6)}${String(r.fills).padStart(6)} fills   ${r2(r.r).padStart(8)}R`);
if (!sh.length) console.log("(no shadow fills yet — the arm started 2026-09-29)");

// 3. What Jev cost.
const cost = db.prepare(
  `SELECT COALESCE(SUM(jev_cost_usd), 0) AS usd, COUNT(*) AS n,
    COALESCE(SUM(CASE WHEN jev_cached = 1 THEN 1 ELSE 0 END), 0) AS cached
   FROM decisions`,
).get() as { usd: number; n: number; cached: number };
console.log(`\njev spend: $${cost.usd.toFixed(4)} across ${cost.n} decisions (${cost.cached} cached answers reused)`);
console.log("\nRead it as: attribution says WHOSE entries paid, shadow says WHAT IF there were no model, spend says what the model cost. Verdict needs samples in every bucket.");
