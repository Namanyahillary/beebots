import { useEffect, useState } from "react";
import { BeeColumn, money } from "./BeeColumn";
import { DayPnl } from "./DayPnl";
import { Fills } from "./Fills";
import { Header } from "./Header";
import { Help } from "./Help";
import { Scout } from "./Scout";
import { ScoutLog } from "./ScoutLog";
import { Setups } from "./Setups";
import { unlockAudio } from "./sound";
import { Ticker } from "./Ticker";
import { Toasts } from "./Toasts";
import { BEE_META, BEE_NAMES, type BeeName } from "./types";
import { useFeed } from "./useFeed";
import { useCollapsed } from "./collapse";

function readSoundPref(): boolean {
  try {
    return localStorage.getItem("bees.sound") === "on";
  } catch {
    return false;
  }
}

type PosFilter = "all" | "flat" | "open" | "benched" | "pinned";

function readPosFilter(): PosFilter {
  try {
    const v = localStorage.getItem("bees.posFilter");
    return v === "flat" || v === "open" || v === "benched" || v === "pinned" ? v : "all";
  } catch {
    return "all";
  }
}

function readPinned(): BeeName[] {
  try {
    const v = JSON.parse(localStorage.getItem("bees.pinned") ?? "[]") as unknown;
    return Array.isArray(v) ? (v as string[]).filter((n): n is BeeName => (BEE_NAMES as readonly string[]).includes(n)) : [];
  } catch {
    return [];
  }
}

export function App() {
  const [soundOn, setSoundOn] = useState(false);
  const [posFilter, setPosFilter] = useState<PosFilter>(readPosFilter);
  const [pinned, setPinned] = useState<BeeName[]>(readPinned);
  const feed = useFeed(soundOn);
  const [, force] = useState(0);
  const [boardCollapsed, boardCollapseBtn] = useCollapsed("board");
  const [blockedCollapsed, blockedCollapseBtn] = useCollapsed("blocked");
  const [showDayPnl, setShowDayPnl] = useState(false);

  // Re-render every second so "ago" / flash windows expire even when the stream is quiet.
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Sound needs a click before the browser allows audio: one click anywhere turns on a saved preference.
  useEffect(() => {
    if (!readSoundPref()) return;
    const once = () => setSoundOn(unlockAudio());
    window.addEventListener("pointerdown", once, { once: true });
    return () => window.removeEventListener("pointerdown", once);
  }, []);

  const toggleSound = () => {
    const next = !soundOn && unlockAudio();
    setSoundOn(next);
    try {
      localStorage.setItem("bees.sound", next ? "on" : "off");
    } catch {
      /* private mode: fine */
    }
  };

  const pickPosFilter = (f: PosFilter) => {
    setPosFilter(f);
    try {
      localStorage.setItem("bees.posFilter", f);
    } catch {
      /* private mode: fine */
    }
  };

  const togglePin = (name: BeeName) => {
    setPinned((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name];
      try {
        localStorage.setItem("bees.pinned", JSON.stringify(next));
      } catch {
        /* private mode: fine */
      }
      return next;
    });
  };

  const board = [...BEE_NAMES].sort((a, b) => (feed.bees[b]?.equityUsd ?? 0) - (feed.bees[a]?.equityUsd ?? 0));
  // Position filter (All / Flat / Open): display only. Ranks and gaps still
  // measure against the full pack, so filtering never flatters anyone. Fewer
  // columns also means roomier cards on a crowded six-wolf board.
  // Filter axes, deliberately asymmetric: Flat means flat AND available (a
  // benched-flat bee will never trade, so it would only pollute the ready view
  // — the retired twins live under Benched). Open keeps benched riders: a
  // capped bee nursing a position is still live risk with working stops.
  const shown = BEE_NAMES.filter((name) => {
    const bee = feed.bees[name];
    switch (posFilter) {
      case "flat": return !bee?.position && bee?.cap == null;
      case "open": return !!bee?.position;
      case "benched": return bee?.cap != null;
      case "pinned": return pinned.includes(name);
      default: return true;
    }
  });
  const leaderEq = feed.bees[board[0]!]?.equityUsd ?? 0;
  const baseline = feed.snap?.startEquityUsd ?? 333;
  const stalled = feed.lastEventAt > 0 && Date.now() - feed.lastEventAt > 15_000;
  const blocked = feed.snap?.market.spreadBlocked ?? [];

  return (
    <div className="app">
      <Header snap={feed.snap} connected={feed.connected} stalled={stalled} soundOn={soundOn} onSound={toggleSound} />
      <div className="toolbar" role="group" aria-label="Filter wolves by position">
        <span className="dim">showing</span>
        {(["all", "flat", "open", "benched", "pinned"] as const).map((f) => (
          <button key={f} type="button" className="seg" aria-pressed={posFilter === f} onClick={() => pickPosFilter(f)}>
            {f === "all" ? "All" : f === "flat" ? "Flat" : f === "open" ? "Open" : f === "benched" ? "Benched" : "Pinned"}
          </button>
        ))}
        <span className="dim toolbar-count num">
          {shown.length} of {BEE_NAMES.length}
        </span>
      </div>
      <main className="grid">
        <div className="board-scroll">
        {shown.map((name) => {
          const bee = feed.bees[name];
          return (
            <BeeColumn
              key={name}
              name={name}
              bee={bee}
              curve={feed.curves[name]}
              baseline={baseline}
              rank={board.indexOf(name) + 1}
              gap={bee ? Math.max(0, leaderEq - bee.equityUsd) : null}
              flash={feed.flashes[name]}
              fills={feed.fills}
              decisions={feed.decisions}
              pinned={pinned.includes(name)}
              onPin={() => togglePin(name)}
            />
          );
        })}
        {shown.length === 0 && (
          <p className="dim empty-board">Nothing pinned yet — tap ☆ on a wolf to pin it here.</p>
        )}
        </div>
        <aside className="rail">
          <section className={`rail-card board${boardCollapsed ? " collapsed" : ""}`}>
            <div className="rail-head">
              <span className="eyebrow">
                Leaderboard <Help title="Leaderboard">
                  <p>Leaderboard ranks the pack by current equity.</p>
                  <dl>
                    <dt>Local board</dt>
                    <dd>The widest bar wins on this screen.</dd>
                    <dt>Public board</dt>
                    <dd>The public Hive board is separate and opt in for paper trading only so a live money engine cannot join.</dd>
                    <dt>Privacy</dt>
                    <dd>It shows % gain and loss only and never shows keys, account details or addresses.</dd>
                    <dt>Verified</dt>
                    <dd>A verified badge means the server replayed the wolf fills against OKX candles and the books add up.</dd>
                  </dl>
                  <p>Watch this when you want to see who leads the pack.</p>
                </Help>
              </span>
              <span className="dim">equity</span>
                <button type="button" className="scout-toggle-btn" onClick={() => setShowDayPnl(true)} title="Pack P&L per day">
                  daily
                </button>
              {boardCollapseBtn}
            </div>
            {!boardCollapsed && (
            <div className="board-list">
            {board.map((name, i) => {
              const b = feed.bees[name];
              const width = b ? Math.max(4, (b.equityUsd / Math.max(leaderEq, 1)) * 100) : 0;
              return (
                <div className="board-row" key={name} style={{ ["--bee" as string]: BEE_META[name].color }}>
                  <span className="board-rank num">{i + 1}</span>
                  <img src={BEE_META[name].img} alt="" />
                  <span className="board-name">{BEE_META[name].short}</span>
                  <span className="board-bar">
                    <span style={{ width: `${width}%` }} />
                  </span>
                  <span className="board-eq num">{b ? money(b.equityUsd) : "–"}</span>
                </div>
              );
            })}
            </div>
            )}
          </section>
          <Ticker decisions={feed.decisions} perMin={feed.decisionTimes.length} />
          <Fills fills={feed.fills} decisions={feed.decisions} leverage={feed.snap?.leverage} />
          <Scout scout={feed.snap?.scout} />
          <ScoutLog />
          <Setups decisions={feed.decisions} />
          {blocked.length > 0 && (
            <section className={`rail-card blocked${blockedCollapsed ? " collapsed" : ""}`}>
              <span className="eyebrow">Spread gate says no</span>
              {blockedCollapseBtn}
              {!blockedCollapsed && (
              <div className="blocked-list num">
                {blocked.slice(0, 6).map((b) => (
                  <span key={b.coin}>
                    {b.coin} <span className="dim">{b.spreadBp}bp</span>
                  </span>
                ))}
              </div>
              )}
            </section>
          )}
        </aside>
      </main>
      <Toasts toasts={feed.toasts} />
      {showDayPnl && <DayPnl curves={feed.curves} onClose={() => setShowDayPnl(false)} />}
    </div>
  );
}
