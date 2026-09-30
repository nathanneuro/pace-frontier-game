# Pace · hidden frontier

A replication of Paradigm's [Pace](https://www.paradigm.xyz/research/pace/) — a game about AI race
dynamics — with one change: the exact safety frontier is hidden. Players see a **danger zone** that
contains it, but not where inside.

Single player vs. the computer. Static HTML + ES modules, no build step.

## Run

```sh
uv run python -m http.server 8765 -d src/web
# open http://localhost:8765/
```

URL parameters: `?w=3` danger-zone half-width (`w=0` = original game), `?seed=123` fixed seed.

Controls: hold Space (or click-and-hold the button) to accelerate.

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
