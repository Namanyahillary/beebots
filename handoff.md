# Handoff — `future/profit-mode` (beebots profit mode)

For the next agent (human or AI) picking up this branch. Read `docs/PROFIT_MODE.md`
first for philosophy + verdicts; this file is branch state + working agreements.

## Branch state
- Branch: `future/profit-mode` (base: `main` @ 1d6c28f). NOT merged, NOT deployed.
- All green at handoff: `pnpm typecheck`, `pnpm lint`, `pnpm test` (18 files, 237 tests),
  dashboard `vite build`.
- Independent review (Gemini, prompt in session log) returned APPROVE-WITH-FIXES;
  all 7 findings fixed + regression tested (see PROFIT_MODE.md review section).
- New files: `src/scout.ts`, `dashboard/src/Scout.tsx`, `test/{db,engine-cache,scout,scout-snapshot}.test.ts`,
  `docs/PROFIT_MODE.md`, this file.
- Modified: `src/{engine,risk,ledger,db,config}.ts`, `src/bees/{types,breezy,boozy,bizzy,custom}.ts`,
  `dashboard/src/{App,types}.tsx`, `test/{ledger,risk}.test.ts`.
- Conventions respected: `risk.ts` stays pure (no I/O/clock); ghost/scout paths write only
  to their own tables; no orders/fills/decisions writes from shadow code; dashboard
  additions ride the existing snapshot poll.

## Agent roles used (keep this split)
- RED-TEAM: adversarial review before build (verdicts in PROFIT_MODE.md + session log).
- BUILDER-CORE: types/ledger/db/risk. BUILDER-ENGINE: engine wiring/monitors.
  BUILDER-BRAINS: per-brain params + scout. BUILDER-VISIBILITY: scout snapshots + panel.
- Rule going forward: red-team any behavior change before implementing it; measurement
  (log-only) is always shippable, enforcement needs evidence.

## What's next (in order, don't bundle)
1. Paper-observe ≥ 7 days; collect the six metrics in PROFIT_MODE.md.
2. neverForce A/B on breezy/boozy (needs prompt rewrite + idleStatus if flipped).
3. Scout-gating decision (needs lift evidence from snapshots).
4. P5 veto vs shared-key topology decision (alert rate decides).
5. Margin feed for real liq guard (only if proxy shows it would bind).
6. Offline postmortem synthesis (only place a second LLM is welcome).

## Hard prohibitions (standing)
- No live deploy from this branch without owner sign-off.
- No runtime LLM in the tick path, ever ("JEV chooses, code decides").
- No news ingestion without a timestamped-wire + long-horizon strategy case.
- No new architecture in these docs — implementation detail lives here.
- No exchange credentials in git; no secrets in logs (see `src/redact.ts`).
