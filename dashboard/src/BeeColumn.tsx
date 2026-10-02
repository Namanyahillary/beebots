import { useEffect, useState, type ReactNode } from "react";
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

const STYLE_LABEL: Record<string, string> = { bizzy: "Breakout", breezy: "Trend", boozy: "Momentum", scalpy: "Scalp", fade: "Fade", bounce: "Revert", pullback: "Pullback" };
const DEFAULT_STYLE: Record<BeeName, string> = { bee1: "bizzy", bee2: "breezy", bee3: "boozy", bee4: "pullback", bee5: "scalpy", bee6: "fade", bee7: "bounce" };

/** Per-trigger explainers: the chip tapped decides the content (used to be hardcoded Stinger for every chip). */
const TRIGGER_INFO: Record<string, { title: string; head: string; body: ReactNode }> = {
  stinger: {
    title: "What is Stinger?",
    head: "Stinger entry trigger",
    body: (
      <>
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
      </>
    ),
  },
  williams: {
    title: "What is Williams?",
    head: "Williams entry trigger",
    body: (
      <>
        <p>Williams is Grim default entry trigger: the Larry Williams volatility breakout.</p>
        <dl>
          <dt>Rule</dt>
          <dd>Long only when price breaks above today open plus half of yesterday range.</dd>
          <dt>One shot</dt>
          <dd>One trade a day, ridden to the UTC day close. A trigger more than 20bp past its line is a missed breakout, never chased.</dd>
          <dt>Stinger differs</dt>
          <dd>Stinger is the challenger at the previous day high on rising volume. Fills record which one fired.</dd>
        </dl>
        <p>No trigger fired yet means a quiet market, not a broken one.</p>
      </>
    ),
  },
  microbreakout: {
    title: "What is the micro-breakout?",
    head: "Micro-breakout entry trigger",
    body: (
      <>
        <p>The micro-breakout is how Dash and Zip catch the 15-60 minute wiggle on every liquid coin.</p>
        <dl>
          <dt>Rule</dt>
          <dd>Long only when price breaks above its 20-bar 15-minute high on 1.2x median volume, inside a 30bp chase guard.</dd>
          <dt>Two wolves</dt>
          <dd>Dash and Zip split setups by rotating first pick hourly, so they never mirror. One setup means whoever holds first pick takes it.</dd>
          <dt>Wick tag</dt>
          <dd>Entries label fresh (<span className="num">SCALP_XRP</span>) versus exhausted thrust (<span className="num">SCALP_XRP_XHT</span>) when the forming bar spiked and sagged. Attribution only — the code takes either one.</dd>
          <dt>Scoreboard</dt>
          <dd>Every fill records its trigger. Open the Setups panel to see offered versus picked counts, and the 30-scalp gate judges the playbook.</dd>
        </dl>
        <p>No trigger fired yet means a quiet market, not a broken one.</p>
      </>
    ),
  },
  crowdedlong: {
    title: "What is crowded-long?",
    head: "Crowded-long fade trigger",
    body: (
      <>
        <p>Crowded-long is Rook short trigger: fading overcrowded longs.</p>
        <dl>
          <dt>Rule</dt>
          <dd>Short only when the funding z-score hits +2 or more into a +8% 24-hour rally. The crowd is paying hard and the marginal buyer is in.</dd>
          <dt>Wide stops</dt>
          <dd>Crowds overshoot, so the stop sits at 2x ATR and the fade dies at 6 hours if it becomes a regime instead of an exhaustion.</dd>
          <dt>Rare</dt>
          <dd>Extremes only, a few times a week at most. Flat for days is expected, and the 20-fade gate judges the style.</dd>
        </dl>
        <p>No trigger fired yet means no crowd worth fading, not a broken one.</p>
      </>
    ),
  },
  washedoutshort: {
    title: "What is washed-out-short?",
    head: "Washed-out-short fade trigger",
    body: (
      <>
        <p>Washed-out-short is Rook long trigger: buying capitulation.</p>
        <dl>
          <dt>Rule</dt>
          <dd>Long only when the funding z-score hits -2 or worse into a -8% 24-hour washout. Crowded shorts paying hard into panic.</dd>
          <dt>Wide stops</dt>
          <dd>Capitulation overshoots, so the stop sits at 2x ATR and the fade dies at 6 hours if it becomes a regime instead of an exhaustion.</dd>
          <dt>Rare</dt>
          <dd>Extremes only, a few times a week at most. Flat for days is expected, and the 20-fade gate judges the style.</dd>
        </dl>
        <p>No trigger fired yet means no crowd worth fading, not a broken one.</p>
      </>
    ),
  },
  oversoldbounce: {
    title: "What is oversold-bounce?",
    head: "Oversold-bounce revert trigger",
    body: (
      <>
        <p>Oversold-bounce is Echo long trigger: buying the stretched selloff.</p>
        <dl>
          <dt>Rule</dt>
          <dd>Long only when RSI drops below 30 with price outside the lower Bollinger band — and never into crowded longs (funding z above 1.5 vetoes).</dd>
          <dt>Wide stops</dt>
          <dd>Stretches extend, so the stop sits at 1.5x ATR and the revert dies in 8 hours if it becomes a regime instead of a stretch.</dd>
          <dt>Revival</dt>
          <dd>This was the building's first strategy, retired and promoted back. The 20-revert gate judges it.</dd>
        </dl>
        <p>No trigger fired yet means nothing stretched enough, not a broken one.</p>
      </>
    ),
  },
  overboughtfade: {
    title: "What is overbought-fade?",
    head: "Overbought-fade revert trigger",
    body: (
      <>
        <p>Overbought-fade is Echo short trigger: shorting the stretched rally.</p>
        <dl>
          <dt>Rule</dt>
          <dd>Short only when RSI tops 70 with price above the upper Bollinger band.</dd>
          <dt>Wide stops</dt>
          <dd>Stretches extend, so the stop sits at 1.5x ATR and the revert dies in 8 hours if it becomes a regime instead of a stretch.</dd>
          <dt>Revival</dt>
          <dd>This was the building's first strategy, retired and promoted back. The 20-revert gate judges it.</dd>
        </dl>
        <p>No trigger fired yet means nothing stretched enough, not a broken one.</p>
      </>
    ),
  },
  trenddip: {
    title: "What is trend-dip?",
    head: "Trend-dip pullback trigger",
    body: (
      <>
        <p>Trend-dip is Ash long trigger: buying a mild dip inside an established weekly uptrend.</p>
        <dl>
          <dt>Rule</dt>
          <dd>Long only with a +8% 7-day trend, RSI 30-42, price in the lower band slice (0-0.25), funding not crowded, and no 1h dump behind it.</dd>
          <dt>Wide stops</dt>
          <dd>Trends resume slowly, so the stop sits at 2x ATR (80bp floor) and the pullback dies in 12 hours if it was a reversal instead of a dip.</dd>
          <dt>Gate</dt>
          <dd>The 40-pullback gate judges the style. No extensions.</dd>
        </dl>
        <p>No trigger fired yet means no trend worth dipping into, not a broken one.</p>
      </>
    ),
  },
  trendrallyfade: {
    title: "What is trend-rally-fade?",
    head: "Trend-rally-fade pullback trigger",
    body: (
      <>
        <p>Trend-rally-fade is Ash short trigger: fading a mild rally inside an established weekly downtrend.</p>
        <dl>
          <dt>Rule</dt>
          <dd>Short only with a -8% 7-day trend, RSI 58-70, price in the upper band slice (0.75-1), funding not crowded, and no 1h dump behind it.</dd>
          <dt>Wide stops</dt>
          <dd>Trends resume slowly, so the stop sits at 2x ATR (80bp floor) and the pullback dies in 12 hours if it was a reversal instead of a dip.</dd>
          <dt>Gate</dt>
          <dd>The 40-pullback gate judges the style. No extensions.</dd>
        </dl>
        <p>No trigger fired yet means no trend worth dipping into, not a broken one.</p>
      </>
    ),
  },
};

const triggerKey = (label: string) => label.toLowerCase().replace(/[^a-z]/g, "");

/** A trigger chip that explains itself: tap for the full rule, status, and where to watch it. */
function TriggerBadge({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open ]);
  const info = TRIGGER_INFO[triggerKey(label)] ?? {
    title: `What is ${label}?`,
    head: `${label} entry trigger`,
    body: <p>Entries fire from this trigger when its rule is met. Open the Setups panel to see offered versus picked counts per trigger.</p>,
  };
  return (
    <>
      <button type="button" className="trigger-badge" onClick={() => setOpen(true)} title={info.title}>
        {label}
      </button>
      {open && (
        <div className="modal-back" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="stinger-title">
            <button className="modal-x" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
            <h2 id="stinger-title">{info.head}</h2>
            <div className="help-body">{info.body}</div>
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
  if (styleId === "bounce")
    return (
      <Help title="Engine: Revert">
        <p>This badge names the strategy this slot runs.</p>
        <dl>
          <dt>Universe</dt>
          <dd>It buys stretched selloffs and shorts stretched rallies on every liquid coin: RSI under 30 outside the lower band, or over 70 above the upper band.</dd>
          <dt>Revival</dt>
          <dd>This was the building's first strategy, retired into reference code and promoted back with modern gates: risk-normalized sizing, R-ladder exits, an 8-hour time stop.</dd>
          <dt>Exits</dt>
          <dd>Wide 1.5x ATR stops because stretches extend, trim half at +1R, close the rest at +2R, breakeven at +0.75R, dead in 8 hours.</dd>
          <dt>Gate</dt>
          <dd>At 20 resolved reverts the book judges it: expectancy above zero net of fees keeps it, otherwise it is killed. No extensions.</dd>
        </dl>
        <p>Watch this when you compare what each slot is built to do.</p>
      </Help>
    );
  if (styleId === "pullback")
    return (
      <Help title="Engine: Pullback">
        <p>This badge names the strategy this slot runs.</p>
        <dl>
          <dt>Universe</dt>
          <dd>It buys mild dips inside established weekly trends on every liquid coin: 7-day trend ±8% with RSI 30-42 inside the bands and funding not crowded.</dd>
          <dt>Fee-triangle favorite</dt>
          <dd>2R targets at ~0.05R tolls need only +1.6pp of edge — the most headroom of any style here.</dd>
          <dt>Exits</dt>
          <dd>Wide 2x ATR stops with an 80bp floor, single exit at +2R, breakeven at +1R, dead in 12 hours.</dd>
          <dt>Gate</dt>
          <dd>At 40 resolved pullbacks the book judges it: expectancy above zero and 35%+ wins keeps it, otherwise it is killed. No extensions.</dd>
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
            {meta.mode === "live" && <span className="live-badge" title="This slot trades real money">● LIVE</span>}
            {meta.mode !== "live" && meta.mode !== "dry" && <span className="venue-badge">{meta.mode}</span>}
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
