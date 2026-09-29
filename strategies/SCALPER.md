# SCALPY — fast day-trader (4th style, proposed)

Status: CALIBRATION v2 since 2026-09-29 (retired 9/28, un-benched 9/29 — paper costs nothing and entry selectivity was never tested). Dash = frozen control (retired ladder config). Zip = fresh-only variant (skips exhausted thrusts, yields on deterministic collision with Dash's pick). Next 30 combined decide again; expectancy ≤ 0 kills both with no third act.
Built as specced with two deltas: (1) entries run through a new generic `ruleDriven`
engine path (single setup taken as-is, zero Jev calls, all code gates still fire);
(2) a 30bp chase guard on the micro-high (post-SOL consensus: market-take within,
never chase past). Sizing floor bites immediately on small books (~1.5% risk on $333)
— flagged for the 30-scalp review.
Concurrency (owner call 2026-09-28): two slots run the playbook side by side
(bee4 Dash, bee5 Zip), so two scalps can work concurrently while every bee keeps
its single position — no multi-position engine surgery. Rank-split (trade #1
mirrored perfectly, so split from 2026-09-28): Dash takes the freshest setup,
Zip the second-freshest; one setup means Dash takes it and Zip waits. Known cost:
a lone setup while Dash is busy goes untaken — cheap on quiet markets, measured
in Zip's idle stats. True multi-position-per-bee stays refused pending evidence. The 30-scalp gate counts combined resolved scalps across both slots.

## Thesis (one paragraph)

The three wolves leave a gap at the fast end: Grim takes one breakout a day, Silver rides
multi-hour trends, Blaze holds for 24h+. Nothing fishes the 15–60 minute wiggle — small,
frequent, out fast. Scalpy fills that slot with single-position scalps: TP ladder set short
(+0.5R trim, +1R out), hard stops, time stops that shoot overstayers. It is a *fast
day-trader*, not HFT: 10s engine ticks over REST cannot do seconds-level scalping, and the
spec refuses to pretend otherwise.

## Adversarial pre-review (why it might fail)

1. **Fee wall.** 5bp taker each way = $0.30–0.60 per round trip on $300–600 notionals.
   Targets below $5 are fee-donated (30–60% tax). Floor: $5 minimum target, enforced by sizing.
2. **No queue edge.** Real scalping lives on spread/queue position; a 10s REST bot has neither.
   Edge must come from short-horizon momentum selection, which is the weakest-documented edge
   in the building. Prior: skeptical.
3. **Overtrading.** High trade caps + boredom = churn. Cooldowns and the fee budget are load-bearing,
   not decoration.
4. **JEV latency.** A 1–3s reasoning call per scalp is a lifetime at this timescale. JEV stays out
   (rule-driven entries, status shows the rule). This is a deliberate, logged exception to
   "JEV chooses" — speed outranks deliberation here, and the measurement will confirm or kill it.

## Rules (starting guesses — every number below is guilty until measured)

- **Universe:** the whole gated list (owner call 2026-09-28 — was BTC/ETH/SOL). The 5bp spread gate plus the volume confirm exclude thin coins empirically; no allowlist to maintain.
- **Entry (micro-breakout):** 15-minute Donchian break (highest high / lowest low, longs only —
  venue reality + shorting microstructure unproven) with spread gate ≤ 5bp and 15m volume ≥
  1.2× its 24h median. One setup, no discretion, no forcing (`neverForce: true`).
- **Size:** risk 0.5% of book equity per scalp, stop-distance sized (same risk-normalized
  machinery as Blaze: `size = riskUsd / stopDistancePct`). Small by construction.
- **Stop:** 0.75× ATR(15m) from entry, hard, set at fill. No widening, ever.
- **Exits (ladder, reuses takeProfit machinery):** trim 50% at +0.4R, close the rest at +0.8R — a full run banks 0.6R ($3 on $5 risk). Owner call 2026-09-28: bank the certain $3 rather than watch +$2 retrace to scratch (trade #1 did exactly that).
- **Wick tag (2026-09-28, from the skills review):** entries are labeled `SCALP_<coin>` fresh vs `SCALP_<coin>_XHT` exhausted-thrust (forming bar spiked ≥30bp and retraced >50%). Attribution only — the code takes either one; the review splits them with numbers.
  BE-move at +0.3R with fee buffer.
- **Time stop:** 45 minutes. A scalp still open at 45 minutes is a failed scalp: market-close it,
  log `time_stop`, no exceptions. (Grim rides to midnight; Scalpy gets an hour.)
- **Cadence guards:** 80 trades/day, $20/day fee budget (owner call 2026-09-28: 10x'd for data-gathering — count/budget caps censor the sample, so the gate is the 8% daily-loss stop + 40% retire line, i.e. percentage lost, not trades taken). 15-minute cooldown between fills stays as the anti-churn brake. Flat is fine. Churn is the enemy, not idleness. (Cooldown 15 → 5, owner call 2026-09-28: with loss-based gates guarding the book, 15 was decoration; 5 keeps spacing against whipsaw chains.)
- **JEV:** never asked (see pre-review #4). Menus stay empty; status lines cite the rule.
  Revisit only if rule-driven expectancy is positive AND JEV-gated entries beat it in ghost.

## Measurement (same lens as every bee)

- Per-trade: R-multiple, fee paid, fee/R ratio, hold minutes, setup tag (`micro-long` only at first).
- Review weekly: expectancy net of fees, win rate, avg winner/loser R, fee drag as % of gross.
- **Decision gate at 30 resolved scalps:** expectancy > 0 net of fees → keep, consider sizing up
  toward 1% risk. Expectancy ≤ 0 → kill the style, journal the postmortem. No extensions, no excuses.

## Implementation checklist (when the gate says build)

1. `src/settings.ts`: STYLES += "scalpy", STYLE_INFO entry (name crawling: needs a wolf name +
   portrait; until painted, placeholder mark via BEE_MARK_URL).
2. `src/config.ts`: BEES += "bee4", DEFAULT_SLOTS, perSlot("BEE4") (OKX + Alpaca keys),
   perStyle("SCALPY", { trades: 80, fee: 20.0, spread: 5, cooldown: 5, stopAtr: 0.75, maxFlat: 0 }).
3. `src/bees/scalpy.ts`: brain (micro-breakout universe/menu, sizing, stops, takeProfit ladder,
   45m time stop, neverForce, no JEV menu — empty menu + idleStatus/idleDetail with watched price).
4. `src/bees/index.ts`: BRAINS += scalpy. Engine is BEES-generic (decide/risk/reconcile/ledger
   all loop slots) — no engine changes expected; verify ghost/scout loops too.
5. Dashboard: BEE_NAMES/BEE_META += bee4, 4th column CSS, board/sort generic-check, Hive report
   bee loop, portrait placeholder.
6. Risk: no new gates (existing caps/stops/vetoes cover it); venue gates apply automatically in paper.
7. Tests: brain unit (entry/TP/ladder/time-stop/cooldowns), sizing floor ($5 target ⇒ min notional
   check), 30-scalp gate is a human review, not code.
8. Docs: PROFIT_MODE.md entry + this file flips to Status: LIVE.

## Explicit non-goals (refused in this spec)

- Multiple concurrent positions (architecture surgery before evidence — refused; revisit only if
  single-position expectancy is positive AND one slot demonstrably bottlenecks it).
- Sub-$5 targets, short scalps, JEV-in-the-loop entries, forcing entries while flat.

## Verdict (postmortem, 2026-09-29 — killed before the 30-gate, and rightly)

78 close fills: Dash +$7.30 realised / $8.34 fees (45 fills), Zip -$18.01 / $6.58
(33 fills). Combined -$10.71 realised, $14.92 tolls, on $666 of book. Dash banked
$7.30 for $8.34 paid; Zip deeply negative. The gate existed for close calls —
this wasn't one.

Cause (structural, not variance): 0.6R targets ($3) against 1R stops ($5) need
~65% win rates before tolls; each round trip costs ~0.13R and each ladder rung
adds another full-fee leg (a +$0.05 trim paid $0.16 — verified in-ledger). No
size, floor, cooldown, or target tweak changes bp-denominated tolls; widening
targets lowers hit rates faster than it raises payouts. Fee-multiple gates on
exits were considered and declined: exit tolls are unavoidable, so skipping
cheap banks loses more (a full-size BE exit pays double the skipped trim's fee)
while keeping losers exposed.

Lessons carried forward (doctrine, not tweaks):
1. Entry targets must clear ≥3x the round-trip toll — written into PROFIT_MODE
   as the fee-multiple rule for all future styles (the duel already lives it).
2. Ladders multiply tolls: every rung is a full-fee leg. Future ladders budget
   legs like risk.
3. Rank-splitting works (no mirrors after rotation) but cannot fix negative expectancy.
4. Resetting books never remedies R-math; the gate judges scale-free R so paint colors don't matter.
