import { memo } from "react";
import { Help } from "./Help";
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
          <span className="eyebrow">
            Scout <Help title="Scout">Eligible coins passed every screen; excluded coins failed at least one, with the reason shown. The age is when the snapshot was stored. A new row is only written when the eligible set changes, and the panel never gates trading — each brain trades its own universe.</Help>
          </span>
          <span className="num dim">no snapshot yet</span>
        </div>
      </section>
    );
  }
  return (
    <section className="rail-card scout">
      <div className="rail-head">
        <span className="eyebrow">
          Scout <Help title="Scout">
            <p>Eligible coins passed all four screens — spread within the gate, 24h volume above the minimum, funding data present, and a 24h return to rank on — sorted by 24h USD volume. Excluded coins failed at least one screen, with the reason shown (only the top 10 by volume are kept).</p>
            <p>The age shows when this snapshot was stored; a new row is only written when the eligible set changes, so staleness matters — an opportunity seen 30 minutes ago may be gone. The Scout never gates trading: each brain still trades its own universe.</p>
          </Help>
        </span>
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
