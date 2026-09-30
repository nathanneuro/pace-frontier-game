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

URL parameters: `?w=3` danger-zone half-width (`w=0` = original game), `?seed=123` fixed seed,
`?mode=advanced` advanced mode.

Each game waits for Start (click or Space).

- **Classic**: hold Space (or click and hold) to accelerate.
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

## Layout

- `src/web/sim.js` — pure simulation (no DOM): mechanics, hidden bias, Bayesian expected-risk meter, bot.
- `src/web/main.js` — canvas rendering, input, game loop.
- `docs/original_mechanics.md` — reverse-engineered original mechanics and the design of the change.

## License

MIT (see `LICENSE`). This is an independent reimplementation; the original game design is by
[Paradigm](https://www.paradigm.xyz/research/pace/), and this project is not affiliated with them.
