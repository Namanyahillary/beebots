import { memo, useEffect, useMemo, useState } from "react";
import { useCollapsed } from "./collapse";
import { Help } from "./Help";
import { scoutAge } from "./Scout";
import type { DecisionEvent } from "./types";

const TRIGGER = /^(STINGER|BREAKOUT|SCALP|FADE|BOUNCE|PULLBACK)_/;
const WINDOW = 50;

interface SetupRow {
  label: string;
  offered: number;
  picked: number;
  lastSeen: number;
}

/**
 * Trigger scoreboard: seeded from GET /setups (last 200 trigger-bearing
 * decisions, all time) and extended with live ticks newer than the seed, so a
 * rare trigger stays visible instead of aging out of a 90-second live window.
 */
export const Setups = memo(function Setups({ decisions }: { decisions: DecisionEvent[] }) {
  const [seed, setSeed] = useState<SetupRow[]>([]);
  useEffect(() => {
    let alive = true;
    fetch("/setups", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .then((j) => alive && Array.isArray(j) && setSeed(j))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const { rows, waits, holds, n } = useMemo(() => {
    const byLabel = new Map<string, SetupRow>();
    for (const r of seed) byLabel.set(r.label, { ...r });
    const seedMax = seed.reduce((a, r) => Math.max(a, r.lastSeen), 0);
    const view = (decisions ?? []).slice(0, WINDOW);
    let waits = 0;
    let holds = 0;
    for (const d of view) {
      if (d.choice === "WAIT") waits++;
      if (d.choice === "HOLD") holds++;
      if (d.ts <= seedMax) continue; // already counted in the seed
      for (const label of d.menu ?? []) {
        if (!TRIGGER.test(label)) continue;
        const row = byLabel.get(label) ?? { label, offered: 0, picked: 0, lastSeen: 0 };
        row.offered++;
        if (d.choice === label) row.picked++;
        row.lastSeen = Math.max(row.lastSeen, d.ts);
        byLabel.set(label, row);
      }
    }
    return { rows: [...byLabel.values()].sort((a, b) => b.lastSeen - a.lastSeen), waits, holds, n: view.length };
  }, [decisions, seed]);

  const now = Date.now();
  const [collapsed, collapseBtn] = useCollapsed("setups");
  return (
    <section className={`rail-card setups${collapsed ? " collapsed" : ""}`}>
      <div className="rail-head">
        <span className="eyebrow">
          Setups <Help title="Setups">
            <p>Setups shows entry triggers offered across recent history: Breakout and Stinger for Grim, micro-breakouts for Dash and Zip, fades for Rook.</p>
            <dl>
              <dt>Record</dt>
              <dd>Each row counts how often a trigger was offered and picked, seeded from the last 200 trigger-bearing decisions and extended live, with its last seen age.</dd>
              <dt>Breakout</dt>
              <dd>This Williams trigger fires at today open plus half of yesterday range as a strict long open.</dd>
              <dt>Stinger</dt>
              <dd>This challenger fires above the prior day high on rising volume with volZ at 1.0 or more as a strict long open.</dd>
              <dt>Scalp</dt>
              <dd>Dash and Zip take 15-minute micro-breakouts; _XHT marks an exhausted-thrust entry (attribution only).</dd>
              <dt>Fade</dt>
              <dd>Rook fades crowded funding: FADE_SHORT into overcrowded longs, FADE_LONG into washed-out shorts.</dd>
              <dt>Flat picks</dt>
              <dd>Wait marks flat and waiting ticks and hold marks keep the position ticks.</dd>
              <dt>Quiet panel</dt>
              <dd>An empty panel means no triggers were offered, not that anything is broken.</dd>
            </dl>
            <p>Watch fill labels to see which trigger earned.</p>
          </Help>
        </span>
        <span className="num dim">last {n} live</span>
        {collapseBtn}
      </div>
      {!collapsed && (
      <>
      {rows.length > 0 ? (
        <div className="setups-list num">
          {rows.map((r) => (
            <div className="setups-row" key={r.label} title={`offered ${r.offered}× · picked ${r.picked}×`}>
              <span className="setups-label">{r.label}</span>
              <span className="dim">
                {r.picked}/{r.offered}
              </span>
              <span className="dim">{scoutAge(r.lastSeen, now)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="dim">no entry triggers in view</div>
      )}
      <div className="setups-context num dim">
        WAIT ×{waits} · HOLD ×{holds}
      </div>
      </>
      )}
    </section>
  );
});
