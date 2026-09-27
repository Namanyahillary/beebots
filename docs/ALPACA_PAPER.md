# Alpaca paper (MODE=paper): real venue, play money

Split-brain stage: **eyes on OKX, hands on Alpaca**. Market data stays on the free OKX
public feed (no Alpaca data subscription); orders execute on one Alpaca paper account
per bee. OKX integration is untouched and remains the live path.

## Venue contract (what Alpaca crypto is)

- Spot only, **long-only, no leverage**. Buys open, sells close. No funding bills.
- ~30 coins, no FET / NEAR / SUI. Allowlist: `ALPACA_COINS` (default `BTC,ETH,SOL,HYPE`).
- No commission on crypto (cost is in the spread, captured in fill avgPx).
- $200k notional per order; fractional qty; market + gtc.

## Per-bee impact

- **Grim (breakout, BTC/ETH/SOL/HYPE, strict long-only already): near-perfect fit.**
- **Silver (trend, BTC/ETH): fits, but SHORT opens and flips-to-short become holds**
  (`venue_short` veto — visible in the decision status, never silent).
- **Blaze (momentum, every liquid coin + up to 2x): constrained.** Universe collapses to
  the allowlist and pyramid adds are 1x spot. Treat Blaze paper numbers as
  execution-validation, not strategy-validation.

## Books

Internal books start at `ALPACA_START_EQUITY_USD` ($100) per bee — percentages carry
across, figures stay sane. The $100k sitting in each Alpaca account is headroom, not
deployed capital. Separate `bees-paper.sqlite` books (DB_PATH `{mode}`).

## Enforcement (code, not discipline)

- `risk.ts checkOpen`: every open path (proposal, forced entry, rebalance) vetoes
  `venue_short` / `venue_no_coin` in paper mode.
- `engine decide()`: JEV menus are pre-filtered to venue-tradable longs, so no spend
  is wasted deliberating FET or shorts. Vetoes stay as backstop.
- `reconcile()` runs off-sim (Alpaca positions map back to OKX instIds in contracts);
  the venue is adopted as truth on mismatch, same as OKX.

## Launch

1. `.env`: keys are in (`BEE*_ALPACA_API_KEY/SECRET`, gitignored). Keep `DRY_RUN=true`
   until ready.
2. Launch paper: `DRY_RUN=false MODE=paper pnpm dev` (fresh `bees-paper.sqlite`).
   `init()` fails fast if any account is unreachable — the engine will not start half-wired.
3. First session: expect `venue_no_coin` vetoes on Blaze whenever momentum points at
   strange coins, and `venue_short` holds on Silver's flips. Both are the design working.
4. Watch reconcile ("books match Alpaca") and the first real fill's avgPx vs OKX touch.

## Later: OKX demo

OKX *does* have demo trading (same endpoints + `x-simulated-trading: 1`, separate demo
keys, perps + leverage). That is the correct dress rehearsal before live, because
strategies run unmodified there. Alpaca paper proves venue plumbing; OKX demo proves
the strategies at the real venue.
