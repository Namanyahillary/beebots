import { useEffect, useState } from "react";
import { EquityChart } from "./EquityChart";
import { Help } from "./Help";
import { FillRow } from "./Fills";
import { TradeModal } from "./TradeModal";
import { BEE_META, type BeeName, type DecisionEvent, type FillEvent, type PublicBee } from "./types";
import type { Curve, FeedState } from "./useFeed";

const CAP_LABEL: Record<string, string> = { trade_cap: "BENCHED", fee_budget: "BENCHED", loss_stop: "SENT HOME", retired: "RETIRED" };

export const money = (x: number, d = 2) => `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
export const signed = (x: number, d = 2) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const px = (x: number | null | undefined) =>
  x === null || x === undefined ? "–" : x >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 1 }) : x >= 1 ? x.toFixed(3) : x.toPrecision(4);

function Delta({ usd, pct }: { usd: number; pct?: number }) {
  const up = usd >= 0;
  return (
    <span className={up ? "good" : "bad"}>
      {up ? "▲" : "▼"} {signed(usd)}
      {pct !== undefined && <span className="dim"> ({up ? "+" : "−"}{Math.abs(pct).toFixed(2)}%)</span>}
    </span>
  );
}

function Meter({ label, value, max, text, title }: { label: string; value: number; max: number; text: string; title?: string }) {
  const frac = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  return (
    <div className="meter" title={title}>
      <div className="meter-head">
        <span>{label}</span>
        <span className="num">{text}</span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${frac >= 1 ? "full" : frac >= 0.75 ? "warn" : ""}`} style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  );
}

export function ProbBars({ top3, choice, color, big }: { top3: Array<[string, number]>; choice: string | null; color: string; big?: boolean }) {
  return (
    <div className={`probs ${big ? "big" : ""}`}>
      {top3.map(([label, p]) => (
        <div className={`prob ${label === choice ? "chosen" : ""}`} key={label}>
          <span className="prob-label">{label}</span>
          <span className="prob-track">
            <span className="prob-fill" style={{ width: `${Math.max(2, p * 100)}%`, background: label === choice ? color : "var(--muted-bar)" }} />
          </span>
          <span className="prob-p num">{Math.round(p * 100)}%</span>
        </div>
      ))}
    </div>
  );
}

interface Props {
  name: BeeName;
  bee: PublicBee | undefined;
  curve: Curve | undefined;
  baseline: number;
  rank: number;
  gap: number | null;
  flash: FeedState["flashes"][BeeName];
  fills?: FillEvent[];
  decisions?: DecisionEvent[];
}

const STYLE_LABEL: Record<string, string> = { bizzy: "Breakout", breezy: "Trend", boozy: "Momentum", scalpy: "Scalp", fade: "Fade" };
const DEFAULT_STYLE: Record<BeeName, string> = { bee1: "bizzy", bee2: "breezy", bee3: "boozy", bee4: "scalpy", bee5: "scalpy", bee6: "fade" };

/** A trigger chip that explains itself: tap for the full rule, status, and where to watch it. */
function TriggerBadge({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open ]);
  return (
    <>
      <button type="button" className="trigger-badge" onClick={() => setOpen(true)} title="What is Stinger?">
        {label}
      </button>
      {open && (
        <div className="modal-back" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="stinger-title">
            <button className="modal-x" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
            <h2 id="stinger-title">Stinger entry trigger</h2>
            <div className="help-body">
              <p>Stinger is Grim second entry trigger, alongside the default Williams breakout.</p>
              <dl>
                <dt>Rule</dt>
                <dd>Long only when price sits above the previous day high with rising volume.</dd>
                <dt>Volume bar</dt>
                <dd>Volume z-score at 1.0 or more. A starting guess, retuned from fills.</dd>
                <dt>Williams differs</dt>
                <dd>Williams fires at today open plus half of yesterday range. Either can trigger first on a fast morning.</dd>
                <dt>Challenger</dt>
                <dd>Stinger was copied from a leading Hive bee. It runs beside Williams, never instead of it. The menu labels keep them apart.</dd>
                <dt>Scoreboard</dt>
                <dd>Every fill records which trigger fired. Open the Setups panel to see offered versus picked counts per trigger.</dd>
              </dl>
              <p>No trigger fired yet means a quiet market, not a broken one.</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function EngineHelp({ styleId }: { styleId: string }) {  if (styleId === "breezy")
    return (
      <Help title="Engine: Trend">
        <p>This badge names the strategy this slot runs.</p>
        <dl>
          <dt>Universe</dt>
          <dd>It follows trends on BTC and ETH with a 9 slice Donchian ensemble on 4 hour bars.</dd>
          <dt>Presence</dt>
          <dd>It describes capability so it always shows even before any data arrives.</dd>
          <dt>Breakeven</dt>
          <dd>At +1R the stop moves to breakeven past fees by 0.1R.</dd>
          <dt>Trims</dt>
          <dd>At +2R it trims half and a score decay of 3 also trims half.</dd>
        </dl>
        <p>Watch this when you compare what each slot is built to do.</p>
      </Help>
    );
  if (styleId === "boozy")
    return (
      <Help title="Engine: Momentum">
        <p>This badge names the strategy this slot runs.</p>
        <dl>
          <dt>Universe</dt>
          <dd>It rotates into the week hottest coin and pyramids winners up to 2x.</dd>
          <dt>Presence</dt>
          <dd>It describes capability so it always shows even before any data arrives.</dd>
          <dt>Breakeven</dt>
          <dd>At +1R the stop moves to breakeven past fees by 0.1R with no trim.</dd>
          <dt>Rotation</dt>
          <dd>Rotation unlocks after 24 hours behind a 3x ATR trail on 1 hour bars.</dd>
        </dl>
        <p>Watch this when you compare what each slot is built to do.</p>
      </Help>
    );
  if (styleId === "scalpy")
    return (
      <Help title="Engine: Scalp">
        <p>This badge names the strategy this slot runs.</p>
        <dl>
          <dt>Universe</dt>
          <dd>It fishes the 15-60 minute micro-breakout on every liquid coin: through the 20-bar 15m high on 1.2x median volume.</dd>
          <dt>Rule-driven</dt>
          <dd>Jev is never asked — a 1-3s reasoning call is a lifetime at this timescale. The code takes the setup when it triggers.</dd>
          <dt>Exits</dt>
          <dd>Trim half at +0.4R, close the rest at +0.8R (a full run banks 0.6R — $3 on $5 risk), breakeven at +0.3R, and a 45-minute time stop shoots overstayers.</dd>
          <dt>Gate</dt>
          <dd>At 30 resolved scalps the book judges it: expectancy above zero net of fees keeps it, otherwise it is killed. No extensions.</dd>
        </dl>
        <p>Watch this when you compare what each slot is built to do.</p>
      </Help>
    );
  if (styleId === "fade")
    return (
      <Help title="Engine: Fade">
        <p>This badge names the strategy this slot runs.</p>
        <dl>
          <dt>Universe</dt>
          <dd>It fades crowded positioning on every liquid coin: funding z-score at ±2 with a ±8% 24-hour move behind it.</dd>
          <dt>Two-sided</dt>
          <dd>Shorts crowded longs into extended rallies, longs washed-out shorts. The only contrarian in the pack.</dd>
          <dt>Exits</dt>
          <dd>Wide 2x ATR stops because crowds overshoot, trim half at +1R, close the rest at +2R, breakeven at +0.75R, dead at 6 hours.</dd>
          <dt>Gate</dt>
          <dd>At 20 resolved fades the book judges it: expectancy above zero net of fees keeps it, otherwise it is killed. No extensions.</dd>
        </dl>
        <p>Watch this when you compare what each slot is built to do.</p>
      </Help>
    );
  return (
    <Help title="Engine: Breakout">
      <p>This badge names the strategy this slot runs.</p>
      <dl>
        <dt>Universe</dt>
        <dd>It takes one volatility breakout a day on BTC, ETH, SOL or HYPE.</dd>
        <dt>Two triggers</dt>
        <dd>Williams is the default entry at today open plus half of yesterday range. Stinger is the challenger at the previous day high on rising volume. Fills record which one fired.</dd>
        <dt>Presence</dt>
        <dd>It describes capability so it always shows even before any data arrives.</dd>
        <dt>Breakeven</dt>
        <dd>At +1R the stop moves to breakeven past fees by 0.1R with no trim.</dd>
        <dt>Close</dt>
        <dd>The position rides to the UTC day close.</dd>
      </dl>
      <p>Watch this when you compare what each slot is built to do.</p>
    </Help>
  );
}

export function BeeColumn({ name, bee, curve, baseline, rank, gap, flash, fills, decisions }: Props) {
  const meta = BEE_META[name];
  const p = bee?.position ?? null;
  const flashing = flash && Date.now() - flash.at < 2500;
  const cap = bee?.cap ?? null;
  const styleId = bee?.style ?? DEFAULT_STYLE[name]!;
  const styleLabel = STYLE_LABEL[styleId] ?? meta.styleLabel;
  const [showFills, setShowFills] = useState(false);
  const [sel, setSel] = useState<FillEvent | null>(null);
  const beeFills = (fills ?? []).filter((f) => f.bee === name);
  // Structured idle state for a flat waiting bee (bizzy and scalpy): drives
  // the proximity bar. Absent = today's flat line exactly, no layout shift.
  const idle = !p ? (bee?.last?.idle ?? null) : null;

  useEffect(() => {
    if (!showFills || sel) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setShowFills(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showFills, sel]);

  return (
    <section className={`bee ${flashing ? `flash-${flash.kind}` : ""}`} style={{ ["--bee" as string]: meta.color, ["--bee-glow" as string]: meta.glow }}>
      <header className="bee-head">
        <div className="portrait">
          <img src={meta.img} alt={`${meta.short} portrait`} />
        </div>
        <div className="bee-id">
          <div className="bee-name">{meta.short}</div>
          <div className="bee-tag">
            {meta.tagline || meta.styleLabel}
            {meta.coins.length > 0 && <span className="bee-coins"> · {meta.coins.join(" ")}</span>}
            {meta.tagline && <span className="bee-style"> · {meta.styleLabel}</span>}
          </div>
          <div className="engine-badges">
            <span className="engine-badge">{styleLabel}</span>
            {(bee?.triggers ?? (styleId === "bizzy" ? ["Williams breakout", "Stinger"] : []))
              .filter((t) => {
                // Skip the trigger that merely restates the engine family
                // ("Williams breakout" vs family "Breakout") — it renders twice.
                const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
                const fam = norm(styleLabel);
                const trg = norm(t);
                return fam.length > 0 && trg.length > 0 && !trg.includes(fam) && !fam.includes(trg);
              })
              .map((t) => (
                <TriggerBadge key={t} label={t.replace(/^Williams breakout$/i, "Williams")} />
              ))}
            <EngineHelp styleId={styleId} />
          </div>
          {meta.rules && (
            <div className="bee-rules" title={meta.rules}>
              {meta.rules}
            </div>
          )}
        </div>
        <div className="rank">
          <div className="rank-n">#{rank}</div>
          {gap !== null && <div className="rank-gap num">{gap === 0 ? "leading" : `${money(gap)} behind`}</div>}
        </div>
      </header>

      <div className="equity">
        <div className="equity-value num">{bee ? money(bee.equityUsd) : "–"}</div>
        {bee && <Delta usd={bee.pnlUsd} pct={bee.pnlPct} />}
      </div>

      {/* In the flow, never over the equity figure. */}
      {cap && (
        <div className="cap-banner" role="status">
          <div className="cap-title">{CAP_LABEL[cap]}</div>
          <div className="cap-detail">{bee?.last?.status}</div>
        </div>
      )}
      <div className={`position ${p ? p.side : "flat"}`}>
        {p ? (
          <>
            <div className="pos-main">
              <span className={`side ${p.side}`}>{p.side === "long" ? "▲ LONG" : "▼ SHORT"}</span>
              <span className="pos-coin">{p.coin}</span>
              <span className="pos-size num">{p.sizeUsd !== null ? money(p.sizeUsd, 0) : ""}</span>
            </div>
            <div className="pos-upl num">
              <Delta usd={p.uplUsd} />
              <span className="dim"> unrealised · {p.minutesHeld}m held</span>
            </div>
            <div className="pos-px num dim">
              entry {px(p.entryPx)} → mark {px(p.markPx)} · stop {px(p.stopPx)}
            </div>
          </>
        ) : (
          <>
            <div className="pos-main">
              <span className="side flat">FLAT</span>
              <span className="dim">{bee?.flatMinutes ?? 0}m in cash</span>
            </div>
            {idle && (
              <div className="idle-prox">
                <div className="idle-prox-head">
                  <span>{idle.label}</span>
                  {idle.coin && idle.pctAway != null && (
                    <span className="num">
                      {idle.coin} {idle.midPx != null ? `${px(idle.midPx)} · ` : ""}{idle.pctAway.toFixed(2)}% away
                    </span>
                  )}
                </div>
                {idle.pctAway != null && (
                  <div className="meter-track">
                    {/* Proximity scale: full at the trigger (0% away), draining to the floor at >=4% away. */}
                    <div className="meter-fill" style={{ width: `${Math.max(3, Math.min(100, 100 - idle.pctAway * 25))}%` }} />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <EquityChart curve={curve ?? []} color={meta.color} baseline={baseline} gradientId={`g-${meta.short}`} />

      <div className="last">
        <div className="last-head">
          <span className="eyebrow">Jev’s last call</span>
          {bee?.last?.latencyMs != null && <span className="dim num">{bee.last.latencyMs} ms</span>}
        </div>
        {cap === "trade_cap" || cap === "fee_budget" ? (
          <div className="dim">sitting out while benched: nothing Jev picks could be acted on until 00:00 UTC</div>
        ) : bee?.last?.top3.length ? (
          <ProbBars top3={bee.last.top3} choice={bee.last.choice} color={meta.color} big />
        ) : bee?.last?.choice != null && (bee?.last?.status ?? "").includes("Jev not asked") ? (
          <div className="dim">{bee.last.choice} — held by rule, Jev not asked</div>
        ) : (
          <div className="dim">waiting…</div>
        )}
        <div className="status">{bee?.last?.status ?? ""}</div>
      </div>

      <div className="meters">
        <button type="button" className="trades-btn" onClick={() => { setSel(null); setShowFills(true); }} title={`${meta.short} fills`}>
          <Meter label="Entries today" value={bee?.tradesToday ?? 0} max={bee?.maxTradesPerDay ?? 1} text={`${bee?.tradesToday ?? 0} / ${bee?.maxTradesPerDay ?? "–"}`} title="Entries opened today (not closed trades)" />
        </button>
        <Meter label="Fee budget" value={bee?.feesTodayUsd ?? 0} max={bee?.feeBudgetUsd ?? 1} text={`${money(bee?.feesTodayUsd ?? 0)} / ${money(bee?.feeBudgetUsd ?? 0)}`} />
      </div>

      <div className="costs num">
        <div title="Closed-trade P&L so far (stops, takes, trims). Excludes the open position, fees, funding and Jev spend.">
          <span className="eyebrow">realised</span>
          {signed(bee?.totals.realisedUsd ?? 0)}
        </div>
        <div>
          <span className="eyebrow">fees</span>
          {money(bee?.totals.feesUsd ?? 0)}
        </div>
        <div>
          <span className="eyebrow">funding</span>
          {signed(bee?.totals.fundingUsd ?? 0)}
        </div>
        <div>
          <span className="eyebrow">Jev</span>
          {money(bee?.totals.jevUsd ?? 0, 4)}
        </div>
        <div>
          <span className="eyebrow">calls</span>
          {(bee?.totals.decisions ?? 0).toLocaleString()}
        </div>
      </div>

      {flashing && flash.kind === "funding" && <div className="funding-chip num">{flash.text}</div>}

      {showFills && !sel && (
        <div className="modal-back" onClick={(e) => e.target === e.currentTarget && setShowFills(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby={`fills-${name}`}>
            <button className="modal-x" onClick={() => setShowFills(false)} aria-label="Close">
              ×
            </button>
            <h2 id={`fills-${name}`}>{meta.short} fills</h2>
            {beeFills.length > 0 ? (
              <div className="fills-list bee-fills-list">
                {beeFills.map((f) => (
                  <FillRow
                    key={`${f.ts}-${f.bee}-${f.coin}-${f.contracts}-${f.px}`}
                    fill={f}
                    hideBee
                    onOpen={() => setSel(f)}
                  />
                ))}
              </div>
            ) : (
              <p className="dim">no fills yet — flat/waiting</p>
            )}
          </div>
        </div>
      )}
      {sel && <TradeModal fill={sel} decisions={decisions ?? []} onClose={() => setSel(null)} />}
    </section>
  );
}
