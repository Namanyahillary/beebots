import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Jev } from "../src/jev.js";
import { Alerts } from "../src/alerts.js";
import { testConfig } from "./fixtures.js";
import { coin, NOW, view } from "./fixtures.js";

function engineWith(cfg = testConfig(), execs?: Record<string, unknown>, exec?: unknown) {
  const db = new Db(":memory:");
  const bus = new EventBus(db);
  const v = view([coin("BTC", {}, 100)]);
  const feed = { view: () => v, lastRefreshAt: NOW } as never;
  const jev = new Jev({ apiKey: "k", model: "m", timeoutMs: 2000, dailyUsdCap: 5, usdPerMTok: 0.042, now: () => NOW });
  const deps: Record<string, unknown> = { cfg, db, feed, jev, bus, alerts: new Alerts(undefined), now: () => NOW };
  if (execs) deps.execs = execs;
  if (exec) deps.exec = exec;
  return new Engine(deps as never);
}

describe("per-slot executors (one bot live first)", () => {
  it("routes each slot to its own executor and refuses a missing one", () => {
    const a = { kind: "sim", venue: "sim-a" };
    const b = { kind: "sim", venue: "sim-b" };
    const full = { bee1: a, bee2: b, bee3: a, bee4: a, bee5: a, bee6: a, bee7: a };
    const e = engineWith(testConfig(), full);
    const at = (id: string) => (e as unknown as { execFor(x: string): { venue: string } }).execFor(id);
    expect(at("bee1").venue).toBe("sim-a");
    expect(at("bee2").venue).toBe("sim-b");
    const e2 = engineWith(testConfig(), { bee1: a });
    const at2 = (id: string) => (e2 as unknown as { execFor(x: string): { venue: string } }).execFor(id);
    expect(() => at2("bee3")).toThrow(/no executor for bee2, bee3, bee4, bee5, bee6, bee7/);
  });
  it("a lone shared exec still serves every slot (backward compatible)", () => {
    const v = view([coin("BTC", {}, 100)]);
    const e = engineWith(testConfig(), undefined, new SimExecutor(() => v.tickers as never, 0.0005, () => NOW));
    const at = (id: string) => (e as unknown as { execFor(x: string): { kind: string } }).execFor(id);
    expect(at("bee1").kind).toBe("sim");
    expect(at("bee7").kind).toBe("sim");
  });
  it("paper slots start books at paper size, dry slots at book size", () => {
    const cfg = testConfig({
      DRY_RUN: "false", BEE6_MODE: "paper",
      BEE6_ALPACA_API_KEY: "k6", BEE6_ALPACA_API_SECRET: "s6",
    });
    expect(cfg.slots.bee6.mode).toBe("paper");
    expect(cfg.slots.bee1.mode).toBe("dry");
    const e = engineWith(cfg);
    const start = (id: string) => (e as unknown as { startEquity(x: string): number }).startEquity(id);
    expect(start("bee6")).toBe(cfg.paper.startEquityUsd);
    expect(start("bee1")).toBe(cfg.risk.startEquityUsd);
  });
  it("the live ramp throttles live slots only", () => {
    const e = engineWith();
    (e as unknown as { liveStartedAt: number }).liveStartedAt = NOW;
    const mult = (id: string) => (e as unknown as { sizeMult(x: string, t: number): number }).sizeMult(id, NOW);
    // All dry by default: full size everywhere even inside the ramp window.
    expect(mult("bee1")).toBe(1);
    expect(mult("bee6")).toBe(1);
  });
});
