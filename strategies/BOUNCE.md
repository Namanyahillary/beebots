# ECHO — Bollinger-RSI mean reversion (7th style, bee7)

Status: LIVE since 2026-09-28 (bee7 "Echo"). Decision gate at 20 resolved reverts — see bottom.

## Thesis (one paragraph)

The pack hunts direction: breakouts, trends, momentum, micro-wiggles, crowded funding. Nobody buys the stretch snapping back. Yet the building's FIRST strategy was exactly that — the Z1 BbandRsi fade, retired into Grim's file as reference helpers when she became a breakout hunter. The helpers (`fadeSetup`, still imported by tests) encode a strict statistical extreme: RSI below 30 with price outside the lower band (long), mirrored short. Echo promotes that reference back into a living wolf with modern gates: same strict setups, risk-normalized sizing, R-ladder exits, and a time stop. It is mean reversion on price extremes — distinct from Rook, who fades positioning/crowding, not price.

## Adversarial pre-review (why it might fail)

1. **Trends stretch further.** In a real trend, RSI pins oversold/overbought for days while price walks the band. Every early fade bleeds. The strict-double-gate (RSI AND outside band, not either) selects only genuine stretches — but regime persistence is the known killer, same as Rook's.
2. **Overlaps Rook's territory.** Both are counter-trend. Difference: Echo fires on statistical price extremes (any coin, any funding), Rook on positioning extremes (crowded funding + extension). They will occasionally take the same side for different reasons — fills attribute per bee, and the review can compare.
3. **Shorts die in paper.** Same as Rook: dry/demo/live perps get both legs, Alpaca spot gets longs only.

## Rules (starting guesses — every number below is guilty until measured)

- **Universe:** the whole gated list, spread ≤ 10bp (fades need liquid exits).
- **Entry long (BOUNCE_LONG_<coin>):** rsi14 < 30 AND pctB < 0, fundingZ ≤ 1.5 (no longing into crowded longs).
- **Entry short (BOUNCE_SHORT_<coin>):** rsi14 > 70 AND pctB > 1.
- **Size:** risk 1% of book equity, stop-distance sized.
- **Stop:** 1.5× ATR(15m) from entry, hard, set at fill. Extension beyond the extreme is invalidation.
- **Exits:** trim half at +1R, close the rest at +2R (ladder rung frac 1.0), BE-move at +0.75R with fee buffer.
- **Time stop:** 480 minutes. A stretch that hasn't snapped back in 8h is a regime, not a stretch — close it.
- **Cadence guards:** max 3 trades/day, $3/day fee budget, 120-minute cooldown. Strict setups are rare; no churn.
- **JEV:** never asked (ruleDriven). One setup per side max, status lines cite the rule.

## Measurement (same lens as every bee)

- Per-trade: R-multiple, fee paid, setup tag (`oversold-bounce` / `overbought-fade`), hold minutes, rsi/pctB at entry.
- Review at 20 resolved reverts: expectancy net of fees, win rate, long vs short split, Echo vs Rook comparison on same-side fills.
- **Decision gate at 20 resolved reverts:** expectancy > 0 net of fees → keep, consider 1.5% risk. Expectancy ≤ 0 → kill the style, journal the postmortem. No extensions, no excuses.
