import { memo, useState } from "react";
import { useCollapsed } from "./collapse";
import { Help } from "./Help";
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
export function Fills({ fills, decisions, leverage }: { fills: FillEvent[]; decisions: DecisionEvent[]; leverage?: { max: number; mode: string } }) {
  const [sel, setSel] = useState<FillEvent | null>(null);
  const [collapsed, collapseBtn] = useCollapsed("fills");
  const rows = fills ?? [];
  const history = decisions ?? [];
  return (
    <section className={`rail-card fills${collapsed ? " collapsed" : ""}`}>
      <div className="rail-head">
        <span className="eyebrow">
          Fills <Help title="Fills">
            <p>Recent fills show newest first.</p>
            <dl>
              <dt>Trade view</dt>
              <dd>Each row opens the fill price, size, fee and profit and loss with the decision behind it.</dd>
              <dt>Linked decision</dt>
              <dd>The panel links by id when it can and otherwise uses the nearest same wolf decision within 60 seconds.</dd>
              <dt>Empty match</dt>
              <dd>A fill with nothing nearby in view shows none in view.</dd>
            </dl>
            <p>Watch this when you want to see why a trade happened.</p>
          </Help>
        </span>
        <span className="num dim">{rows.length > 0 ? `${rows.length} recent` : "none yet"}</span>
        {collapseBtn}
      </div>
      {!collapsed && (
      <>
      {rows.length > 0 ? (
        <div className="fills-list">
          {rows.map((f) => (
            <FillRow key={`${f.ts}-${f.bee}-${f.coin}-${f.contracts}-${f.px}`} fill={f} onOpen={() => setSel(f)} />
          ))}
        </div>
      ) : (
        <div className="dim">no fills yet</div>
      )}
      </>
      )}
      {sel && <TradeModal fill={sel} decisions={history} leverage={leverage} onClose={() => setSel(null)} />}
    </section>
  );
}
