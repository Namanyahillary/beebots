import { useEffect } from "react";
import { BEE_META, type DecisionEvent, type FillEvent } from "./types";

const LINK_WINDOW_MS = 60_000;

function linkDecision(fill: FillEvent, decisions: DecisionEvent[]): { d: DecisionEvent | null; byId: boolean } {
  if (fill.decisionId != null) {
    const exact = decisions.find((d) => d.decisionId === fill.decisionId);
    if (exact) return { d: exact, byId: true };
  }
  let best: DecisionEvent | null = null;
  for (const d of decisions) {
    if (d.bee !== fill.bee) continue;
    if (Math.abs(d.ts - fill.ts) > LINK_WINDOW_MS) continue;
    if (!best || Math.abs(d.ts - fill.ts) < Math.abs(best.ts - fill.ts)) best = d;
  }
  return { d: best, byId: false };
}

const money2 = (x: number) => `$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A fill plus the decision behind it: exact match on decisionId, else the nearest same-bee decision within 60s. */
export function TradeModal({ fill, decisions, leverage, onClose }: { fill: FillEvent; decisions: DecisionEvent[]; leverage?: { max: number; mode: string }; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { d, byId } = linkDecision(fill, decisions);
  const meta = BEE_META[fill.bee];
  const net = fill.realisedUsd - fill.feeUsd;
  const closing = fill.purpose !== "open" && fill.purpose !== "add";

  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal trade" role="dialog" aria-modal="true" aria-labelledby="trade-title">
        <button className="modal-x" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h2 id="trade-title">
          {meta.short} {fill.side === "buy" ? "bought" : "sold"} {fill.coin}
        </h2>
        <dl className="trade-grid num">
          <dt>side</dt>
          <dd>{fill.side}</dd>
          <dt>contracts</dt>
          <dd>{fill.contracts}</dd>
          <dt>price</dt>
          <dd>{fill.px}</dd>
          <dt>notional</dt>
          <dd>{money2(fill.notionalUsd)}</dd>
          <dt>fee</dt>
          <dd>{money2(fill.feeUsd)}</dd>
          {closing && (
            <>
              <dt>p&amp;l</dt>
              <dd className={net >= 0 ? "good" : "bad"}>
                {net >= 0 ? "+" : "−"}
                {money2(net).slice(1)}
              </dd>
            </>
          )}
          <dt>purpose</dt>
          <dd>{fill.purpose}</dd>
          <dt>leverage</dt>
          <dd>{leverage ? `${leverage.max}x ${leverage.mode} (account setting, every trade)` : "–"}</dd>
          <dt>time</dt>
          <dd>{new Date(fill.ts).toLocaleString()}</dd>
        </dl>

        <div className="rail-head trade-sub">
          <span className="eyebrow">The decision behind it</span>
          <span className="num dim">{d ? (byId ? "linked by id" : "nearest ≤60s") : "none in view"}</span>
        </div>
        {d ? (
          <dl className="trade-grid num">
            <dt>choice</dt>
            <dd className="trade-choice">{d.choice ?? "no call"}</dd>
            <dt>conviction</dt>
            <dd>{d.conviction ?? "–"}</dd>
            <dt>top 3</dt>
            <dd>{d.probabilities.length > 0 ? d.probabilities.map((p) => `${p.label} ${Math.round(p.p * 100)}%`).join(" · ") : "–"}</dd>
            <dt>vetoed by</dt>
            <dd>{d.vetoedBy ?? "–"}</dd>
            <dt>forced by</dt>
            <dd>{d.forcedBy ?? "–"}</dd>
            <dt>status</dt>
            <dd>{d.status}</dd>
            <dt>cached</dt>
            <dd>{d.cached ? "yes" : "no"}</dd>
          </dl>
        ) : (
          <p className="dim">No decision for {meta.short} within 60s of this fill is in the current view.</p>
        )}
      </div>
    </div>
  );
}
