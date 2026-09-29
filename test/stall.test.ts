import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { loadWindows, summarize } from "../src/tools/stall-value.js";
import { NOW } from "./fixtures.js";

const DEC = {
  stateHash: "h", menuJson: "[]", probabilities: null, confidence: null,
  conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
  jevCached: false, model: null, action: { kind: "none" } as const, vetoedBy: null, forcedBy: null, status: "t",
};

function state(uplR: number | null) {
  return JSON.stringify({ utc: "00:00", me: { pos: "long X", upl_r: uplR }, coins: {} });
}

describe("stall meter", () => {
  it("replays peak/exit R and prices the giveback by hold bucket", () => {
    const db = new Db(":memory:");
    // Position 1: ran to +0.8R over 3h, gave back to +0.1R (a stall).
    const d1 = db.insertDecision({ bee: "bee1", ts: NOW, choice: "X", ...DEC, stateJson: state(0) });
    const o1 = db.insertOrder({ decisionId: d1, bee: "bee1", ts: NOW, clOrdId: "o1", instId: "X", side: "buy", contracts: 1, reduceOnly: false, purpose: "open" });
    db.insertDecision({ bee: "bee1", ts: NOW + 60 * 60_000, choice: "X", ...DEC, stateJson: state(0.8) });
    db.insertDecision({ bee: "bee1", ts: NOW + 180 * 60_000, choice: "X", ...DEC, stateJson: state(0.1) });
    const c1 = db.insertOrder({ decisionId: d1, bee: "bee1", ts: NOW + 180 * 60_000, clOrdId: "c1", instId: "X", side: "sell", contracts: 1, reduceOnly: true, purpose: "stop" });
    db.insertFill({ orderId: c1, bee: "bee1", ts: NOW + 180 * 60_000, instId: "X", side: "sell", contracts: 1, px: 1, notionalUsd: 1, feeUsd: 0, realisedUsd: 1, entryDecisionId: d1 });
    // Position 2: quick scratch in 20m (not a stall — no peak, short hold).
    const d2 = db.insertDecision({ bee: "bee1", ts: NOW, choice: "X", ...DEC, stateJson: state(0) });
    const o2 = db.insertOrder({ decisionId: d2, bee: "bee1", ts: NOW, clOrdId: "o2", instId: "X", side: "buy", contracts: 1, reduceOnly: false, purpose: "open" });
    const c2 = db.insertOrder({ decisionId: d2, bee: "bee1", ts: NOW + 20 * 60_000, clOrdId: "c2", instId: "X", side: "sell", contracts: 1, reduceOnly: true, purpose: "stop" });
    db.insertFill({ orderId: c2, bee: "bee1", ts: NOW + 20 * 60_000, instId: "X", side: "sell", contracts: 1, px: 1, notionalUsd: 1, feeUsd: 0, realisedUsd: 0, entryDecisionId: d2 });
    // Position 3: pre-attribution close (no link) — excluded.
    const o3 = db.insertOrder({ decisionId: d2, bee: "bee1", ts: NOW, clOrdId: "o3", instId: "X", side: "sell", contracts: 1, reduceOnly: true, purpose: "stop" });
    db.insertFill({ orderId: o3, bee: "bee1", ts: NOW + 10 * 60_000, instId: "X", side: "sell", contracts: 1, px: 1, notionalUsd: 1, feeUsd: 0, realisedUsd: -5 });

    const windows = loadWindows(db.raw as never);
    expect(windows).toHaveLength(2);
    const stall = windows.find((w) => w.holdMin >= 120)!;
    expect(stall.peakR).toBeCloseTo(0.8, 5);
    expect(stall.exitR).toBeCloseTo(0.1, 5);
    expect(stall.givebackR).toBeCloseTo(0.7, 5);
    const rows = summarize(windows);
    const mid = rows.find((r) => r.bucket === "1-4h")!;
    expect(mid).toMatchObject({ n: 1, stalls: 1 });
    expect(mid.stallGivebackR).toBeCloseTo(0.7, 5);
    const quick = rows.find((r) => r.bucket === "<1h")!;
    expect(quick).toMatchObject({ n: 1, stalls: 0 });
  });
});
