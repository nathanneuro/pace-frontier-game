# Pace: original mechanics and the hidden-frontier change

Source: Paradigm's Pace (https://www.paradigm.xyz/research/pace/), reverse-engineered from the
production JS bundle on 2026-09-30. Inspired by Fudenberg & Koh, *Racing to Ruin*
(arXiv:2607.27638) and *Cooperating against Catastrophe* (arXiv:2609.28291).
The downloaded bundle lives in `docs/reference/` (gitignored — it is Paradigm's code, not ours).
`src/web/sim.js` is a clean reimplementation; with `halfWidth=0` it reproduces the original
simulation bit-for-bit (verified on 15 seed × policy runs; regression pinned in `tests/sim.test.mjs`).

## Original game

- 90 s of play = ~21 months (1 s = 7 days), then up to 2 s of settling while queued deployments land.
- Two labs. Each tick a lab either accelerates (held) at `0.62·top` or decelerates at `0.62·top`.
  `top` speed rises with research position (1.5 → 3.24; a recursive-self-improvement term kicks in past 24).
- Research is **deployed 2 s (two weeks) later**. Profit and hazard use deployed capability.
- **Safety frontier** `S(t)`: starts at 12, flat until t=18, then drifts upward at a randomly
  re-targeted speed (0.26–1.58, retargeted every 2–6 s, 1 s response), modulated by rise/plateau cycles.
- **Hazard rate** (shared): with `c` = max deployed capability and `gap = max(0, c − S)`,
  `rate = 0.24 / (1 + (12/c)²) / (1 + 75/gap²)`. So it is zero at or below the frontier and grows
  smoothly (quadratically for small gaps) above it.
- **Catastrophe**: a threshold `τ ~ Exp(1)` is drawn at start; catastrophe when cumulative hazard ≥ τ,
  i.e. `P(survive) = exp(−∫rate dt)`. Both labs' cash → 0.
- **Profit** per year for a lab at capability `x` vs rival `y`: `5e9 + 1e10·log1p(0.025x)`, plus
  a log lead bonus if ahead; if behind, discounted and squeezed toward −8e9 (more so later in the race).
  Cash integrates profit and is floored at 0.
- UI shows the frontier line exactly and a live **risk/month** meter computed from the exact gap.
- Practice bot: accelerate while `position + stoppingDistance < target` (0.3 hysteresis when coasting),
  `target = max(S, rival deployed + 1.5 if behind)`.
- Online mode (not reproduced here): WebSocket server, X sign-in, leaderboard, optional
  "share research" that reveals your undeployed research line to the rival.

## Change: hidden frontier

Players see a **danger zone** `[E(t) − w, E(t) + w]` where `E(t) = S(t) + b` and the hidden bias
`b ~ Uniform(−w, w)` is drawn once per game (default `w = 3`, set with `?w=`). The true frontier is
therefore always inside the zone, and conditional on the zone it is uniformly distributed within it.
Zone shading deepens linearly toward the top edge, matching `P(S < y)`.

Things that would otherwise leak `S`, and how they're handled:

- **Risk meter**: replaced by *expected* monthly risk given the player's information. We track, for
  a grid of 41 bias hypotheses `b_k`, the cumulative hazard `H_k` that would have accrued if `b = b_k`.
  Surviving so far has likelihood `exp(−H_k)`, so the posterior is `∝ exp(−H_k)` (uniform prior), and
  the meter shows `Σ_k post_k · (1 − exp(−rate_k · 1 month))`. This is exactly what a Bayesian player
  could compute; it doesn't depend on `b`. With `w = 0` it equals the original meter.
- **"Within/above safety" label**: replaced by below / in / above danger zone.
- **Chart y-range**: computed from the zone, not `S`.
- **Bot**: aims at `E − w/2` (a quarter of the way up the zone; `UNCERTAINTY.botBandPosition`) using
  the same public information as the player.

After the game the true frontier is drawn (dashed) and `b` is reported.

Design choices worth revisiting:

- `b` is constant per game, so the zone has the same *shape* as the frontier; only the level is unknown.
  Since the only in-game signal about `b` is survival, a drifting `b` would add little. A shape-noisy
  zone, or uncertainty that grows with distance/time, would be different games.
- The bot's zone position is a free parameter that strongly affects how risky the race is.
- In multiplayer the server must withhold `S` and `b` from clients (the original already filters
  snapshots server-side). In this client-only build a player could read them from devtools.

## Advanced mode (`?mode=advanced`)

Motivation: the paper assumes capability only rises (`a ∈ [0, 1]`). In reality a lab can stop
running a model at any time, internally or externally. OpenAI did exactly this with its Internal
Model 1 after the 2026 Hugging Face breach. Advanced mode drops that assumption and makes several
other things endogenous.

**Controls** (no accelerator; the button only starts the game):

1. *Research*: capability share `r` of research funding. Latent research speed approaches
   `r · top`, where top speed rises with **internally deployed** capability (sub-takeoff RSI; same
   bounded curve as the original, which used research position). The remaining `1 − r` funds
   safety, which raises the **shared** true frontier by `(1 − r) · 0.5` per second, so safety is a
   public good.
2. *Internal*: fraction of available (lagged) latent capability run inside the lab.
3. *External*: fraction of internal capability sold to customers. Profit depends on the two labs'
   external capability. External is the only tier the rival observes.

Deployment fractions change instantly in both directions: rolling back and restoring are both free.

**Risk**: `external + 0.6·(internal − external) + 0.25·(latent − internal)`, taking the max over labs,
then the original hazard curve. The weights are `ADVANCED.internalRiskWeight` and `latentRiskWeight`.
Without them, undeployed capability would be free and riskless, and the sliders would never
involve a tradeoff.

**Per-lab estimates**: the true frontier `S` is shared and never decreases. It rises through
drift, safety funding, and real breakthroughs. Lab `i` sees only its own zone
`S + bᵢ ± w`. Each offset `bᵢ` is an Ornstein–Uhlenbeck process (reversion 0.1/s) plus
lab-specific *false breakthroughs*, which kick `bᵢ` up by U(1, 3) without moving `S`. *Real
breakthroughs* (same size distribution and rate) raise `S`, and with it every lab's zone. A lab sees
its zone jump but can't tell which kind of jump it was. The parameters make `bᵢ` mean-zero with
stationary standard deviation `w/1.5`, so the truth lies outside the zone some of the time
(~10–20% in tests).

**Risk meter**: a 256-particle filter over the player's own offset. It uses the same OU + jump
model, reweights particles by survival `exp(−∫rate)`, and resamples when ESS < N/2. It
computes risk from the player's own tiers plus the rival's *external* deployment only, so it is
labelled a lower bound.

**Bot** (both modes; `BOT` in `sim.js`): it sees only its own zone and your external deployment. It
sits 10% of the way up its zone. When behind you, it chases to 1.5 past you, but never beyond 60% of
the way up its zone. In advanced mode it funds capability until its latent stopping point reaches
target + 3 and otherwise funds safety 100%. It keeps internal/latent headroom (1.5/3) above its
external deployment and lowers external so its risk-weighted capability stays at the target.
Tuned with `src/tools/eval_bot.mjs` against scripted players (100 seeds per cell;
`outputs/run_20260930_231644_bot_tuning/`). Against idle or careful players it adds ~0–1% catastrophe
risk, versus 5–9% for the original bot in advanced mode. Against a careful player it roughly ties.
The player's own choices set the catastrophe rate. Paradigm's bot, which chases without limit, is kept
as `bot: 'original'` for the faithfulness regression.

Seeding caveat: the original's seed → catastrophe-threshold hash barely mixes small integers. Seeds
1–100 give thresholds around 9 instead of Exp(1) (mean 1), so `?seed=42` games are nearly
unlosable. Live games use random 32-bit seeds and are unaffected. The eval spreads its seeds
over 32 bits.

After the game: the true frontier, both labs' internal and latent lines, and markers for your
apparent breakthroughs (▲ real, ✕ false) are revealed.
