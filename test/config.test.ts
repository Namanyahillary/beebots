import { describe, expect, it } from "vitest";
import { LIVE_ACK_PHRASE, loadConfig } from "../src/config.js";
import type { Settings } from "../src/settings.js";

describe("config", () => {
  it("DRY_RUN defaults to true, which forces dry whatever MODE says", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: "k", MODE: "live" }).mode).toBe("dry");
    expect(loadConfig({ TYPESAFE_API_KEY: "k", MODE: "demo", DRY_RUN: "true" }).mode).toBe("dry");
  });

  it("refuses to start without the Jev key", () => {
    expect(() => loadConfig({})).toThrow(/TYPESAFE_API_KEY/);
    expect(() => loadConfig({ TYPESAFE_API_KEY: "  " })).toThrow(/TYPESAFE_API_KEY/);
  });

  it("demo needs all three demo keys and lists the missing NAMES only", () => {
    const env = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "demo", BEE1_OKX_DEMO_API_KEY: "secret-value-1" };
    let msg = "";
    try {
      loadConfig(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/BEE1_OKX_DEMO_API_SECRET/);
    expect(msg).toMatch(/BEE3_OKX_DEMO_API_KEY/);
    expect(msg).not.toMatch(/secret-value-1/);
    expect(msg).not.toMatch(/BEE1_OKX_API_KEY\b/); // live keys not required in demo
  });

  it("demo with every key set loads per-bee creds", () => {
    const env: Record<string, string> = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "demo" };
    for (const b of ["BEE1", "BEE2", "BEE3", "BEE4", "BEE5", "BEE6", "BEE7"]) for (const f of ["KEY", "SECRET", "PASSPHRASE"]) env[`${b}_OKX_DEMO_API_${f}`] = `${b}-${f}`;
    const cfg = loadConfig(env);
    expect(cfg.mode).toBe("demo");
    expect(cfg.creds.bee3?.apiKey).toBe("BEE3-KEY");
  });

  it("live needs the written risk acknowledgement, and demo/dry do not", () => {    const env: Record<string, string> = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "live" };
    for (const b of ["BEE1", "BEE2", "BEE3", "BEE4", "BEE5", "BEE6", "BEE7"]) for (const f of ["KEY", "SECRET", "PASSPHRASE"]) env[`${b}_OKX_API_${f}`] = `${b}-${f}`;
    expect(() => loadConfig(env)).toThrow(/LIVE_ACK/);
    expect(() => loadConfig({ ...env, LIVE_ACK: "yes" })).toThrow(/LIVE_ACK/);
    expect(loadConfig({ ...env, LIVE_ACK: LIVE_ACK_PHRASE }).mode).toBe("live");
    expect(loadConfig({ TYPESAFE_API_KEY: "k" }).mode).toBe("dry");
  });

  it("with no Setup file the bees are the original seven", () => {
    const c = loadConfig({ TYPESAFE_API_KEY: "k" });
    expect(c.slots.bee1).toMatchObject({ style: "bizzy", name: "Grim", customImage: false });
    expect(c.slots.bee2).toMatchObject({ style: "breezy", name: "Silver" });
    expect(c.slots.bee3).toMatchObject({ style: "boozy", name: "Blaze" });
    expect(c.slots.bee4).toMatchObject({ style: "pullback", name: "Ash", customImage: false, fromSetup: false });
    expect(c.slots.bee5).toMatchObject({ style: "scalpy", name: "Zip", customImage: false, fromSetup: false });
    expect(c.slots.bee6).toMatchObject({ style: "fade", name: "Rook", customImage: false, fromSetup: false });
    expect(c.slots.bee7).toMatchObject({ style: "bounce", name: "Echo", customImage: false, fromSetup: false });
  });

  it("a Setup file supplies the Jev key and the bees; the environment still wins", () => {
    const settings: Settings = {
      version: 1,
      jevKey: "from-setup",
      acceptedRiskAt: 1,
      createdAt: 1,
      bees: [
        { name: "Granny", style: "breezy", tagline: "the calm one", rules: "Buy BTC dips.", coins: ["BTC"], image: true },
        { name: "Zippy", style: "boozy", tagline: "", rules: "", coins: [], image: false },
        { name: "Rex", style: "boozy", tagline: "", rules: "", coins: [], image: false },
      ],
    };
    const c = loadConfig({}, settings);
    expect(c.jev.apiKey).toBe("from-setup");
    expect(c.mode).toBe("dry");
    expect(c.slots.bee1).toMatchObject({ name: "Granny", style: "breezy", customImage: true, rules: "Buy BTC dips.", coins: ["BTC"], fromSetup: true });
    expect(c.slots.bee3.style).toBe("boozy");
    expect(c.slots.bee4).toMatchObject({ style: "pullback", name: "Ash", fromSetup: false });
    expect(c.slots.bee5).toMatchObject({ style: "scalpy", name: "Zip", fromSetup: false });
    expect(c.slots.bee6).toMatchObject({ style: "fade", name: "Rook", fromSetup: false });
    expect(c.slots.bee7).toMatchObject({ style: "bounce", name: "Echo", fromSetup: false });
    expect(loadConfig({ TYPESAFE_API_KEY: "env" }, settings).jev.apiKey).toBe("env");
  });

  it("defaults match the strategy files", () => {
    const c = loadConfig({ TYPESAFE_API_KEY: "k" });
    expect(c.bees.bizzy).toMatchObject({ maxTradesPerDay: 3, feeBudgetUsdDay: 3, spreadGateBps: 5, maxFlatMinutes: 20 });
    expect(c.bees.boozy).toMatchObject({ maxTradesPerDay: 9, feeBudgetUsdDay: 9, spreadGateBps: 15, maxFlatMinutes: 0 });
    expect(c.bees.breezy).toMatchObject({ maxTradesPerDay: 3, feeBudgetUsdDay: 1, maxFlatMinutes: 0, cooldownMinutes: 240 });
    expect(c.bees.scalpy).toMatchObject({ maxTradesPerDay: 0, feeBudgetUsdDay: 20, spreadGateBps: 5, cooldownMinutes: 5, stopAtrMult: 0.75, maxFlatMinutes: 0 });
    expect(c.bees.fade).toMatchObject({ maxTradesPerDay: 3, feeBudgetUsdDay: 3, spreadGateBps: 5, cooldownMinutes: 120, stopAtrMult: 2, maxFlatMinutes: 0 });
    expect(c.bees.bounce).toMatchObject({ maxTradesPerDay: 15, feeBudgetUsdDay: 15, spreadGateBps: 10, cooldownMinutes: 120, stopAtrMult: 1.5, maxFlatMinutes: 0 });
    expect(c.tickMs).toBe(10_000);
    expect(c.jev.dailyUsdCap).toBe(2);
    expect(c.dataRefreshMs).toBe(60_000);
    expect(c.risk.maxLeverage).toBe(2);
  });
});

describe("openrouter timeout", () => {
  it("uses the OpenRouter budget under tick time on that backend", async () => {
    const { loadConfig } = await import("../src/config.js");
    const c = loadConfig({ TYPESAFE_API_KEY: "k", REASONING_BACKEND: "openrouter", OPENROUTER_API_KEY: "sk-test", TICK_MS: "10000" });
    expect(c.jev.timeoutMs).toBe(8000);
    const tight = loadConfig({ TYPESAFE_API_KEY: "k", REASONING_BACKEND: "openrouter", OPENROUTER_API_KEY: "sk-test", TICK_MS: "3000", OPENROUTER_TIMEOUT_MS: "2900" });
    expect(tight.jev.timeoutMs).toBe(1000);
  });
});

describe("paper mode (Alpaca)", () => {
  const keys: Record<string, string> = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "paper" };
  for (const b of ["BEE1", "BEE2", "BEE3", "BEE4", "BEE5", "BEE6", "BEE7"]) {
    keys[`${b}_ALPACA_API_KEY`] = `${b}-key`;
    keys[`${b}_ALPACA_API_SECRET`] = `${b}-secret`;
  }
  it("loads per-bee Alpaca creds and $100 books, no OKX keys needed", () => {
    const cfg = loadConfig(keys);
    expect(cfg.mode).toBe("paper");
    expect(cfg.alpCreds.bee2).toEqual({ apiKey: "BEE2-key", secretKey: "BEE2-secret" });
    expect(cfg.creds).toEqual({});
    expect(cfg.risk.startEquityUsd).toBe(100);
    expect(cfg.paper.coins).toEqual(["BTC", "ETH", "SOL", "HYPE"]);
    expect(cfg.dbPath).toMatch(/bees-paper\.sqlite/);
  });
  it("lists missing Alpaca key NAMES only", () => {
    let msg = "";
    try {
      loadConfig({ TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "paper" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/BEE1_ALPACA_API_KEY/);
    expect(msg).toMatch(/BEE3_ALPACA_API_SECRET/);
    expect(msg).toMatch(/BEE4_ALPACA_API_KEY/);
    expect(msg).toMatch(/BEE5_ALPACA_API_SECRET/);
    expect(msg).toMatch(/BEE6_ALPACA_API_KEY/);
    expect(msg).toMatch(/BEE7_ALPACA_API_SECRET/);
  });
  it("needs no LIVE_ACK (paper is not real money)", () => {
    expect(loadConfig(keys).mode).toBe("paper");
  });
});

describe("per-slot modes (one bot live first)", () => {
  const liveKeys = (b: string) => ({ [`${b}_OKX_API_KEY`]: `${b}-k`, [`${b}_OKX_API_SECRET`]: `${b}-s`, [`${b}_OKX_API_PASSPHRASE`]: `${b}-p` });
  it("a single live slot needs live keys for that slot only, plus the ack", () => {
    const base = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", BEE6_MODE: "live", ...liveKeys("BEE6") };
    expect(() => loadConfig(base)).toThrow(/LIVE_ACK/);
    const c = loadConfig({ ...base, LIVE_ACK: LIVE_ACK_PHRASE });
    expect(c.slots.bee6.mode).toBe("live");
    expect(c.slots.bee1.mode).toBe("dry");
    expect(c.creds.bee6?.apiKey).toBe("BEE6-k");
    expect(c.creds.bee1).toBeUndefined();
  });
  it("rejects an unknown per-slot mode instead of silently drying it", () => {
    expect(() => loadConfig({ TYPESAFE_API_KEY: "k", BEE2_MODE: "yolo" })).toThrow(/BEE2_MODE must be one of/);
  });
  it("paper slots start books at paper size", () => {
    const keys: Record<string, string> = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "paper" };
    for (const b of ["BEE1", "BEE2", "BEE3", "BEE4", "BEE5", "BEE6", "BEE7"]) {
      keys[`${b}_ALPACA_API_KEY`] = `${b}-key`;
      keys[`${b}_ALPACA_API_SECRET`] = `${b}-secret`;
    }
    const c = loadConfig(keys);
    expect(c.slots.bee6.mode).toBe("paper");
    expect(c.risk.startEquityUsd).toBe(100);
  });
});
