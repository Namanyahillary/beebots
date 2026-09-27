// Alpaca paper executor: REST mapping, fill polling, positions and fee reads. fetch is stubbed: no network.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlpacaExecutor } from "../src/exec/alpaca.js";
import type { Instrument } from "../src/market/types.js";

const BTC: Instrument = { instId: "BTC-USDT-SWAP", coin: "BTC", kind: "crypto", ctVal: 0.01, lotSz: 1, minSz: 1, tickSz: 0.1, state: "live" };
const instruments = () => new Map([[BTC.instId, BTC]]);
const exec = () => new AlpacaExecutor("https://paper-api.alpaca.markets", { bee1: { apiKey: "k", secretKey: "s" } }, (id) => instruments().get(id), instruments, 1000);

const order = (over = {}) => ({ id: "oid1", client_order_id: "c1", symbol: "BTC/USD", qty: "0.5", filled_qty: "0.5", filled_avg_price: "80000", status: "filled", ...over });

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    json: async () => handler(url, init),
    text: async () => "",
  })));
}

beforeEach(() => vi.unstubAllGlobals());

describe("AlpacaExecutor", () => {
  it("sends spot market orders as base-qty and reports fills in contracts", async () => {
    let posted: Record<string, unknown> = {};
    stubFetch((url, init) => {
      if (url.endsWith("/v2/orders") && init?.method === "POST") {
        posted = JSON.parse(init.body as string);
        return { id: "oid1" };
      }
      return order();
    });
    const r = await exec().market("bee1", { instId: BTC.instId, side: "buy", contracts: 50, reduceOnly: false, clOrdId: "c1" });
    expect(posted).toMatchObject({ symbol: "BTC/USD", qty: "0.5", side: "buy", type: "market", time_in_force: "gtc", client_order_id: "c1" });
    expect(r).toMatchObject({ ok: true, ordId: "oid1", contracts: 50, avgPx: 80000, feeUsd: 0 });
  });

  it("rejects unknown instruments without touching the network", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const r = await exec().market("bee1", { instId: "NOPE", side: "buy", contracts: 1, reduceOnly: false, clOrdId: "c" });
    expect(r).toMatchObject({ ok: false, state: "rejected" });
    expect(f).not.toHaveBeenCalled();
  });

  it("reports venue rejections as rejected, not unknown", async () => {
    stubFetch((url, init) => (url.endsWith("/v2/orders") && init?.method === "POST" ? { id: "oid1" } : order({ status: "rejected", filled_qty: "0" })));
    const r = await exec().market("bee1", { instId: BTC.instId, side: "buy", contracts: 50, reduceOnly: false, clOrdId: "c1" });
    expect(r).toMatchObject({ ok: false, state: "rejected" });
  });

  it("maps positions back to OKX instIds in contracts", async () => {
    stubFetch(() => [{ symbol: "BTC/USD", qty: "0.5", avg_entry_price: "79900", side: "long" }]);
    const p = await exec().positions("bee1");
    expect(p).toEqual([{ instId: BTC.instId, pos: 50, avgPx: 79900 }]);
  });

  it("reads no commission on closed crypto orders", async () => {
    stubFetch(() => [order({ id: "oid1" }), order({ id: "oid2" })]);
    const fees = await exec().feesFor("bee1", [BTC.instId], new Set(["oid1"]));
    expect(fees?.get("oid1")).toBe(0);
    expect(fees?.has("oid2")).toBe(false);
  });

  it("spot has no funding bills", async () => {
    await expect(exec().fundingBills("bee1")).resolves.toEqual([]);
  });

  it("fails fast without credentials", async () => {
    const e = new AlpacaExecutor("https://x", {}, (id) => instruments().get(id), instruments, 1000);
    await expect(e.init("bee2")).rejects.toThrow(/no Alpaca credentials/);
  });
});
