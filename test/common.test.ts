import { describe, expect, it } from "vitest";
import { maxNotionalUsd } from "../src/bees/common.js";
import { bee, ctx, NOW, view } from "./fixtures.js";
import { testConfig } from "./fixtures.js";

const paperKeys = (env: Record<string, string> = {}) => {
  for (const b of ["BEE1", "BEE2", "BEE3", "BEE4", "BEE5", "BEE6", "BEE7"]) {
    env[`${b}_ALPACA_API_KEY`] = `${b}-key`;
    env[`${b}_ALPACA_API_SECRET`] = `${b}-secret`;
  }
  return env;
};

describe("maxNotionalUsd leverage by venue", () => {
  it("dry/demo/live use MAX_LEVERAGE with headroom", () => {
    const b = bee("bizzy");
    b.equityUsd = 333;
    // min(2*333*0.97, 700) = min(646.02, 700).
    expect(maxNotionalUsd(ctx("bizzy", b, view([])))).toBeCloseTo(646.02, 1);
  });
  it("paper is spot with no margin: leverage 1 even though MAX_LEVERAGE is 2", () => {
    const cfg = testConfig({ DRY_RUN: "false", MODE: "paper", ...paperKeys() });
    expect(cfg.mode).toBe("paper");
    const b = bee("bizzy");
    b.equityUsd = 100;
    // min(1*100*0.97, 700) = 97, not min(2*100*0.97, 700) = 194.
    expect(maxNotionalUsd(ctx("bizzy", b, view([]), cfg, NOW))).toBeCloseTo(97, 5);
  });
});
