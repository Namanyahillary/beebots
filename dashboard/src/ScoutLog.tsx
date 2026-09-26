// Scout history (read-only log): recent shortlist transitions, newest first.
// Deltas describe changes between snapshots with plain-language narration.
// Screening context only, never a trade recommendation. The scout never gates trading.
import { type ReactNode, useEffect, useState } from "react";
import { useCollapsed } from "./collapse";
import { Help } from "./Help";
import { scoutAge } from "./Scout";
import type { ScoutEligibleEntry, ScoutHistoryRow } from "./types";

export const coinOf = (instId: string): string => instId.split("-")[0]!;

/**
 * Screening-context arrow for one eligible entry:
 * ▲ long-bias when through the trigger (toTriggerPct <= 0) or trend score > 0,
 * ▼ when trend score < 0, · otherwise (neutral / no data).
 */
export function scoutArrow(e: string | ScoutEligibleEntry): "▲" | "▼" | "·" {
  if (typeof e === "string") return "·";
  if (e.toTriggerPct !== null && e.toTriggerPct <= 0) return "▲";
  if (e.trendSign !== null && e.trendSign > 0) return "▲";
  if (e.trendSign !== null && e.trendSign < 0) return "▼";
  return "·";
}

/** "+1.23%" / "-0.42%"; null when absent or non-finite. */
export function formatTriggerPct(pct: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

/** Most frequent excluded reason (the sampled why-not is already volume-ranked). Null when empty. */
export function topExcludedReason(excluded: Array<{ reasons: string[] }>): string | null {
  const counts = new Map<string, number>();
  for (const e of excluded) for (const r of e.reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  let top: string | null = null;
  let topN = 0;
  for (const [r, n] of counts) {
    if (n > topN) {
      top = r;
      topN = n;
    }
  }
  return top;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export interface CoinItem {
  id: string;
  coin: string;
  toTriggerPct: number | null;
  trendSign: -1 | 0 | 1 | null;
  raw: string | ScoutEligibleEntry;
}

export function parseCoinItem(e: string | ScoutEligibleEntry): CoinItem {
  if (typeof e === "string") {
    return { id: e, coin: coinOf(e), toTriggerPct: null, trendSign: null, raw: e };
  }
  return {
    id: e.instId,
    coin: coinOf(e.instId),
    toTriggerPct: e.toTriggerPct,
    trendSign: e.trendSign,
    raw: e,
  };
}

export interface RowDelta {
  entered: CoinItem[];
  dropped: CoinItem[];
  crossedTrigger: CoinItem[];
  movers: CoinItem[];
  unchangedCount: number;
  isBaseline: boolean;
}

export function computeRowDelta(curr: ScoutHistoryRow, prev?: ScoutHistoryRow): RowDelta {
  const currItems = curr.eligible.map(parseCoinItem);
  if (!prev) {
    return {
      entered: currItems,
      dropped: [],
      crossedTrigger: [],
      movers: [],
      unchangedCount: 0,
      isBaseline: true,
    };
  }

  const prevItems = prev.eligible.map(parseCoinItem);
  const prevMap = new Map<string, CoinItem>();
  for (const item of prevItems) {
    prevMap.set(item.coin, item);
  }

  const currMap = new Map<string, CoinItem>();
  for (const item of currItems) {
    currMap.set(item.coin, item);
  }

  const entered: CoinItem[] = [];
  const crossedTrigger: CoinItem[] = [];
  const movers: CoinItem[] = [];
  let unchangedCount = 0;

  for (const currItem of currItems) {
    const prevItem = prevMap.get(currItem.coin);
    if (!prevItem) {
      entered.push(currItem);
    } else {
      const crossed =
        prevItem.toTriggerPct !== null &&
        currItem.toTriggerPct !== null &&
        prevItem.toTriggerPct > 0 &&
        currItem.toTriggerPct <= 0;

      if (crossed) {
        crossedTrigger.push(currItem);
      } else {
        const pctDiff =
          prevItem.toTriggerPct !== null && currItem.toTriggerPct !== null
            ? Math.abs(currItem.toTriggerPct - prevItem.toTriggerPct)
            : 0;
        const trendFlipped =
          prevItem.trendSign !== null &&
          currItem.trendSign !== null &&
          prevItem.trendSign !== currItem.trendSign;

        if (pctDiff >= 1.0 || trendFlipped) {
          movers.push(currItem);
        } else {
          unchangedCount++;
        }
      }
    }
  }

  const dropped: CoinItem[] = [];
  for (const prevItem of prevItems) {
    if (!currMap.has(prevItem.coin)) {
      dropped.push(prevItem);
    }
  }

  return {
    entered,
    dropped,
    crossedTrigger,
    movers,
    unchangedCount,
    isBaseline: false,
  };
}

export function narrateRow(
  delta: RowDelta,
  excluded: Array<{ instId: string; reasons: string[] }>
): string {
  if (delta.isBaseline) {
    return "";
  }

  const sentences: string[] = [];

  // 1. New entry through trigger → "SOL broke through its trigger — newly eligible."
  const enteredThroughTrigger = delta.entered.filter(
    (c) => c.toTriggerPct !== null && c.toTriggerPct <= 0
  );
  if (enteredThroughTrigger.length > 0) {
    if (enteredThroughTrigger.length === 1) {
      sentences.push(`${enteredThroughTrigger[0]!.coin} broke through its trigger — newly eligible.`);
    } else if (enteredThroughTrigger.length === 2) {
      sentences.push(
        `${enteredThroughTrigger[0]!.coin} and ${enteredThroughTrigger[1]!.coin} broke through their triggers — newly eligible.`
      );
    } else {
      const rest = enteredThroughTrigger.length - 2;
      sentences.push(
        `${enteredThroughTrigger[0]!.coin}, ${enteredThroughTrigger[1]!.coin} and ${rest} other${rest > 1 ? "s" : ""} broke through their triggers — newly eligible.`
      );
    }
  }

  // 2. New entry approaching → "NEAR entered the shortlist, 0.8% from trigger."
  const enteredApproaching = delta.entered.filter(
    (c) => c.toTriggerPct === null || c.toTriggerPct > 0
  );
  if (enteredApproaching.length > 0 && sentences.length < 3) {
    if (enteredApproaching.length === 1) {
      const c = enteredApproaching[0]!;
      if (c.toTriggerPct !== null) {
        const pctStr = `${Math.abs(Number(c.toTriggerPct.toFixed(1)))}%`;
        sentences.push(`${c.coin} entered the shortlist, ${pctStr} from trigger.`);
      } else {
        sentences.push(`${c.coin} entered the shortlist.`);
      }
    } else if (enteredApproaching.length === 2) {
      sentences.push(
        `${enteredApproaching[0]!.coin} and ${enteredApproaching[1]!.coin} entered the shortlist.`
      );
    } else {
      const rest = enteredApproaching.length - 2;
      sentences.push(
        `${enteredApproaching[0]!.coin}, ${enteredApproaching[1]!.coin} and ${rest} other${rest > 1 ? "s" : ""} entered the shortlist.`
      );
    }
  }

  // 3. Existing coin broke through trigger
  if (delta.crossedTrigger.length > 0 && sentences.length < 3) {
    if (delta.crossedTrigger.length === 1) {
      sentences.push(`${delta.crossedTrigger[0]!.coin} broke through its trigger.`);
    } else {
      const coins = delta.crossedTrigger.map((c) => c.coin).join(", ");
      sentences.push(`${coins} broke through triggers.`);
    }
  }

  // 4. Dropped → "PUMP left the shortlist (spread).", using the top exclusion reason where present.
  if (delta.dropped.length > 0 && sentences.length < 3) {
    const excMap = new Map<string, string>();
    for (const e of excluded) {
      const c = coinOf(e.instId);
      if (e.reasons.length > 0) {
        excMap.set(c, e.reasons[0]!);
      }
    }

    if (delta.dropped.length === 1) {
      const c = delta.dropped[0]!;
      const r = excMap.get(c.coin);
      sentences.push(`${c.coin} left the shortlist${r ? ` (${r})` : ""}.`);
    } else if (delta.dropped.length === 2) {
      const c1 = delta.dropped[0]!;
      const c2 = delta.dropped[1]!;
      const r1 = excMap.get(c1.coin);
      const r2 = excMap.get(c2.coin);
      const r1Str = r1 ? ` (${r1})` : "";
      const r2Str = r2 ? ` (${r2})` : "";
      sentences.push(`${c1.coin}${r1Str} and ${c2.coin}${r2Str} left the shortlist.`);
    } else {
      const c1 = delta.dropped[0]!;
      const r1 = excMap.get(c1.coin);
      const r1Str = r1 ? ` (${r1})` : "";
      const rest = delta.dropped.length - 1;
      sentences.push(`${c1.coin}${r1Str} and ${rest} other${rest > 1 ? "s" : ""} left the shortlist.`);
    }
  }

  // 5. Direction bias where known → "Bias is long on 4 of 5 movers." or "No clear bias."
  const moversAndEntered = [...delta.entered, ...delta.crossedTrigger, ...delta.movers];
  if (moversAndEntered.length >= 2 && sentences.length < 3) {
    let longCount = 0;
    let shortCount = 0;
    for (const c of moversAndEntered) {
      if ((c.toTriggerPct !== null && c.toTriggerPct <= 0) || (c.trendSign !== null && c.trendSign > 0)) {
        longCount++;
      } else if (c.trendSign !== null && c.trendSign < 0) {
        shortCount++;
      }
    }
    const totalWithBias = longCount + shortCount;
    if (totalWithBias >= 2) {
      if (longCount > shortCount && longCount >= Math.ceil(totalWithBias * 0.6)) {
        sentences.push(`Bias is long on ${longCount} of ${totalWithBias} movers.`);
      } else if (shortCount > longCount && shortCount >= Math.ceil(totalWithBias * 0.6)) {
        sentences.push(`Bias is short on ${shortCount} of ${totalWithBias} movers.`);
      } else {
        sentences.push(`No clear bias.`);
      }
    }
  }

  return sentences.slice(0, 3).join(" ");
}

function ChipList<T>({
  items,
  maxInline = 8,
  renderChip,
}: {
  items: T[];
  maxInline?: number;
  renderChip: (item: T) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;

  const visible = expanded ? items : items.slice(0, maxInline);
  const remaining = items.length - maxInline;

  return (
    <div className="scout-chips-wrap">
      {visible.map(renderChip)}
      {remaining > 0 && (
        <button
          type="button"
          className="scout-more-btn num"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          aria-label={expanded ? "Show fewer chips" : `Show ${remaining} more chips`}
        >
          {expanded ? "less" : `+${remaining} more`}
        </button>
      )}
    </div>
  );
}

export function ScoutLog() {
  const [collapsed, collapseBtn] = useCollapsed("scout-log");
  const [rows, setRows] = useState<ScoutHistoryRow[] | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/scout/history?n=20", { cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw new Error(`scout/history ${r.status}`);
          return r.json() as Promise<ScoutHistoryRow[]>;
        })
        .then((data) => {
          if (!alive) return;
          setRows(data);
          setExpandedIds((prev) => {
            if (prev.size === 0 && data.length > 0 && data[0]) {
              return new Set([data[0].id]);
            }
            return prev;
          });
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, 30_000);
    const clock = setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(clock);
    };
  }, []);

  const toggleRow = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className={`rail-card scout${collapsed ? " collapsed" : ""}`}>
      <div className="rail-head">
        <span className="eyebrow">
          Scout log{" "}
          <Help title="Scout log">
            <p>Each row compares this shortlist against the previous one. Only changes are listed.</p>
            <dl>
              <dt>In (+n, green)</dt>
              <dd>A coin that was not on the shortlist and now is.</dd>
              <dt>Out (−n, red)</dt>
              <dd>A coin that was on the shortlist and fell off, usually failed spread, volume or funding screens.</dd>
              <dt>Moved (⚡n, amber)</dt>
              <dd>A coin still on the shortlist whose situation changed a lot: either it pushed through its trigger line, or its distance to the trigger shifted by a point or more, or its trend direction flipped.</dd>
              <dt>Trigger</dt>
              <dd>Each coin has a breakout line at today open plus half of yesterday range. The percent beside a coin is its distance to that line. Positive means below it. Zero or negative means price already pushed through.</dd>
              <dt>Quiet rows</dt>
              <dd>Coins that did not change collapse into a count. A row with no badges at all means nothing moved.</dd>
            </dl>
            <p>Screening context, not signals. Nothing here trades.</p>
          </Help>
        </span>
        <span className="num dim">screening context, not signals</span>
        {collapseBtn}
      </div>
      {!collapsed && (
        <>
          {rows === null ? (
            <div className="dim">loading…</div>
          ) : rows.length === 0 ? (
            <div className="dim">no scout history yet</div>
          ) : (
            <div className="scout-log-rows">
              {rows.map((row, idx) => {
                const prev = rows[idx + 1];
                const delta = computeRowDelta(row, prev);
                const narrative = narrateRow(delta, row.excluded);
                const isExpanded = expandedIds.has(row.id);
                const topEx = topExcludedReason(row.excluded);
                const hasChanges =
                  delta.entered.length > 0 ||
                  delta.dropped.length > 0 ||
                  delta.crossedTrigger.length > 0 ||
                  delta.movers.length > 0;

                return (
                  <div className={`scout-log-row ${isExpanded ? "expanded" : ""}`} key={row.id}>
                    <button
                      type="button"
                      className="scout-row-head"
                      onClick={() => toggleRow(row.id)}
                      aria-expanded={isExpanded}
                    >
                      <div className="scout-row-title">
                        <span className="scout-row-arrow dim">{isExpanded ? "▼" : "▶"}</span>
                        <span className="scout-row-time num">{formatTime(row.ts)}</span>
                        <span className="scout-row-age num dim">{scoutAge(row.ts, now)}</span>
                      </div>
                      <div className="scout-row-badges num">
                        {delta.entered.length > 0 && (
                          <span className="badge-entered good">+{delta.entered.length}</span>
                        )}
                        {delta.dropped.length > 0 && (
                          <span className="badge-dropped bad">-{delta.dropped.length}</span>
                        )}
                        {(delta.crossedTrigger.length > 0 || delta.movers.length > 0) && (
                          <span className="badge-movers warning">
                            ⚡{delta.crossedTrigger.length + delta.movers.length}
                          </span>
                        )}
                        {delta.isBaseline && (
                          <span className="dim">{row.eligible.length} in screen</span>
                        )}
                        {!delta.isBaseline && !hasChanges && (
                          <span className="dim">no change</span>
                        )}
                      </div>
                    </button>

                    {narrative !== "" && (
                      <div className="scout-narrative">{narrative}</div>
                    )}

                    {delta.entered.length > 0 && (
                      <div className="scout-delta-line">
                        <span className="scout-delta-tag good">▲ In</span>
                        <ChipList
                          items={delta.entered}
                          maxInline={8}
                          renderChip={(item) => (
                            <span
                              key={item.coin}
                              className="scout-chip entered"
                              title={`${item.id} entered screen`}
                            >
                              <span className="chip-arrow good">▲</span>
                              <span className="chip-coin">{item.coin}</span>
                              {item.toTriggerPct !== null && (
                                <span className="chip-pct dim">{formatTriggerPct(item.toTriggerPct)}</span>
                              )}
                            </span>
                          )}
                        />
                      </div>
                    )}

                    {delta.dropped.length > 0 && (
                      <div className="scout-delta-line">
                        <span className="scout-delta-tag bad">▼ Out</span>
                        <ChipList
                          items={delta.dropped}
                          maxInline={8}
                          renderChip={(item) => (
                            <span
                              key={item.coin}
                              className="scout-chip dropped"
                              title={`${item.id} dropped from screen`}
                            >
                              <span className="chip-arrow bad">▼</span>
                              <span className="chip-coin">{item.coin}</span>
                            </span>
                          )}
                        />
                      </div>
                    )}

                    {(delta.crossedTrigger.length > 0 || delta.movers.length > 0) && (
                      <div className="scout-delta-line">
                        <span className="scout-delta-tag warning">⚡ Moved</span>
                        <ChipList
                          items={[...delta.crossedTrigger, ...delta.movers]}
                          maxInline={8}
                          renderChip={(item) => {
                            const isCrossed = delta.crossedTrigger.some((x) => x.coin === item.coin);
                            return (
                              <span
                                key={item.coin}
                                className={`scout-chip moved ${isCrossed ? "highlight" : ""}`}
                                title={`${item.id} ${isCrossed ? "crossed through trigger" : "proximity moved"}`}
                              >
                                <span className={`chip-arrow ${isCrossed ? "highlight" : "warning"}`}>
                                  {isCrossed ? "⚡" : "▲"}
                                </span>
                                <span className="chip-coin">{item.coin}</span>
                                {item.toTriggerPct !== null && (
                                  <span className="chip-pct dim">{formatTriggerPct(item.toTriggerPct)}</span>
                                )}
                              </span>
                            );
                          }}
                        />
                      </div>
                    )}

                    {delta.isBaseline && (
                      <div className="scout-delta-line">
                        <span className="scout-delta-tag dim">Screen</span>
                        <ChipList
                          items={delta.entered}
                          maxInline={8}
                          renderChip={(item) => (
                            <span key={item.coin} className="scout-chip" title={item.id}>
                              <span className="chip-coin">{item.coin}</span>
                              {item.toTriggerPct !== null && (
                                <span className="chip-pct dim">{formatTriggerPct(item.toTriggerPct)}</span>
                              )}
                            </span>
                          )}
                        />
                      </div>
                    )}

                    {delta.unchangedCount > 0 && (
                      <div className="scout-unchanged-line dim">
                        <span>{delta.unchangedCount} unchanged</span>
                        <button
                          type="button"
                          className="scout-toggle-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleRow(row.id);
                          }}
                        >
                          {isExpanded ? "collapse details" : "show all"}
                        </button>
                      </div>
                    )}

                    {isExpanded && (
                      <div className="scout-expanded-detail">
                        <div className="scout-detail-section">
                          <div className="scout-section-header eyebrow">
                            All eligible ({row.eligible.length})
                          </div>
                          {row.eligible.length > 0 ? (
                            <ChipList
                              items={row.eligible.map(parseCoinItem)}
                              maxInline={8}
                              renderChip={(item) => (
                                <span key={item.coin} className="scout-chip" title={item.id}>
                                  <span className="chip-arrow dim">{scoutArrow(item.raw)}</span>
                                  <span className="chip-coin">{item.coin}</span>
                                  {item.toTriggerPct !== null && (
                                    <span className="chip-pct dim">{formatTriggerPct(item.toTriggerPct)}</span>
                                  )}
                                </span>
                              )}
                            />
                          ) : (
                            <div className="dim">nothing passing the screen</div>
                          )}
                        </div>

                        <div className="scout-detail-section">
                          <div className="scout-section-header eyebrow">
                            <span>Excluded ({row.excluded.length})</span>
                            {topEx !== null && <span className="dim normal-case"> · top: {topEx}</span>}
                          </div>
                          {row.excluded.length > 0 && (
                            <div className="scout-excluded-list">
                              {row.excluded.slice(0, 8).map((e) => (
                                <div key={e.instId} className="scout-excluded">
                                  <span className="scout-coin">{coinOf(e.instId)}</span>
                                  <span className="dim">{e.reasons.join(" · ")}</span>
                                </div>
                              ))}
                              {row.excluded.length > 8 && (
                                <div className="dim num">+{row.excluded.length - 8} more excluded</div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

