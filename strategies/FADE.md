# ROOK — crowded-funding fade (6th style, bee6)

Status: LIVE since 2026-09-28 (bee6 "Rook", the contrarian). Decision gate at 20 resolved fades — see bottom.

## Thesis (one paragraph)

Every wolf in the pack is momentum/long: Grim breaks out, Silver trends, Blaze chases heat, Dash and Zip scalp the wiggle. Nobody fades. Perpetuals have a positioning exhaust pipe the others never touch — the funding rate. When longs are crowded enough to pay extreme funding into an extended rally, the marginal buyer is in and liquidations fuel the reversal; same mirrored for crowded shorts. Rook shorts crowded longs and longs washed-out shorts, using data already plumbed (fundingZ, 24h return) and nothing else. It is the only counter-trend, only two-sided brain in the building — orthogonal by construction.

## Adversarial pre-review (why it might fail)

1. **Catching knives.** Strong trends persist; funding can sit at z>2 for days while price grinds higher. Every fade of a real runner bleeds to a wide stop. The gates select extremes only (top ~2.5%), never mere strength — but persistence is the known killer.
2. **Shorts die in paper.** Alpaca spot is long-only, so the short leg (the stronger leg theoretically) goes quiet there. Accepted: dry/demo/live perps get both legs; paper gets washed-out longs only.
3. **OI would help and is dead.** Open-interest divergence (price up + OI down = weak hands) is the natural confirm, but `oi1h_pct` is null on every coin in this environment (verified 2026-09-28 against `bees-dry.sqlite`). Designed WITHOUT OI; if the feed heals, revisit — do not silently depend on a null field.
4. **Rare by construction.** z≥2 + 8% extension may fire a few times a week across the list. Flat for days is expected, not broken. The 20-fade gate will take weeks — that is fine.

## Rules (starting guesses — every number below is guilty until measured)

- **Universe:** the whole gated list, spread ≤ 5bp. No allowlist.
- **Entry short (FADE_SHORT_<coin>):** fundingZ ≥ +2.0 AND ret24hPct ≥ +8%. Crowded longs paying hard into an extended rally.
- **Entry long (FADE_LONG_<coin>):** fundingZ ≤ -2.0 AND ret24hPct ≤ -8%. Crowded shorts + washout.
- **Size:** risk 1% of book equity, stop-distance sized (2× ATR(15m) stop — crowds overshoot, give it room).
- **Stop:** 2.0× ATR(15m) from entry, hard, set at fill. No widening, ever.
- **Exits:** trim half at +1R, BE-move at +0.75R with fee buffer, runners ride the trail... no trail (no trend to follow on a fade). Close the rest at +2R via ladder rung frac 1.0. Fades snap or fail.
- **Time stop:** 360 minutes. A fade alive at 6h is a regime, not an exhaustion — close it, log `time_stop`.
- **Cadence guards:** max 3 trades/day, $3/day fee budget, 120-minute cooldown. Rare setups, no churn.
- **JEV:** never asked (ruleDriven, like scalpy). Menus carry one setup, status lines cite the rule.

## Measurement (same lens as every bee)

- Per-trade: R-multiple, fee paid, setup tag (`crowd-short` / `washout-long`), hold minutes, fundingZ at entry.
- Review at 20 resolved fades: expectancy net of fees, win rate, avg winner/loser R, short-leg vs long-leg split.
- **Decision gate at 20 resolved fades:** expectancy > 0 net of fees → keep, consider 1.5% risk. Expectancy ≤ 0 → kill the style, journal the postmortem. No extensions, no excuses.

## Implementation checklist

1. `src/settings.ts`: STYLES += "fade", STYLE_INFO entry (Rook, the contrarian), SLOT_IDENTITY bee6.
2. `src/config.ts`: BEES += "bee6", DEFAULT_SLOTS, perSlot("BEE6"), perStyle("FADE", { trades: 3, fee: 3.0, spread: 5, cooldown: 120, stopAtr: 2, maxFlat: 0 }).
3. `src/bees/fade.ts`: brain (gates, sizing, stops, ladder, 6h time stop, neverForce, ruleDriven, no OI dependence).
4. `src/bees/index.ts`: BRAINS += fade. No engine changes (ruleDriven path exists).
5. Dashboard: BEE_NAMES/BEE_META += bee6, 6th column CSS, Setup RESERVED rook, EngineHelp Fade.
6. Risk: no new gates (venue_short handles paper automatically).
7. Tests: brain unit (gates/TP/sizing/labels), 20-fade gate is a human review.
8. Docs: PROFIT_MODE.md entry + this file LIVE.
