/**
 * Staged-entry GHOST tracker (bizzy only, measurement — never executes, never emits on the bus).
 *
 * Question under test: would splitting Grim's one bullet (50% at trigger, 50% on
 * confirmation) soften fake-breakout days? The live entry stays one-shot; this module
 * shadows it with the staged counterfactual and settles both at the real exit.
 * Starting guesses (logged as such): second half fills at +30bp within 60 min, else forfeited.
 */

export interface StagedPlan {
  instId: string;
  coin: string;
  /** Real one-shot entry price (first half is assumed at the same touch). */
  entryPx: number;
  contracts: number;
  confirmPx: number;
  deadlineTs: number;
  secondFilled: boolean;
  secondPx: number | null;
}

export function planStaged(instId: string, coin: string, entryPx: number, contracts: number, now: number, confirmBps = 30, windowMin = 60): StagedPlan {
  return {
    instId, coin, entryPx, contracts,
    confirmPx: entryPx * (1 + confirmBps / 10_000),
    deadlineTs: now + windowMin * 60_000,
    secondFilled: false,
    secondPx: null,
  };
}

/** Feed each tick's mid. Returns what happened (once each): confirmed, expired, or still waiting. */
export function stageTick(plan: StagedPlan, mid: number, now: number): "confirmed" | "expired" | "waiting" {
  if (plan.secondFilled) return "waiting";
  if (mid >= plan.confirmPx) {
    plan.secondFilled = true;
    plan.secondPx = mid;
    return "confirmed";
  }
  if (now >= plan.deadlineTs) return "expired";
  return "waiting";
}

export interface StagedSettlement {
  stagedPnlUsd: number;
  oneShotPnlUsd: number;
  /** Positive: staging saved money. Negative: staging cost money. */
  diffUsd: number;
  secondFilled: boolean;
}

/** Settle both worlds at the REAL exit price (qty-weighted, fees excluded — same for both). */
export function settleStaged(plan: StagedPlan, exitPx: number, ctVal: number): StagedSettlement {
  const half = plan.contracts / 2;
  const firstPnl = (exitPx - plan.entryPx) * half * ctVal;
  const secondPnl = plan.secondFilled && plan.secondPx !== null ? (exitPx - plan.secondPx) * half * ctVal : 0;
  const stagedPnlUsd = firstPnl + secondPnl;
  const oneShotPnlUsd = (exitPx - plan.entryPx) * plan.contracts * ctVal;
  return { stagedPnlUsd, oneShotPnlUsd, diffUsd: stagedPnlUsd - oneShotPnlUsd, secondFilled: plan.secondFilled };
}
