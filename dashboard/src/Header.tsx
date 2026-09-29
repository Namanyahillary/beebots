import { useEffect, useState, type ReactNode } from "react";
import { money, signed } from "./BeeColumn";
import { BRAND } from "./brand";
import { Help } from "./Help";
import { HiveButton } from "./Hive";
import { BEE_NAMES, PROFILE, type Snapshot } from "./types";

function Clock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="num">{new Date(now).toISOString().slice(11, 19)} UTC</span>;
}

function Recon({ recon, mode }: { recon: Snapshot["recon"] | undefined; mode: Snapshot["mode"] | undefined }) {
  const state = !recon || recon.ok === null ? "idle" : recon.ok ? "ok" : "bad";
  const text =
    state === "ok" ? "books match OKX to the cent" : state === "bad" ? recon!.detail : mode === "dry" ? "paper trading: simulated books" : "first check pending";
  return (
    <div className={`recon recon-${state}`} title={recon?.detail}>
      <span className="recon-light" aria-hidden />
      <div>
        <div className="eyebrow">Reconciliation</div>
        <div className="recon-text">{state === "ok" ? "✓ " : state === "bad" ? "✗ " : ""}{text}</div>
      </div>
    </div>
  );
}


function Counter({ label, value, sub, tone, help }: { label: string; value: string; sub?: string; tone?: "good" | "bad"; help?: ReactNode }) {
  return (
    <div className="counter">
      <div className="eyebrow">
        {label}
        {help && <> {help}</>}
      </div>
      <div className={`counter-value num ${tone ?? ""}`}>{value}</div>
      {sub && <div className="counter-sub num">{sub}</div>}
    </div>
  );
}

export function Header({ snap, connected, stalled, soundOn, onSound }: { snap: Snapshot | null; connected: boolean; stalled: boolean; soundOn: boolean; onSound: () => void }) {
  const day = snap?.startedAt ? Math.floor((Date.now() - snap.startedAt) / 86_400_000) + 1 : 1;
  const t = snap?.totals;
  const jev = snap?.jev;
  const orders = snap?.bees.reduce((a, b) => a + b.totals.orders, 0) ?? 0;
  const decisions = snap?.bees.reduce((a, b) => a + b.totals.decisions, 0) ?? 0;
  const live = connected && !stalled;
  return (
    <header className="top">
      <div className="brand">
        <div className="brand-row">
          <div className="logo">{BRAND.appName}</div>
          <HiveButton />
        </div>
        <div className="brand-sub">
          <span className={`mode mode-${snap?.mode ?? "dry"}`}>{snap?.mode === "live" ? "● LIVE MONEY" : snap?.mode === "demo" ? "OKX DEMO" : "PAPER TRADING"}{snap?.closed ? (snap.closed.flat ? " · ENDED" : " · CLOSING") : ""}</span>
          {snap?.update ? (
            <a className="update-pill" href={`${PROFILE.links?.code ?? "https://github.com/imikerussell/beebots"}/releases/latest`} target="_blank" rel="noopener" title={`You run ${snap.update.current}. See what's new and how to update.`}>
              Update available: {snap.update.latest} ↗
            </a>
          ) : null}
          <span className="dim">
            day {day} · {BEE_NAMES.length} wolves · OKX X-Perps · not financial advice
          </span>
        </div>
      </div>

      <div className="counters">
        <Counter label="Total P&L" value={t ? signed(t.pnlUsd) : "–"} tone={t ? (t.pnlUsd >= 0 ? "good" : "bad") : undefined} sub={`${orders} orders`} />
        <Counter label="Fees paid" value={t ? money(t.feesUsd) : "–"} sub="taker 0.05%" />
        <Counter label="Funding" value={t ? signed(t.fundingUsd) : "–"} sub="00 · 08 · 16 UTC" />
        <Counter
          label="Jev spend"
          value={t ? money(t.jevUsd, 4) : "–"}
          sub={jev ? `today ${money(jev.spentTodayUsd, 3)} of ${money(jev.dailyCapUsd, 0)} cap` : undefined}
          help={
            <Help title="Jev calls">
              <p>Jev calls track what each decision cost.</p>
              <dl>
                <dt>Made</dt>
                <dd>It counts real Jev API calls.</dd>
                <dt>Skipped</dt>
                <dd>It counts ticks where the cached answer was reused on the same menu, market, leader, position, cap and freshness within 12 heartbeat ticks.</dd>
                <dt>Saved</dt>
                <dd>It multiplies skipped calls by average call cost to estimate what the cache avoided.</dd>
                <dt>Safety</dt>
                <dd>Only the API call skips while stops, caps, vetoes and take profit still run in code every tick.</dd>
                <dt>Holding</dt>
                <dd>A spent daily cap or unreachable Jev means holding.</dd>
              </dl>
              <p>Watch this when daily spend climbs.</p>
            </Help>
          }
        />
        <Counter label="Decisions" value={decisions.toLocaleString()} sub={jev?.down ? "Jev unreachable: holding" : jev?.capTripped ? "Jev cap hit: holding" : "every one recorded"} tone={jev?.down || jev?.capTripped ? "bad" : undefined} />
        <Counter label="Visitors" value={snap?.visitors ? snap.visitors.total.toLocaleString() : "–"} sub={snap?.visitors ? `${snap.visitors.watching} watching now` : undefined} />
      </div>

      <div className="top-right">
        <Recon recon={snap?.recon} mode={snap?.mode} />
        <div className="conn">
          <span className={`conn-dot ${live ? "on" : "off"}`} />
          <span>{live ? "live" : connected ? "stalled" : "reconnecting"}</span>
          <Clock />
          <button className={`sound ${soundOn ? "on" : ""}`} onClick={onSound} aria-pressed={soundOn}>
            {soundOn ? "🔊" : "🔇"}
          </button>
        </div>
      </div>
    </header>
  );
}
