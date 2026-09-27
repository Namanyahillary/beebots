import { memo, useState } from "react";
import { useCollapsed } from "./collapse";
import { Help } from "./Help";
import { scoutAge } from "./Scout";
import { TradeModal } from "./TradeModal";
import { BEE_META, type DecisionEvent, type FillEvent } from "./types";

const money = (x: number, d = 2) => `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const signed = (x: number, d = 2) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;

export const FillRow = memo(function FillRow({
  fill,
  hideBee = false,
  onOpen,
}: {
  fill: FillEvent;
  hideBee?: boolean;
  onOpen: () => void;
}) {
  const meta = BEE_META[fill.bee];
  const closing = (fill.purpose !== "open" && fill.purpose !== "add") || fill.realisedUsd !== 0;
  const net = fill.realisedUsd - fill.feeUsd;

  return (
    <button
      type="button"
      className={`fill-row${hideBee ? " no-bee" : ""}`}
      style={{ ["--bee" as string]: meta.color }}
      onClick={onOpen}
      title={`${meta.short} ${fill.side.toUpperCase()} ${fill.coin} · ${fill.purpose} · ${fill.contracts} contracts @ $${fill.px} · Fee: ${money(fill.feeUsd)}`}
    >
      {!hideBee && <span className="fill-bee">{meta.short}</span>}
      <span className={`fill-side ${fill.side}`}>{fill.side.toUpperCase()}</span>
      <span className="fill-coin">{fill.coin}</span>
      <span className="fill-purpose dim">{fill.purpose}</span>
      <span className={`fill-pnl num ${closing ? (net >= 0 ? "good" : "bad") : "dim"}`}>
        {closing ? signed(net) : money(fill.notionalUsd, 0)}
      </span>
      <span className="fill-time dim num">{scoutAge(fill.ts, Date.now())}</span>
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
