# Pace · hidden frontier

A replication of Paradigm's [Pace](https://www.paradigm.xyz/research/pace/) — a game about AI race
dynamics — with one change: the exact safety frontier is hidden. Players see a **danger zone** that
contains it, but not where inside.

**Play:** https://nathanneuro.github.io/pace-frontier-game/

Single player vs. the computer. Static HTML + ES modules, no build step.

## Run

```sh
uv run python -m http.server 8765 -d src/web
# open http://localhost:8765/
```

URL parameters: `?mode=advanced` / `?mode=original` (default: simple), `?seed=123` fixed seed,
`?w=` danger-zone half-width (log units in simple/advanced, default 0.4 ≈ −33%/+49%; capability
units in original, default 3; `w=0` shows the exact frontier).

Each game waits for Start (click or Space).
After a game, close the results to explore the run: scroll to zoom, drag to pan, double-click to
reset. Hover to compare what you saw (your zone, expected risk) with the truth (both labs' frontiers,
zones, hidden capability, true risk per lab). A strip along the bottom shows where true risk built up.

- **Simple** (default): the advanced dynamics below with one pedal. Hold Space (or click and hold)
  to shift research funding from safety to capabilities (full range in ~1 s); release to shift it
  back at the same rate. Everything is deployed internally and externally as soon as it's ready.
- **Original** (`?mode=original`): a faithful replica of Paradigm's game (hold to accelerate), plus
  the hidden frontier.
- **Advanced**: three sliders, capability-vs-safety funding, internal deployment, and external
  deployment (Q/A, W/S, E/D). Latent, internal, and external capability are tracked separately.
  Internal deployment drives self-improvement, and deployment rolls back instantly. Each lab has its
  own noisy estimate of the frontier, and some apparent safety breakthroughs are false. See
  `docs/original_mechanics.md`.

## Test

```sh
node --test tests/*.test.mjs
```

Includes a regression that pins our sim (with `w=0`) to numbers produced by the original game's code.

Bot tuning: `node src/tools/eval_bot.mjs [seeds]` plays bot variants against scripted players and
writes a run directory under `outputs/`.

## Layout

- `src/web/sim.js` — pure simulation (no DOM): mechanics, hidden bias, Bayesian expected-risk meter, bot.
- `src/web/main.js` — canvas rendering, input, game loop.
- `docs/original_mechanics.md` — reverse-engineered original mechanics and the design of the change.

## License

MIT (see `LICENSE`). This is an independent reimplementation; the original game design is by
[Paradigm](https://www.paradigm.xyz/research/pace/), and this project is not affiliated with them.
