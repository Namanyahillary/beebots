// Scout history (read-only log): recent shortlist transitions, newest first.
// Arrows describe SCREENING context (through-trigger / trend-score sign), never
// a trade recommendation. The scout never gates trading.
import { useEffect, useState } from "react";
import { useCollapsed } from "./collapse";
import { Help } from "./Help";
import { scoutAge, scoutEligibleId } from "./Scout";
import type { ScoutEligibleEntry, ScoutHistoryRow } from "./types";

const coinOf = (instId: string) => instId.split("-")[0];

/**
 * Screening-context arrow for one eligible entry:
 * ▲ long-bias when through the trigger (toTriggerPct <= 0) or trend score > 0,
 * ▼ when trend score < 0, · otherwise (neutral / no data).
 */
export function scoutArrow(e: string | ScoutEligibleEntry): "▲" | "▼" | "·" {
  if (typeof e === "string") return "·";
  if (e.toTriggerPct !== null && e.toTriggerPct <= 0) return "▲";
  if (e.trendSign !== null && e.trendSign > 0) return "▲";
  if (e.trendSign !== null && e.trendSign < 0) return "▼";
  return "·";
}

/** "+1.23%" / "-0.42%"; null when absent or non-finite. */
export function formatTriggerPct(pct: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

/** Most frequent excluded reason (the sampled why-not is already volume-ranked). Null when empty. */
export function topExcludedReason(excluded: Array<{ reasons: string[] }>): string | null {
  const counts = new Map<string, number>();
  for (const e of excluded) for (const r of e.reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  let top: string | null = null;
  let topN = 0;
  for (const [r, n] of counts) {
    if (n > topN) {
      top = r;
      topN = n;
    }
  }
  return top;
}

function EligibleChip({ entry }: { entry: string | ScoutEligibleEntry }) {
  const id = scoutEligibleId(entry);
  const arrow = scoutArrow(entry);
  const pct = typeof entry === "string" ? null : formatTriggerPct(entry.toTriggerPct);
  return (
    <span title={id}>
      {arrow} {coinOf(id)}
      {pct !== null && <span className="dim"> {pct}</span>}
    </span>
  );
}

export function ScoutLog() {
  const [collapsed, collapseBtn] = useCollapsed("scout-log");
  const [rows, setRows] = useState<ScoutHistoryRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/scout/history?n=20", { cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw new Error(`scout/history ${r.status}`);
          return r.json() as Promise<ScoutHistoryRow[]>;
        })
        .then((data) => alive && setRows(data))
        .catch(() => {});
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <section className={`rail-card scout${collapsed ? " collapsed" : ""}`}>
      <div className="rail-head">
        <span className="eyebrow">
          Scout log{" "}
          <Help title="Scout log">
            <p>Recent shortlist transitions, newest first. Screening context, not signals.</p>
            <dl>
              <dt>Arrows</dt>
              <dd>▲ means the coin sat through its breakout trigger or its trend score ran positive; ▼ means a negative trend score; · is neutral or no data. They describe the screen, never a trade recommendation.</dd>
              <dt>New rows</dt>
              <dd>A row appears only when the eligible set changes; proximity wiggles alone never log.</dd>
              <dt>Trading</dt>
              <dd>Scout never gates trading and each wolf still trades its own universe.</dd>
            </dl>
          </Help>
        </span>
        <span className="num dim">screening context, not signals</span>
        {collapseBtn}
      </div>
      {!collapsed && (
        <>
          {rows === null ? (
            <div className="dim">loading…</div>
          ) : rows.length === 0 ? (
            <div className="dim">no scout history yet</div>
          ) : (
            <div className="scout-excluded-list">
              {rows.map((row) => {
                const top = topExcludedReason(row.excluded);
                return (
                  <div key={row.id}>
                    <div className="scout-excluded">
                      <span className="num dim">{scoutAge(row.ts, Date.now())}</span>
                    </div>
                    {row.eligible.length > 0 ? (
                      <div className="blocked-list num">
                        {row.eligible.map((e) => (
                          <EligibleChip key={scoutEligibleId(e)} entry={e} />
                        ))}
                      </div>
                    ) : (
                      <div className="dim">nothing passing the screen</div>
                    )}
                    <div className="dim">
                      {row.excluded.length} excluded{top !== null ? ` · top: ${top}` : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
