import { memo, useMemo } from "react";
import { Help } from "./Help";
import { scoutAge } from "./Scout";
import type { DecisionEvent } from "./types";

const TRIGGER = /^(STINGER|BREAKOUT)_/;
const WINDOW = 50;

interface SetupRow {
  label: string;
  offered: number;
  picked: number;
  lastSeen: number;
}

/** Where Stinger is working: trigger labels offered to Jev recently, how often each won, and when each was last seen. */
export const Setups = memo(function Setups({ decisions }: { decisions: DecisionEvent[] }) {
  const { rows, waits, holds, n } = useMemo(() => {
    const view = (decisions ?? []).slice(0, WINDOW);
    const byLabel = new Map<string, SetupRow>();
    let waits = 0;
    let holds = 0;
    for (const d of view) {
      if (d.choice === "WAIT") waits++;
      if (d.choice === "HOLD") holds++;
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
  }, [decisions]);

  const now = Date.now();
  return (
    <section className="rail-card setups">
      <div className="rail-head">
        <span className="eyebrow">
          Setups <Help title="Setups">
            <p>Each row counts one trigger label over the last {WINDOW} decisions: offered means it appeared in Jev&apos;s menu, picked means Jev chose it, with the last-seen age beside it. BREAKOUT_ is the Williams trigger (today&apos;s open plus half of yesterday&apos;s range); STINGER_ is the challenger (above the previous day&apos;s high with rising volume, volZ ≥ 1.0) — both are strict long opens, and fill labels record which one earned.</p>
            <p>WAIT counts flat-and-waiting picks, HOLD counts keep-the-position picks. An empty panel means no triggers were offered in view, not that anything is broken: bizzy only asks Jev when a price is already through its trigger.</p>
          </Help>
        </span>
        <span className="num dim">last {n}</span>
      </div>
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
        <div className="dim">no STINGER/BREAKOUT triggers in view</div>
      )}
      <div className="setups-context num dim">
        WAIT ×{waits} · HOLD ×{holds}
      </div>
    </section>
  );
});
