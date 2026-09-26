import { memo } from "react";
import type { ScoutSnapshot } from "./types";

const coinOf = (instId: string) => instId.split("-")[0];

/** Snapshot age: staleness IS the point — an opportunity seen 30m ago may be gone. */
export function scoutAge(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const ExcludedRow = memo(function ExcludedRow({ instId, reasons }: { instId: string; reasons: string[] }) {
  return (
    <div className="scout-excluded">
      <span className="scout-coin">{coinOf(instId)}</span>
      <span className="dim">{reasons.join(" · ")}</span>
    </div>
  );
});

export function Scout({ scout }: { scout: ScoutSnapshot | null | undefined }) {
  if (!scout) {
    return (
      <section className="rail-card scout">
        <div className="rail-head">
          <span className="eyebrow">Scout</span>
          <span className="num dim">no snapshot yet</span>
        </div>
      </section>
    );
  }
  return (
    <section className="rail-card scout">
      <div className="rail-head">
        <span className="eyebrow">Scout</span>
        <span className="num dim">{scoutAge(scout.ts, Date.now())}</span>
      </div>
      {scout.eligible.length > 0 ? (
        <div className="blocked-list num">
          {scout.eligible.map((id) => (
            <span key={id}>{coinOf(id)}</span>
          ))}
        </div>
      ) : (
        <div className="dim">nothing passing the screen</div>
      )}
      {scout.excluded.length > 0 && (
        <div className="scout-excluded-list">
          {scout.excluded.map((e) => (
            <ExcludedRow key={e.instId} instId={e.instId} reasons={e.reasons} />
          ))}
        </div>
      )}
    </section>
  );
}
