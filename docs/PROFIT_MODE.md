# Profit Mode — `future/profit-mode`

Philosophy: gain and exit with no emotion. Trail gains, take profits mechanically,
scout new opportunities continuously. Entertainment behaviors (forced entries, riding
winners into losers) are instrumented, gated, or removed — never silent.

Status: built on branch `future/profit-mode`, all green (typecheck + lint + 234 tests).
NOT deployed. Merge + deploy is the owner's call after paper observation.

## What changed and why

### 1. JEV waste gate (reuse-last-answer)
Was: ~40k JEV calls/day → ~8 orders. Now: `risk.ts` runs every tick (stops, caps,
vetoes all still fire in code); only the JEV *API call* is skipped when menu + material
state are unchanged, reusing the last answer while fresh. Heartbeat forces a real call
(≥ every 12 ticks) so outage detection keeps working. Per-bee counters: calls made /
skipped / est. $ saved, visible in snapshot. Invalidates on: menu change, score change,
top-score flip, position open/close/fill, cap change, data-staleness change. (uplR and
quote/funding-value moves deliberately do NOT invalidate — see tuning note below.)
Failures never populate the cache. See `src/engine.ts`.

**Live tuning (found from running state, not theory):** the first predicate hashed
continuous marks (`uplR`, funding/spread values) and the skip rate measured **~1%** —
the gate was nearly dead. Root cause: mark-to-market moves every tick. Fix: hash only
discrete decision-relevant state (integer scores, position, cap); every uplR-driven
action already runs on live values in code (stops, TP/BE, vetoes fail safe into hold).
Re-measured live: **~85% skip rate**, spend negligible, orders still flowing. Lesson:
hash what changes *decisions*, never what changes *marks*.

### 2. Take-profit ladder + breakeven stops (per-brain opt-in, never universal)
Pure `takeProfitSignal()` in `risk.ts`, wired post-risk in the engine through existing
order paths (trim folds into `trim` with `forcedBy: take_profit`). One-shot flags
(`trimmedAtR`, `beMoved`) persisted across reconcile. Rules:
- breezy (trend, rides winners): trim half at +2R, breakeven (+0.1R buffer) at +1R.
- boozy (pyramids into winners): breakeven-move ONLY — a trim would fight the pyramid.
- bizzy (one-shot grind): breakeven-move ONLY — a trim would cut the ride short.
- BE fires only after trim fills where both configured; stop moves ratchet, never loosen.
- Benched path: BE-move only, no trims.

### 3. Ledger fix (prerequisite, not optional)
`riskUsd` now scales UP on adds (was only scaled down on reduces), so `uplR` stays
correct through pyramids. Without this, every R-based trigger misfired after an add.
Test: open→add→trim sequence asserts uplR == 1R.

### 4. Ghost benchmark (caged)
Deterministic shadow chooser (best strict-setup score when flat, else hold), post-risk,
read-only, sampled every 6th tick into separate `ghost_decisions` table. No orders,
fills, decisions writes, no bus events. Pre-registered metric: fee-adjusted equity
delta vs the real bee, computed offline — the number that answers "does JEV earn it".

### 5. Scout screen + opportunity visibility (log-only)
Pure `screenUniverse()` (spread, volume, funding-data, trend-data screens). Snapshots
persisted on eligible-set change only; dashboard "Scout" rail panel shows eligible +
excluded-with-reasons + snapshot age (staleness is the point — a 30m-old opportunity
may be gone). NOT wired into any `universe()` — gating awaits measured lift.

### 6. Aggregate + liquidation monitors (alert-only, zero trading effect)
Cross-bee same-instrument notional sum vs per-bee cap → warn + rate-limited alert.
Notional/equity ratio logged per position (liq proxy). Real guards await: (a) shared-key
deployment decision, (b) OKX margin feed.

### 7. Deliberately NOT changed (measure-first)
- `neverForce` flip on breezy/boozy: would change strategy identity; needs dry-run A/B.
  `forcedBy` attribution already records forced fills for the comparison.
- Scout gating universes; P5 enforcing veto; liq veto. All logged, none enforced.

## Metrics to watch on paper (in order)
1. JEV calls skipped vs made + est. $ saved per bee (snapshot).
2. TP/BE fill counts + round-trip rate (are winners still round-tripping?).
3. Ghost delta vs real bee per strategy.
4. Forced-entry PnL vs chosen-entry PnL (decides the neverForce flip).
5. Aggregate-monitor alert rate (decides whether P5 veto is needed).
6. Liq-proxy distribution (decides whether margin feed is worth plumbing).

## Considered and rejected (adversarial review)
- **Search API key: declined.** P1–P7 are deterministic plumbing; search adds nothing
  except one future lookup (OKX margin-field names) doable ad hoc. No standing key needed.
- **Extra runtime LLM (OpenRouter): declined for the hot path.** Violates "JEV chooses,
  code decides", doubles outage surface, reintroduces the cost P1 kills. Offline use
  (drafting code, postmortem synthesis) is fine but not needed for this batch.
- **News ingestion: declined.** Staleness risk, per-tick cost ramp, token waste; beebots
  trades intraday momentum/trend where news edge is weakest. Narrow exception: a future
  long-horizon/event-driven bot would need timestamped newswire (not search API), built
  as its own validated strategy — not bolted onto these bees.
- **Scout-as-4th-bot: rejected** (breaks the 3-bee invariant across engine/creds/ledger).
  Pure function instead. **P5 veto: rejected** (net-mode + per-bee books don't mix
  without a reconcile redesign); alert-only stands.

## Stinger setup (copied rules, encoded as machinery — not pasted as words)
Hive leader "Skywing Stinger" (+3.97% on 1 trade — statistically meaningless, copy the
structure not the ranking): prev-day-high breakout + rising volume, long-only, quick
cut, trail till fade. Implemented as a deterministic *challenger* trigger in bizzy
(`stingerSetup`, `STINGER_MIN_VOL_Z = 1.0` starting guess): strict long only when
`mid > prevHigh` (new field from existing 1h candles) AND `volZ >= 1.0`. Separate
`STINGER_<COIN>` menu labels vs `BREAKOUT_<COIN>` so fills attribute Williams vs
Stinger triggers against each other. Williams trigger untouched (control). AVAX
deliberately NOT added (universe/feed change — needs readiness review first).
## Rollout suggestion
Paper-observe ≥ 7 days: metrics 1–6 above. Promote per item on evidence, never as a
bundle. TP/BE numbers are per-brain constants — retune from fills, not theory.

## Second-eyes review (Gemini, incorporated)
An independent review returned APPROVE-WITH-FIXES and caught one genuine BLOCKER plus
six smaller items — all fixed on this branch before merge:
- **BLOCKER (fixed): JEV-discretionary trims repeated on cached ticks.** `posKey` omitted
  contracts and the cache survived fills, so a TRIM_HALF answer replayed every 10s until
  the position drained. Fix: contracts in `posKey` + cache deleted on any executed
  action (next tick always asks afresh after a fill). Regression test: full `decide()`
  ticks with an always-trim fake — tick 2 must be a fresh call.
- Min-size TP trim looping as a no-op → marked spent instead of emitted.
- Outage-probe calls now counted in `jevMade` (dashboard numbers reconcile).
- `JEV_HEARTBEAT_TICKS` documented in `.env.example`; dashboard types completed;
  unused `mid` param removed from `takeProfitSignal`.
- Residual note (not fixed, by design): a *fresh* JEV re-pick of TRIM_HALF on consecutive
  ticks is JEV's judgment on fresh state — same as pre-branch behavior, not a cache bug.
  If fills show trim-churn, consider a one-shot decay-trim or trim cooldown next.

## UI fixes (visibility batch)
- Fills card showed "none yet" with fills in the DB: the /history 400-event window
  was 100% decisions. `recentEvents` now returns last-N decisions + last-50
  non-decision events merged by id. No new endpoint.
- "Trades today" relabeled "Entries today" (counter increments on entries opened,
  not closed round-trips) with hover tooltip.

## Interim reasoning backend
OpenRouter serves the real Jev 1.13 via the Decisions API (`POST
https://openrouter.ai/api/alpha/decisions` — verified live, ~3.2s, $0.042/MTok
input, output free, same as TypeSafe direct). `src/openrouter.ts`
(`OpenRouterSystemOne implements SystemOne`) passes state/questions/model
through verbatim and maps the native typed answers straight into
ChoiceResponse/ScoreResponse — no JSON parsing of model text, no probability
renormalization beyond a ±0.05 sanity tolerance. The earlier gpt-4o-mini
imitation never made a live call and is deleted.
Swap-back plan: set `TYPESAFE_API_KEY` + `REASONING_BACKEND=jev` (the default)
whenever the waitlist clears. The `Jev` class is reused untouched — daily cap,
exponential backoff, fail-closed, and `OFF_MENU` rejection all behave exactly
as with direct JEV. Per-decision `r.model` records the responding model
(e.g. `typesafe/jev-1.13-20260917`) so fills attribute to the right backend.
Conviction is now JEV-calibrated, so conviction-gate validation can proceed on
real semantics. Cost note: cap mechanics reused unchanged
(`OPENROUTER_USD_PER_MTOK`, default 0.042).

## Risk-normalized boozy entries (shipped)
Ledger showed a $24 risk (7.4% equity) on a $325 account vs 8% daily stop: fixed-fraction
sizing × wide ATR trails = random risk per trade. Entries now size as
notional = 1.5% × equity / stop-distance, clamped to max, falling back to the fixed
fraction when no stop is computable. Pyramid adds keep their fixed fraction (follow-up:
cap total pyramid risk the same way; mitigated meanwhile because adds happen into
winners, usually behind a breakeven stop). Fee drag on tiny notionals is the watch
item, measured not gated. TP/BE triggers gain meaning automatically: riskUsd now
approximates the budget by construction.

## Profit-lock trail + Blaze frequency (shipped)
Profit-lock: once peak unrealised passes $2 (activation floor against noise exits),
the stop keeps 90% of peak (boozy only; BE/ATR-trail reconciled by max). A +$5 run
that fades exits near +$4.50, never round-trips to breakeven. peakUplUsd persists
like the other one-shot flags. Pyramid adds uncovered (follow-up).
Frequency: boozy 3 → 6 trades/day via local .env (fee $3 budget unchanged — covers
~10+ risk-sized trades; binding constraint now measured, not assumed).

## Percentage-based profit-lock activation (corrected)
Fixed-dollar activation ($2) was wrong: it over-triggers on small trades and
under-triggers on large ones. Activation is now 2% of entry notional ($55 trade
activates near $1.10, $330 near $6.60). Giveback stays 10% of peak. Breakeven
(first priority — BE-move at +1R on boozy) is unchanged and fires before any lock.

## Upstream adoptions (2026-09-27, adversarially reviewed)

Five commits since fork `1d6c28f` assessed against this branch. Adopted: reject-pause
(10min after any failed open, closes exempt — same spam hole existed here, now venue-neutral
for Alpaca too), switchTarget gating (streak>=2, no first-print rotations), R exactness
(sizedRiskUsd + initialStopPx anchor; note: our proportional scaling was already close —
this buys exactness, not a rescue), MARGIN_HEADROOM 0.97 (3% haircut, ghost-consistent),
protectAdds (stop >= avg entry after adds), parseCliError messages, at_stop_usd into JEV
state, Setup styleNote. Left out deliberately: upstream profit-lock rungs (rival to our
90%-trail — ghost-duel it, don't stack), requiredAnswer generalization (our lockedHold +
skip accounting stays until a manual port preserves the metrics), "X Bee" titles
 (declined by owner 2026-09-27 — Grim/Silver/Blaze stay as they are).

## Scalpy, 4th bee (shipped 2026-09-28 — gate open, judgement at 30 scalps)

bee4 "Dash" runs `scalpy`, the fast day-trader from `strategies/SCALPER.md` (now
LIVE): 15m Donchian micro-breakout (20-bar high, longs only, BTC/ETH/SOL), 1.2x
median-volume confirm, 30bp chase guard, 0.75x ATR(15m) hard stop, trim half at
+0.5R / close the rest at +1R (ladder rung frac 1.0), BE at +0.3R, 45m time stop,
8 trades/day, $2 fee budget, 15m cooldown. Entries are RULE-DRIVEN — Jev is never
asked (new `ruleDriven` brain flag: engine takes the single setup as-is, all code
gates still fire). Sizing is risk-normalized at 0.5% of equity with a $5 floor so
the +1R target clears the fee wall (on a $333 book that means ~1.5% risk — the
30-scalp review re-judges it). Setup still raises 3 wolves; bee4 is always built-in
(portrait placeholder until Dash is painted; "Dash" reserved). Decision gate at 30
resolved scalps: expectancy > 0 net of fees keeps it, else kill with postmortem.
