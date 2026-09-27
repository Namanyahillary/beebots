import type { BeeId } from "../config.js";
import { log } from "../log.js";
import type { Instrument } from "../market/types.js";
import { safeError } from "../redact.js";
import type { AlpacaCreds } from "../config.js";
import type { ExchangePosition, Executor, FundingBill, OrderReq, OrderResult } from "./executor.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AlpacaOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  qty: string | null;
  filled_qty: string | null;
  filled_avg_price: string | null;
  status: string;
}

interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  side: string;
}

/**
 * MODE=paper: spot market orders on Alpaca (one paper account per bee), market data still from OKX.
 * Crypto on Alpaca is long-only with no leverage: buys open, sells close. Qty (base units) =
 * contracts x ctVal, so the ledger's contract math round-trips through the venue.
 */
export class AlpacaExecutor implements Executor {
  readonly kind = "alpaca" as const;
  readonly venue = "Alpaca";

  constructor(
    private baseUrl: string,
    private creds: Partial<Record<BeeId, AlpacaCreds>>,
    private instrument: (instId: string) => Instrument | undefined,
    private instruments: () => Map<string, Instrument>,
    private timeoutMs = 15_000,
  ) {}

  private headers(bee: BeeId): Record<string, string> {
    const c = this.creds[bee];
    if (!c) throw new Error(`no Alpaca credentials for ${bee}`);
    return { "APCA-API-KEY-ID": c.apiKey, "APCA-API-SECRET-KEY": c.secretKey, "Content-Type": "application/json" };
  }

  private async req<T>(bee: BeeId, path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers: this.headers(bee), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`alpaca ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  async init(bee: BeeId): Promise<void> {
    const a = await this.req<{ equity: string; buying_power: string; status: string }>(bee, "/v2/account");
    log.info("alpaca account ok", { bee, equity: a.equity, buyingPower: a.buying_power, status: a.status });
  }

  private symbolFor(instId: string): { symbol: string; inst: Instrument } | null {
    const inst = this.instrument(instId);
    if (!inst) return null;
    return { symbol: `${inst.coin}/USD`, inst };
  }

  async market(bee: BeeId, req: OrderReq): Promise<OrderResult> {
    const s = this.symbolFor(req.instId);
    if (!s) return { ok: false, error: { code: "INST", message: "unknown instrument" }, state: "rejected" };
    const qty = Number((req.contracts * s.inst.ctVal).toFixed(9));
    if (!(qty > 0)) return { ok: false, error: { code: "SIZE", message: "qty rounds to zero" }, state: "rejected" };
    try {
      const placed = await this.req<AlpacaOrder>(bee, "/v2/orders", {
        method: "POST",
        body: JSON.stringify({ symbol: s.symbol, qty: String(qty), side: req.side, type: "market", time_in_force: "gtc", client_order_id: req.clOrdId }),
      });
      for (let i = 0; i < 12; i++) {
        let o: AlpacaOrder;
        try {
          o = await this.req<AlpacaOrder>(bee, `/v2/orders/${placed.id}`);
        } catch (err) {
          log.warn("alpaca fill poll failed, retrying", { bee, err: safeError(err) });
          await sleep(Math.min(4000, 400 * 2 ** Math.min(i, 3)));
          continue;
        }
        const filledQty = Number(o.filled_qty ?? 0);
        if (o.status === "filled" || (filledQty > 0 && (o.status === "canceled" || o.status === "expired"))) {
          const avgPx = Number(o.filled_avg_price ?? 0);
          if (!(avgPx > 0) || !(filledQty > 0)) break;
          return { ok: true, ordId: o.id, contracts: filledQty / s.inst.ctVal, avgPx, feeUsd: 0, ts: Date.now() };
        }
        if (o.status === "rejected" || o.status === "canceled" || o.status === "expired") {
          return { ok: false, error: { code: o.status.toUpperCase(), message: `order ${o.status}` }, state: "rejected" };
        }
        await sleep(400);
      }
      return { ok: false, error: { code: "UNCONFIRMED", message: "fill not confirmed; reconciliation will settle it" }, state: "unknown" };
    } catch (err) {
      return { ok: false, error: safeError(err), state: "unknown" };
    }
  }

  async positions(bee: BeeId): Promise<ExchangePosition[] | null> {
    try {
      const rows = await this.req<AlpacaPosition[]>(bee, "/v2/positions");
      const out: ExchangePosition[] = [];
      for (const r of rows) {
        if (r.side !== "long") continue;
        const coin = r.symbol.split("/")[0]!.toUpperCase();
        const inst = [...this.instruments().values()].find((x) => x.coin === coin);
        if (!inst || !(Number(r.qty) > 0)) continue;
        out.push({ instId: inst.instId, pos: Number(r.qty) / inst.ctVal, avgPx: Number(r.avg_entry_price) });
      }
      return out;
    } catch (err) {
      log.warn("alpaca positions read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  /** Spot has no funding: polled, none. (The engine only polls funding on OKX anyway.) */
  async fundingBills(_bee: BeeId): Promise<FundingBill[] | null> {
    return [];
  }

  /** Alpaca crypto charges no commission (cost is in the spread, captured in avgPx): matched orders bill 0. */
  async feesFor(bee: BeeId, _instIds: string[], ordIds: Set<string>): Promise<Map<string, number> | null> {
    try {
      const out = new Map<string, number>();
      const rows = await this.req<AlpacaOrder[]>(bee, "/v2/orders?status=closed&limit=50&direction=desc");
      for (const r of rows) if (ordIds.has(r.id)) out.set(r.id, 0);
      return out;
    } catch (err) {
      log.warn("alpaca orders read failed", { bee, err: safeError(err) });
      return null;
    }
  }
}
