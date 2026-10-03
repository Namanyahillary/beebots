import { useEffect } from "react";
import type { BeeName } from "./types";
import type { Curve } from "./useFeed";

const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const dayLabel = (key: string) => {
  const [, m, d] = key.split("-");
  return `${m}-${d}`;
};
const money1 = (x: number) => `${x < 0 ? "−" : "+"}$${Math.abs(x).toFixed(x === 0 ? 0 : 2)}`;

/** Pack P&L per UTC day, from the equity snapshots already in the feed.
    Day P&L = last minus first snapshot of the day, summed over bees. No anchor
    needed, so the first day in range is exact too. Display only. */
export function dayPnl(curves: Partial<Record<BeeName, Curve>>, days = 14): Array<{ key: string; pnl: number; today: boolean }> {
  const today = dayKey(Date.now());
  const perDay = new Map<string, number>();
  for (const curve of Object.values(curves)) {
    if (!curve || curve.length === 0) continue;
    const first = new Map<string, number>();
    const last = new Map<string, number>();
    for (const [ts, eq] of curve) {
      const k = dayKey(ts);
      if (!first.has(k)) first.set(k, eq);
      last.set(k, eq);
    }
    for (const [k, f] of first) perDay.set(k, (perDay.get(k) ?? 0) + (last.get(k) ?? f) - f);
  }
  return [...perDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-days)
    .map(([key, pnl]) => ({ key, pnl, today: key === today }));
}

export function DayPnl({ curves, onClose }: { curves: Partial<Record<BeeName, Curve>>; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = dayPnl(curves);
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.pnl)));
  const total = rows.reduce((a, r) => a + r.pnl, 0);

  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal daypnl" role="dialog" aria-modal="true" aria-labelledby="daypnl-title">
        <button className="modal-x" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h2 id="daypnl-title">Pack P&amp;L by day</h2>
        <p className="dim daypnl-sub">
          UTC days · last minus first snapshot per bee, summed ·{" "}
          <span className={total >= 0 ? "good" : "bad"}>{money1(total)} over {rows.length}d</span>
        </p>
        {rows.length === 0 ? (
          <p className="dim">No equity history in view yet.</p>
        ) : (
          <div className="daypnl-bars">
            {rows.map((r) => (
              <div className="daypnl-col" key={r.key} title={`${r.key}: ${money1(r.pnl)}${r.today ? " (today, so far)" : ""}`}>
                <div className={`daypnl-val num ${r.pnl >= 0 ? "good" : "bad"}`}>{money1(r.pnl)}</div>
                <div className="daypnl-track">
                  <div className={`daypnl-bar ${r.pnl >= 0 ? "up" : "down"}`} style={{ height: `${Math.max(3, (Math.abs(r.pnl) / max) * 100)}%` }} />
                </div>
                <div className="daypnl-day num">
                  {dayLabel(r.key)}
                  {r.today && <span className="daypnl-today"> · today</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
