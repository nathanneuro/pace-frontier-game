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

## Advanced dynamics (simple mode, the default, and `?mode=advanced`)

Simple mode runs the advanced dynamics below with one pedal instead of three sliders: internal and
external deployment are fixed at 100%, and holding the pedal moves the funding split `r` from 0
(all safety) to 1 at 1/s (`ADVANCED.pedalSeconds`); releasing moves it back at the same rate. The
faithful replica of the original game is `?mode=original`.

Motivation: the paper assumes capability only rises (`a ∈ [0, 1]`). In reality a lab can stop
running a model at any time, internally or externally. OpenAI did exactly this with its Internal
Model 1 after the 2026 Hugging Face breach. Advanced mode drops that assumption and makes several
other things endogenous.

**Controls** (no accelerator; the button only starts the game):

1. *Research*: capability share `r` of research funding. Latent research speed approaches
   `r · top`. Top speed = human researchers (1.5) + AI researchers `1.5 · exp((I − 24)/8)` (`TAKEOFF`
   in `sim.js`), where `I` is current internally deployed capability. The AI share of research is
   therefore logistic in `I`: ~5% at the start, 50% at human level (`I = 24`), >95% above `I ≈ 48`.
   Beyond that, speed grows exponentially in capability, i.e. hyperbolically in time: a finite-time
   takeoff. The ×20,000 cap on research speed exists only to keep the numbers finite.
   **Research lag:** research *power* is current, so rolling back internal deployment cuts it
   immediately. Research *output* lands after `3 months / multiplier` for capability (into latent,
   then the 2-week deployment lag). Safety output lands after `1.15 · 3 months / multiplier^0.75`
   (`TAKEOFF.safetyLagRatio`, `safetyLagExponent`): AI shortens the safety cycle less than the
   capability cycle, so the gap widens with takeoff (1.15× at the start, 3.6× at ×100, 14× at
   ×20,000). AI speeds up its own capability research cycle: 3 months at the start, under a day past ×90. Human level was set to keep
   the median time to 95% AI share at ~10.3 game months on default settings. The advanced chart uses
   a log scale (`log(1 + v)`) so takeoff doesn't flatten the early game.
   The remaining `1 − r` funds safety, which raises **your own** true frontier by
   `(1 − r) · 1.2 · m_s` per second (after the safety lag). Here `m_s = 1 + 0.75 · (multiplier − 1)`:
   AI researchers speed safety research too, but at 75% of their effect on capability research
   (`ADVANCED.safetyAiEfficiency`).
2. *Internal*: fraction of available (lagged) latent capability run inside the lab.
3. *External*: fraction of internal capability sold to customers. Profit depends on the two labs'
   external capability. External is the only tier the rival observes.

Deployment fractions change instantly in both directions: rolling back and restoring are both free.

**Frontiers**: each lab has its own true safety frontier:
`Sᵢ = background + own safety research + own real breakthroughs`. The background is the original's
drift process at 25% speed, standing in for public safety research. Neither lab ever sees the
other's frontier or estimate.

**Risk**: each lab's risk capability is
`max(internal, external + min(1, external)) + 0.25·(latent − internal)`. It is put through the
original hazard curve against *its own* frontier. Internal deployment carries full risk. External
deployment meets a catastrophe threshold 1 lower (`ADVANCED.externalThresholdGap`), phased in over
its first unit so a sliver of external deployment isn't a cliff. Without the latent weight
(`latentRiskWeight`), undeployed capability would be free and riskless. Either lab can cause
catastrophe, so the two rates add.

**Per-lab estimates**: every `Sᵢ` only increases. Uncertainty is relative, so it grows with the
frontier: lab `i` sees only its own zone, centered on `Sᵢ · exp(bᵢ)` and spanning `center · exp(±w)`
(`w = ADVANCED.zoneHalfWidth = 0.4`, i.e. −33% to +49%). Each log-offset `bᵢ` is an
Ornstein–Uhlenbeck process (reversion 0.1/s) plus lab-specific *false breakthroughs*, which raise the
estimate by a factor `1 + s`, `s ~ U(0.05, 0.2)`, without moving `S`. *Real breakthroughs* (same
size distribution and rate) raise that lab's `Sᵢ` by `s · Sᵢ`, and with it its zone by the same factor. A lab sees
its zone jump but can't tell which kind of jump it was. The parameters make `bᵢ` mean-zero with
stationary standard deviation `w/2` (`zoneSigmas`), so the truth lies outside the zone some of the time (~5%)
.

**Risk meter**: a 256-particle filter over the player's own offset. It uses the same OU + jump
model, reweights particles by survival `exp(−∫rate)`, and resamples when ESS < N/2. It
covers only the player's own lab. The rival's hazard doesn't depend on the player's offset, so it
cancels out of the posterior, but it does add to the true risk. The meter is labelled "your lab only"
for that reason.

**Bot** (both modes; `BOT` in `sim.js`): it sees only its own zone and your external deployment. It
sits at the bottom of its zone. When behind you, it chases to 1.5 past you, but never beyond 50% of
the way up its zone. In advanced mode it funds capability until its latent stopping point reaches
target + 3 and otherwise funds safety 100%. It keeps internal/latent headroom (1.5/3) above its
external deployment and lowers external so its risk-weighted capability stays at the target.
Tuned with `src/tools/eval_bot.mjs` against scripted players (100 seeds per cell). In advanced
mode with per-lab frontiers: against idle or careful players, 0% catastrophe (original bot: 7% and
34%), and it roughly ties a careful player. Against a player at their zone center it stays
competitive, and the player's own risk drives the 25% catastrophe rate. Paradigm's bot, which chases without limit, is kept
as `bot: 'original'` for the faithfulness regression.

Seeding caveat: the original's seed → catastrophe-threshold hash barely mixes small integers. Seeds
1–100 give thresholds around 9 instead of Exp(1) (mean 1), which would make `?seed=42` games nearly
unlosable. `mixSeed` spreads URL and eval seeds over 32 bits first. Live random seeds already use
the full 32 bits.

After the game: the true frontier, both labs' internal and latent lines, and markers for your
apparent breakthroughs (▲ real, ✕ false) are revealed.
