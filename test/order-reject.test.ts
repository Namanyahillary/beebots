// A venue rejection pauses new orders (opens) for 10 min; closes never pause.
// Upstream incident: 98 resent orders in 40 minutes after one 51008.
import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { Db } from "../src/db.js";
import { Engine, ORDER_REJECT_PAUSE_MS } from "../src/engine.js";
import { SimExecutor } from "../src/exec/executor.js";
import { EventBus } from "../src/events.js";
import { Jev } from "../src/jev.js";
import { parseCliError } from "../src/okx/cli.js";
import { bee, coin, NOW, position, testConfig, trend, view } from "./fixtures.js";

async function harness() {
  const cfg = testConfig();
  const db = new Db(":memory:");
  const bus = new EventBus(db);
  const btc = coin("BTC", { trend: trend({ score: 9 }) }, 80000);
  const V = view([btc]);
  let live = false; // venue starts dead, then recovers
  let marketCalls = 0;
  let T = NOW;
  const sim = new SimExecutor(() => (live ? { tickers: V.tickers, instruments: V.instruments } : { tickers: new Map(), instruments: new Map() }), 0.0005, () => T);
  const orig = sim.market.bind(sim);
  sim.market = (async (...a: Parameters<typeof orig>) => { marketCalls++; return orig(...a); }) as typeof orig;
  const feedState = { view: () => V, lastRefreshAt: NOW };
  const feed = feedState as never;
  const answers: { action: { type: string; choice: string; confidence: number; probabilities: Record<string, number> }; conviction: { type: string; score: number; confidence: number; legend: Record<string, never>; probabilities: Record<string, never> } } = {
    action: { type: "choice", choice: "LONG_BTC", confidence: 1, probabilities: { LONG_BTC: 1 } },
    conviction: { type: "score", score: 3, confidence: 0.5, legend: {}, probabilities: {} },
  };
  const jev = new Jev({
    apiKey: "k", model: "m", timeoutMs: 2000, dailyUsdCap: 5, usdPerMTok: 0.042,
    client: { async systemOne() { return { model: "m", usage: { input_tokens: 100, output_tokens: 0 }, answers } as never; } },
    now: () => T,
  });
  const engine = new Engine({ cfg, db, feed, jev, exec: sim, bus, alerts: new Alerts(undefined), now: () => T });
  type E = { decide(id: string, now: number): Promise<void>; bees: Record<string, ReturnType<typeof bee>> };
  const e = engine as unknown as E;
  e.bees["bee2"] = bee("breezy");
  return {
    engine: e,
    decide: (t: number) => { T = t; feedState.lastRefreshAt = t; return e.decide("bee2", t); },
    setLive: (v: boolean) => { live = v; },
    setChoice: (c: string) => { answers.action.choice = c; answers.action.probabilities = { [c]: 1 }; },
    calls: () => marketCalls,
  };
}

describe("order reject pause", () => {
  it("a rejected open pauses new orders for 10 min, then retries", async () => {
    const h = await harness();
    h.setLive(false);
    await h.decide(NOW); // venue dead: open rejected
    expect(h.calls()).toBe(1);
    h.setLive(true);
    await h.decide(NOW + 10_000); // venue back, but paused: no new attempt
    expect(h.calls()).toBe(1);
    await h.decide(NOW + ORDER_REJECT_PAUSE_MS + 10_000); // pause over: retries and fills
    expect(h.calls()).toBe(2);
  });

  it("closes are never paused", async () => {
    const h = await harness();
    h.setLive(false);
    await h.decide(NOW); // open rejected -> pause armed
    expect(h.calls()).toBe(1);
    // Positioned bee with a hit stop; venue back. The stop forces a reduceOnly close.
    const btc = coin("BTC", { trend: trend({ score: 9 }) }, 80000);
    h.engine.bees["bee2"] = bee("breezy", { position: position(btc, { stopPx: 81_000 }), flatSince: null });
    h.setLive(true);
    h.setChoice("HOLD_WINNER");
    await h.decide(NOW + 20_000);
    expect(h.engine.bees["bee2"]!.position).toBeNull();
    expect(h.calls()).toBe(2); // the close went through despite the pause
  });
});

describe("OKX error text", () => {
  it("takes OKX's own sMsg when the CLI prints the JSON response, not the first line '['", () => {
    const e = parseCliError("", '[\n  {\n    "sCode": "51008",\n    "sMsg": "Order failed. Insufficient USDC margin in account"\n  }\n]');
    expect(e.code).toBe("51008");
    expect(e.message).toBe("Order failed. Insufficient USDC margin in account");
  });
});
