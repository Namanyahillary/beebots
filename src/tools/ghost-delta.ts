// Offline ghost benchmark report (pre-registered metric, part 1).
// Reads ghost_decisions + decisions from a DB file and reports what needs no
// price history: ghost pick distribution and ghost-vs-real agreement rate.
// (Fee-adjusted equity delta needs exit rules + historical marks — recorded in
// ghost detail mids going forward; this tool grows into it, it does not fake it.)
// Usage: pnpm ghost-delta [path/to/db.sqlite]   (default ./data/bees-dry.sqlite — check --help or engine DB_PATH)
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const dbPath = process.argv[2] ?? process.env.DB_PATH ?? "./data/bees-dry.sqlite";
const db = new DatabaseSync(dbPath, { readOnly: true });

interface GhostRow { ts: number; bee: string; choice: string | null; reason: string }
interface RealRow { ts: number; bee: string; choice: string | null }

const ghosts = db.prepare(`SELECT ts, bee, choice, reason FROM ghost_decisions ORDER BY ts`).all() as unknown as GhostRow[];
const reals = db.prepare(`SELECT ts, bee, choice FROM decisions ORDER BY ts`).all() as unknown as RealRow[];

if (!ghosts.length) {
  console.log("no ghost rows yet — the benchmark sampler writes every 6th tick once the engine runs.");
  process.exit(0);
}

const byBee = new Map<string, GhostRow[]>();
for (const g of ghosts) byBee.set(g.bee, [...(byBee.get(g.bee) ?? []), g]);
const realByBee = new Map<string, RealRow[]>();
for (const r of reals) realByBee.set(r.bee, [...(realByBee.get(r.bee) ?? []), r]);

const WINDOW_MS = 30_000; // ghost is sampled; match nearest real decision within one window
for (const [bee, rows] of byBee) {
  const rr = realByBee.get(bee) ?? [];
  let agree = 0;
  let compared = 0;
  const reasons = new Map<string, number>();
  for (const g of rows) {
    reasons.set(g.reason, (reasons.get(g.reason) ?? 0) + 1);
    if (g.choice === null) continue;
    let best: RealRow | null = null;
    let bestDt = WINDOW_MS;
    for (const x of rr) {
      const dt = Math.abs(x.ts - g.ts);
      if (dt < bestDt) { bestDt = dt; best = x; }
    }
    if (!best || best.choice === null) continue;
    compared++;
    // Ghost "hold" agrees with any real non-open (hold/trim/none) — both mean "no new exposure".
    const ghostHold = g.choice === "hold";
    const realHold = best.choice === "hold" || best.choice === null || /^HOLD|RIDE|WAIT/.test(best.choice);
    if (g.choice === best.choice || (ghostHold && realHold)) agree++;
  }
  const pct = compared ? ((100 * agree) / compared).toFixed(1) : "n/a";
  console.log(`bee=${bee} ghost_rows=${rows.length} compared=${compared} agreement=${pct}%`);
  for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${reason}: ${n}`);
}
console.log("\nReading: high agreement + ghost never trading = JEV mostly confirms the deterministic read;");
console.log("low agreement + real outperforming = JEV earns it; low agreement + ghost outperforming = promote the chooser.");
