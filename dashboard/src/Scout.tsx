import { memo } from "react";
import { useCollapsed } from "./collapse";
import { Help } from "./Help";
import type { ScoutEligibleEntry, ScoutSnapshot } from "./types";

const coinOf = (instId: string) => instId.split("-")[0];

/** instId of an eligible entry, whether legacy plain string or enriched object. */
export function scoutEligibleId(e: string | ScoutEligibleEntry): string {
  return typeof e === "string" ? e : e.instId;
}

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
  const [collapsed, collapseBtn] = useCollapsed("scout");
  if (!scout) {
    return (
      <section className={`rail-card scout${collapsed ? " collapsed" : ""}`}>
        <div className="rail-head">
          <span className="eyebrow">
            Scout <Help title="Scout">
            <p>Scout records which coins passed the screens.</p>
            <dl>
              <dt>Eligible</dt>
              <dd>These coins cleared spread gate, volume minimum, funding check and return rank and sort by 24 hour USD volume.</dd>
              <dt>Excluded</dt>
              <dd>These coins failed at least one screen and keep the reason beside them with only the top 10 by volume.</dd>
              <dt>Age</dt>
              <dd>The age marks when the snapshot was stored and a new row appears only when the eligible set changes.</dd>
              <dt>Trading</dt>
              <dd>Scout never gates trading and each wolf still trades its own universe.</dd>
            </dl>
            <p>Watch age because a coin seen 30 minutes ago may be gone.</p>
          </Help>
          </span>
          <span className="num dim">no snapshot yet</span>
          {collapseBtn}
        </div>
      </section>
    );
  }
  return (
    <section className={`rail-card scout${collapsed ? " collapsed" : ""}`}>
      <div className="rail-head">
        <span className="eyebrow">
          Scout <Help title="Scout">
            <p>Scout records which coins passed the screens.</p>
            <dl>
              <dt>Eligible</dt>
              <dd>These coins cleared spread gate, volume minimum, funding check and return rank and sort by 24 hour USD volume.</dd>
              <dt>Excluded</dt>
              <dd>These coins failed at least one screen and keep the reason beside them with only the top 10 by volume.</dd>
              <dt>Age</dt>
              <dd>The age marks when the snapshot was stored and a new row appears only when the eligible set changes.</dd>
              <dt>Trading</dt>
              <dd>Scout never gates trading and each wolf still trades its own universe.</dd>
            </dl>
            <p>Watch age because a coin seen 30 minutes ago may be gone.</p>
          </Help>
        </span>
        <span className="num dim">{scoutAge(scout.ts, Date.now())}</span>
        {collapseBtn}
      </div>
      {!collapsed && (
      <>
      {scout.eligible.length > 0 ? (
        <div className="blocked-list num">
          {scout.eligible.map((e) => {
            const id = scoutEligibleId(e);
            return <span key={id}>{coinOf(id)}</span>;
          })}
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
      </>
      )}
    </section>
  );
}
