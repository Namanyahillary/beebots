import { memo, useState } from "react";
import { scoutAge } from "./Scout";
import { TradeModal } from "./TradeModal";
import { BEE_META, type DecisionEvent, type FillEvent } from "./types";

const FillRow = memo(function FillRow({ fill, onOpen }: { fill: FillEvent; onOpen: () => void }) {
  const meta = BEE_META[fill.bee];
  return (
    <button type="button" className="fill-row" style={{ ["--bee" as string]: meta.color }} onClick={onOpen}>
      <span className="fill-bee">{meta.short}</span>
      <span className="fill-main">
        {fill.side === "buy" ? "▲" : "▼"} {fill.coin} <span className="dim">×{fill.contracts}</span>
      </span>
      <span className="fill-purpose dim">{fill.purpose}</span>
      <span className="dim">{scoutAge(fill.ts, Date.now())}</span>
    </button>
  );
});

/** Recent fills, newest first. Clicking a row opens the trade (fill + linked decision). */
export function Fills({ fills, decisions }: { fills: FillEvent[]; decisions: DecisionEvent[] }) {
  const [sel, setSel] = useState<FillEvent | null>(null);
  return (
    <section className="rail-card fills">
      <div className="rail-head">
        <span className="eyebrow">Fills</span>
        <span className="num dim">{fills.length > 0 ? `${fills.length} recent` : "none yet"}</span>
      </div>
      {fills.length > 0 ? (
        <div className="fills-list">
          {fills.map((f) => (
            <FillRow key={`${f.ts}-${f.bee}-${f.coin}-${f.contracts}-${f.px}`} fill={f} onOpen={() => setSel(f)} />
          ))}
        </div>
      ) : (
        <div className="dim">no fills yet</div>
      )}
      {sel && <TradeModal fill={sel} decisions={decisions} onClose={() => setSel(null)} />}
    </section>
  );
}
