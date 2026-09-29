// No-Jev shadow arm — the causal experiment for "is Jev doing good or bad".
// For every brain that consults Jev, a deterministic shadow book trades the SAME
// menu with the SAME exits (stops, TP ladder, BE, time stops, spread/funding
// gates, caps, cooldowns) but a fixed entry policy: the first strict setup in
// menu order, no conviction filter, no WAIT, no RIDE deliberation. The only
// difference measured is Jev's judgment.
//
// Gross R on both sides (live realised excludes fees too). Writes SHADOW_OPEN /
// SHADOW_FILL rows to ghost_decisions only — never trades, never emits, never
// touches books. The caller contains failures (warn) so the shadow can never
// break a trading tick.
//
// Known limitations (all bias toward the shadow, disclosed, not hidden):
// - No profit-lock trail (boozy's lock has no pure-function form to reuse).
// - No Jev fail-closed days: the shadow trades through outages the live bee sits out.
// - Sizing uses live equity (shared ctx), so shadow notionals track the live book.
import { dayKey } from "./ledger.js";
import { takeProfitSignal } from "./risk.js";
import { breakevenStopPx } from "./bees/common.js";
import { contractsFor } from "./exec/sizing.js";
import { maxNotionalUsd, minutesSince, uplUsd } from "./bees/common.js";
import type { BeeBrain, BeeContext, Menu, Position } from "./bees/types.js";
import type { BeeId } from "./config.js";
import type { Db } from "./db.js";

interface ShadowState {
  pos: Position | null;
  day: string;
  tradesToday: number;
  lastOrderAt: number | null;
  /** When the shadow last exited (drives the same max-flat forcing the live bee faces). */
  lastExitAt: number | null;
  fills: number;
  realizedR: number;
}

const books = new Map<BeeId, ShadowState>();

function book(id: BeeId, now: number): ShadowState {
  const day = dayKey(now);
  const b = books.get(id);
  if (b && b.day === day) return b;
  const fresh: ShadowState = { pos: null, day, tradesToday: 0, lastOrderAt: null, lastExitAt: null, fills: 0, realizedR: 0 };
  books.set(id, fresh);
  return fresh;
}

/** For tests: reset the shadow books. */
export function resetShadow(): void {
  books.clear();
}

function shadowFill(db: Db, id: BeeId, now: number, r: number, reason: string, detail: Record<string, unknown>): void {
  const b = books.get(id)!;
  b.fills++;
  b.realizedR += r;
  db.insertGhostDecision({ bee: id, ts: now, choice: "SHADOW_FILL", reason, detail: { r: Number(r.toFixed(3)), ...detail } });
}

/**
 * One shadow tick. Skips rule-driven brains (nothing to shadow — no Jev involved).
 * Mirrors the live exit order: stops, time stops, then TP/BE. Entries take the
 * first strict open in menu order; the max-flat forcing the live bee faces is
 * mirrored too (it is code, not Jev — excluding it would flatter the shadow by
 * letting it sit out chop the live bee is forced into).
 */
export function shadowTick(id: BeeId, brain: BeeBrain, ctx: BeeContext, menu: Menu, now: number, db: Db): void {
  if (brain.ruleDriven) return;
  const b = book(id, now);
  const { view, knobs } = ctx;
  // Brain hooks that read the bee's own position run against the SHADOW book,
  // never the live one (timeStopMinutes reads position.openedAt).
  const sctx = (pos: Position | null): BeeContext => ({ ...ctx, bee: { ...ctx.bee, position: pos } });

  // --- exits on the shadow position ---
  const p = b.pos;
  if (p) {
    const s = view.stats.get(p.instId);
    const inst = view.instruments.get(p.instId);
    if (s && inst) {
      const uplR = p.riskUsd > 0 ? uplUsd(p, s.mid, inst.ctVal) / p.riskUsd : 0;
      // 1. Hard stop (code decides, same as live).
      const stopped = p.stopPx !== null && (p.side === "long" ? s.mid <= p.stopPx : s.mid >= p.stopPx);
      // 2. Time stop.
      const ts = brain.timeStopMinutes?.(sctx(p));
      const timedOut = ts !== undefined && minutesSince(p.openedAt, now) >= ts;
      const exit = (reason: string) => {
        const coin = p.coin;
        const side = p.side;
        b.pos = null;
        b.lastExitAt = now;
        shadowFill(db, id, now, uplR, reason, { coin, side, exitPx: s.mid });
      };
      if (stopped) exit("shadow_stop");
      else if (timedOut) exit("shadow_time_stop");
      else if (brain.takeProfit) {
        // 3. TP ladder + BE (profit-lock deliberately excluded — see header).
        const sig = takeProfitSignal(p, uplR, brain.takeProfit);
        if (sig?.trim) {
          const f = Math.max(0, Math.min(1, sig.trim.fraction));
          const banked = f * uplR;
          p.contracts = Math.max(0, p.contracts * (1 - f));
          if (sig.trim.ladder === true) p.lastLadderR = uplR;
          else p.trimmedAtR = uplR;
          if (p.contracts <= 0) {
            const coin = p.coin;
            const side = p.side;
            b.pos = null;
            b.lastExitAt = now;
            shadowFill(db, id, now, banked, "shadow_tp_close", { coin, side, exitPx: s.mid });
          } else {
            shadowFill(db, id, now, banked, sig.trim.ladder === true ? "shadow_ladder" : "shadow_trim", { coin: p.coin, side: p.side, exitPx: s.mid });
          }
        }
        if (sig?.moveStopToBe && b.pos) {
          const be = breakevenStopPx(b.pos, inst.ctVal, brain.takeProfit.feeBufferR);
          if (be !== null) {
            b.pos.stopPx = b.pos.side === "long" ? Math.max(b.pos.stopPx ?? be, be) : Math.min(b.pos.stopPx ?? be, be);
            b.pos.beMoved = true;
          }
        }
      }
    }
  }

  // --- entries ---
  if (!b.pos) {
    if (b.tradesToday >= knobs.maxTradesPerDay) return;
    if (b.lastOrderAt !== null && minutesSince(b.lastOrderAt, now) < knobs.cooldownMinutes) return;
    // Forced entries are code, not Jev: mirror them so the shadow can't dodge
    // chop the live bee is pushed into.
    if (!brain.neverForce && b.lastExitAt !== null && minutesSince(b.lastExitAt, now) >= knobs.maxFlatMinutes) {
      const f = brain.forcedEntry(sctx(null));
      if (f) {
        openShadow(id, brain, sctx(null), f.instId, f.side, now, db, "shadow_forced");
        return;
      }
    }
    // Otherwise: first strict open in menu order. No conviction filter, no WAIT.
    for (const [label, opt] of Object.entries(menu)) {
      const i = opt.intent;
      if (i.kind !== "open" || i.setup !== "strict") continue;
      if (openShadow(id, brain, ctx, i.instId, i.side, now, db, `shadow_first_strict:${label}`)) return;
    }
  }
}

function openShadow(id: BeeId, brain: BeeBrain, ctx: BeeContext, instId: string, side: "long" | "short", now: number, db: Db, reason: string): boolean {
  const b = books.get(id)!;
  const { view, knobs } = ctx;
  const s = view.stats.get(instId);
  const inst = view.instruments.get(instId);
  if (!s || !inst) return false;
  if (s.spreadBp > knobs.spreadGateBps) return false;
  if (side === "long" && brain.fundingVetoLongZ !== undefined && s.fundingZ !== null && s.fundingZ > brain.fundingVetoLongZ) return false;
  const frac = Math.max(0, Math.min(1, brain.sizeFrac({ kind: "open", instId, side, sizeFrac: 1, setup: "strict" }, 2, ctx)));
  const max = maxNotionalUsd(ctx);
  const notional = Math.min(frac * max, max);
  const minUsd = inst.minSz * inst.ctVal * s.mid;
  if (!(max > 0) || notional < minUsd) return false;
  const contracts = contractsFor(notional, inst, s.mid);
  if (contracts <= 0) return false;
  const stopPx = brain.stopFor(instId, side, s.mid, ctx);
  const riskUsd = stopPx !== null ? (notional * Math.abs(s.mid - stopPx)) / s.mid : notional * 0.01;
  if (!(riskUsd > 0)) return false;
  b.pos = {
    instId, coin: s.coin, side, contracts, entryPx: s.mid, openedAt: now,
    stopPx, riskUsd, initialStopPx: stopPx, trimmedAtR: null, lastLadderR: null, beMoved: false, peakUplUsd: null,
  };
  b.tradesToday++;
  b.lastOrderAt = now;
  db.insertGhostDecision({ bee: id, ts: now, choice: "SHADOW_OPEN", reason, detail: { coin: s.coin, side, entryPx: s.mid } });
  return true;
}

/** Cumulative shadow R per bee (test/report helper). */
export function shadowRealized(id: BeeId): number {
  return books.get(id)?.realizedR ?? 0;
}
