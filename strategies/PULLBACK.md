# PULLBACK — dip-buying inside weekly trends (8th style, bee4 "Ash")

Status: LIVE since 2026-10-01 (bee4). Decision gate at 40 resolved pullbacks — see bottom.

## Thesis (one paragraph)

Crypto's multi-day trends persist while its short-term moves partly reverse — two of the better-documented effects in the literature, and neither is traded in this building. Silver and Blaze buy strength; Echo fades extremes outside the band; Rook fades crowded funding. Pullback buys mild weakness inside strength: a 15-minute dip (RSI 30–42, still inside the bands) inside an established 7-day uptrend with funding NOT crowded, mirrored short. Needs +1.6pp of edge at 2R targets (41× the toll) — the most headroom of any style specced here.

## Adversarial pre-review (why it might fail)

1. **Dips keep dipping.** A mild dip is often the first leg of a full reversal, not a pause. The 7-day trend + not-mid-dump (1h ≥ -1%) + uncrowded-funding gates select pauses, not knives — but regime change is the known killer.
2. **Slow.** 2% risk... 1% risk per trade, 12-hour time stops, a few setups a week. The 40-trade gate takes weeks. Fine.
3. **Echo/Rook overlap.** Disjoint by construction: Echo needs price OUTSIDE the band (Pullback needs inside 0–0.25), Rook needs crowded funding (Pullback requires uncrowded). Same-side fills attribute per bee for comparison.

## Rules (starting guesses — every number below is guilty until measured)

- **Universe:** the whole gated list, spread ≤ 5bp.
- **Entry long (PULLBACK_LONG_<coin>):** ret7dPct ≥ +8%, rsi14 30–42, pctB 0–0.25, fundingZ ≤ +1.0, ret1hPct ≥ -1.0%, and trend.score ≥ +3 where present.
- **Entry short (PULLBACK_SHORT_<coin>):** ret7dPct ≤ -8%, rsi14 58–70, pctB 0.75–1, fundingZ ≥ -1.0, ret1hPct ≤ +1.0%.
- **Size:** risk 1% of book equity, stop-distance sized.
- **Stop:** 2× ATR(15m) with an 80bp floor on stop distance, hard, set at fill. No widening, ever.
- **Exits:** single exit at +2R (full close through the trim path), BE-move at +1R with fee buffer.
- **Time stop:** 720 minutes. A dip that hasn't resumed in 12h was a reversal — close it.
- **Cadence guards:** max 4 trades/day, $3/day fee budget, 60-minute cooldown.
- **JEV:** never asked (ruleDriven). Most-crowded... most-trended setup first when several qualify (rank by |ret7d|).

## Measurement (same lens as every bee)

- Per-trade: R-multiple, fee paid, setup tag (`trend-dip` / `trend-rally-fade`), hold minutes, ret7d at entry.
- Early kill at 15 resolved trades if net expectancy ≤ -0.3R, or fewer than 30% ever reach +1R, or over 50% of exits are time stops.
- **Decision gate at 40 resolved trades:** keep if net expectancy > 0 and win rate ≥ 35%, else kill. No extensions, no excuses.
