import { describe, expect, it } from "vitest";
import { planStaged, settleStaged, stageTick } from "../src/ghostStage.js";

describe("staged-entry ghost (measurement only)", () => {
  it("confirms the second half at +30bp inside 60m", () => {
    const p = planStaged("B-USD", "B", 100, 10, 0);
    expect(p.confirmPx).toBeCloseTo(100.3, 6);
    expect(stageTick(p, 100.1, 1000)).toBe("waiting");
    expect(stageTick(p, 100.3, 2000)).toBe("confirmed");
    expect(p.secondPx).toBe(100.3);
    expect(stageTick(p, 90, 3000)).toBe("waiting"); // decided once, never re-fires
  });
  it("forfeits the second half past the window", () => {
    const p = planStaged("B-USD", "B", 100, 10, 0);
    expect(stageTick(p, 100.1, 61 * 60_000)).toBe("expired");
  });
  it("staging softens a fake and costs on a runner (same exit, entry-efficiency only)", () => {
    const ctVal = 1;
    const fake = planStaged("B-USD", "B", 100, 10, 0);
    stageTick(fake, 100.1, 3_700_000); // never confirms -> expired implicitly at settle
    const s1 = settleStaged(fake, 98, ctVal);
    expect(s1.oneShotPnlUsd).toBe(-20);
    expect(s1.stagedPnlUsd).toBe(-10); // half size in the fake
    expect(s1.diffUsd).toBe(10);
    const run = planStaged("B-USD", "B", 100, 10, 0);
    stageTick(run, 100.3, 1000);
    const s2 = settleStaged(run, 110, ctVal);
    expect(s2.oneShotPnlUsd).toBe(100);
    expect(s2.stagedPnlUsd).toBeCloseTo(98.5, 6);
    expect(s2.diffUsd).toBeCloseTo(-1.5, 6); // the price of confirmation
  });
});
