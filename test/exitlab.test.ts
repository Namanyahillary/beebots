// exitlab shadows: BE arms, the (e) variant, and the ETH-shaped round trip.
import { describe, expect, it } from "vitest";
import { labBar, labClose, labOpen, type LabBar } from "../src/exitlab.js";

const bar = (ts: number, close: number, atr = 5): LabBar => ({ ts, close, high: close + 1, low: close - 1, atr, score: null });

describe("exitlab", () => {
  it("arms breakeven at +1R and exits at the stop while an unarmed ride continues", () => {
    const L = labOpen(1, 100, 90, 5);
    labBar(L, bar(1, 105));
    labBar(L, bar(2, 112)); // +1.2R: (a) moves stop to entry
    labBar(L, bar(3, 99)); // x=-0.1 <= 0: (a) books at the entry stop
    const res = labClose(L, 85, -1.5, "stop");
    expect(res.a).toBeCloseTo(-0.1, 6); // armed: out near flat, not riding to -1.5
    expect(res.mfeC).toBeCloseTo(1.2, 6);
  });

  it("ETH-shaped trade is a round trip: rt true, shadow (a) tracks live", () => {
    const L = labOpen(1, 100, 90, 5);
    for (const [i, c] of [102, 105, 109.2, 105, 100, 95].entries()) labBar(L, bar(i + 1, c));
    const res = labClose(L, 92.3, -0.77, "stop");
    expect(res.mfeC).toBeCloseTo(0.92, 6);
    expect(res.rt).toBe(true);
    expect(res.a).toBeCloseTo(-0.77, 6);
    // Engine validity check: |a - live| <= 0.1R or the test is void.
    expect(Math.abs(res.a - res.liveNetR)).toBeLessThanOrEqual(0.1);
  });

  it("variant (b) banks the ETH-shaped pop while (e) matches (a) on stable ATR", () => {
    const L = labOpen(1, 100, 90, 5);
    for (const [i, c] of [102, 105, 109.2, 105, 100, 95].entries()) labBar(L, bar(i + 1, c));
    const res = labClose(L, 92.3, -0.77, "stop");
    expect(res.b).toBeCloseTo(0, 6); // BE at +0.5R: stop at entry catches bar 5 (x=0)
    expect(res.e).toBeCloseTo(res.a, 6); // arm = min(1, 2*5/10) = 1
  });

  it("(e) arms earlier when ATR contracts", () => {
    const L = labOpen(1, 100, 90, 5);
    labBar(L, bar(1, 103, 5));
    labBar(L, bar(2, 106, 2.5)); // ATR halved: (e) arm = min(1, 5/10) = 0.5
    labBar(L, bar(3, 99, 2.5)); // (e) booked at its entry stop; (a) still riding
    const res = labClose(L, 85, -1.5, "stop");
    expect(res.e).toBeGreaterThan(res.a); // -0.1 vs the full ride down
  });
});
