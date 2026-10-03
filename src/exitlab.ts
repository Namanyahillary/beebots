// exitlab: SILVER (breezy) exit shadow test. Live exits unchanged — variants (a..e)
// ride alongside the live trade on closed 4h bars and are scored at close.
// Adopted from the Opus adversarial verdict 2026-10-03 (12-observation protocol,
// primary variant (e)); two deviations from the proposal: score is nullable
// (replay bars may not carry it) and open shadows exit with the live trade.
export interface LabBar {
  ts: number;
  close: number;
  high: number;
  low: number;
  /** ATR in price units as of this bar (for variant (e)). */
  atr: number;
  score: number | null;
}

export type LabVariant = "a" | "b" | "c" | "d" | "e";

export interface LabShadow {
  stop: number;
  qty: number;
  pnlR: number;
  open: boolean;
}

export interface Lab {
  dir: 1 | -1;
  entry: number;
  /** Risk in price units (|entry - initial stop|). */
  R: number;
  atr0: number;
  n: number;
  nT: number;
  mfeC: number;
  mfeH: number;
  maeC: number;
  t05: number;
  ret05: boolean;
  sh: Record<LabVariant, LabShadow>;
}

export const LAB_VARIANTS: LabVariant[] = ["a", "b", "c", "d", "e"];

export function labOpen(dir: 1 | -1, entry: number, stop: number, atr0: number): Lab {
  const R = Math.abs(entry - stop);
  const sh = {} as Record<LabVariant, LabShadow>;
  for (const k of LAB_VARIANTS) sh[k] = { stop, qty: 1, pnlR: 0, open: true };
  // (c) horizon = expected first-passage bars of a +-1R band, sigma_bar ~ 0.62*ATR. Not fitted.
  const nT = Math.round((R / (0.62 * atr0)) ** 2);
  return { dir, entry, R, atr0, n: 0, nT, mfeC: 0, mfeH: 0, maeC: 0, t05: 0, ret05: false, sh };
}

const book = (s: LabShadow, x: number, q = s.qty) => {
  s.pnlR += q * x;
  s.qty -= q;
  s.open = s.qty > 0;
};

/** Feed one closed 4h bar. Returns the per-bar path row to persist. */
export function labBar(
  L: Lab,
  b: LabBar,
): { ts: number; xR: number; atrRatio: number; score: number | null } {
  const r = (px: number) => (L.dir * (px - L.entry)) / L.R;
  const x = r(b.close);
  L.n++;
  L.mfeC = Math.max(L.mfeC, x);
  L.maeC = Math.min(L.maeC, x);
  L.mfeH = Math.max(L.mfeH, r(L.dir === 1 ? b.high : b.low));
  if (!L.t05 && x >= 0.5) L.t05 = L.n;
  if (L.t05 && L.mfeC < 1 && x <= 0) L.ret05 = true;
  const arm: Record<LabVariant, number> = { a: 1, b: 0.5, c: 1, d: 1, e: Math.min(1, (2 * b.atr) / L.R) };
  for (const k of LAB_VARIANTS) {
    const s = L.sh[k];
    if (!s.open) continue;
    if (x <= r(s.stop)) {
      book(s, x);
      continue;
    }
    if (k === "d" && s.qty === 1 && x >= 0.75) book(s, x, 0.25);
    if (k === "c" && L.n === L.nT && L.mfeC < 1) {
      if (x <= 0) {
        book(s, x);
        continue;
      }
      s.stop = L.entry;
    }
    if (L.mfeC >= arm[k] && r(s.stop) < 0) s.stop = L.entry;
  }
  return { ts: b.ts, xR: x, atrRatio: b.atr / L.atr0, score: b.score };
}

export interface LabResult {
  R_atr: number;
  bars: number;
  nT: number;
  mfeC: number;
  mfeH: number;
  maeC: number;
  t05: number;
  ret05: boolean;
  liveNetR: number;
  reason: string;
  /** Round-trip: MFE_close >= +0.5R and net <= -0.5R. The primary statistic. */
  rt: boolean;
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
}

/** Score the lab when the live trade closes (any reason). Open shadows exit with it. */
export function labClose(L: Lab, exitPx: number, liveNetR: number, reason: string): LabResult {
  const x = (L.dir * (exitPx - L.entry)) / L.R;
  for (const s of Object.values(L.sh)) if (s.open) book(s, x);
  const p = (k: LabVariant) => Number(L.sh[k].pnlR.toFixed(3));
  return {
    R_atr: L.R / L.atr0,
    bars: L.n,
    nT: L.nT,
    mfeC: L.mfeC,
    mfeH: L.mfeH,
    maeC: L.maeC,
    t05: L.t05,
    ret05: L.ret05,
    liveNetR,
    reason,
    rt: L.mfeC >= 0.5 && liveNetR <= -0.5,
    a: p("a"),
    b: p("b"),
    c: p("c"),
    d: p("d"),
    e: p("e"),
  };
}
